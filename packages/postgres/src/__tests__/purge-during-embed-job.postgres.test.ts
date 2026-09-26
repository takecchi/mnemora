import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId, MemoryId } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { sha256Hex } from "../content-hash.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

const TABLE = embeddingSpaceTableName(TEST_EMBEDDING_SPACE);

/**
 * 1回だけ使う障壁。`pass()` は `entered` を解決してから、`release()` まで待つ。
 * embed ジョブを決まった地点で止めるためのもの（sleep で順序を作らない）。
 */
class Gate {
  private enteredResolve!: () => void;
  readonly entered = new Promise<void>((resolve) => {
    this.enteredResolve = resolve;
  });
  private releaseResolve!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseResolve = resolve;
  });

  async pass(): Promise<void> {
    this.enteredResolve();
    await this.released;
  }

  release(): void {
    this.releaseResolve();
  }
}

/** `embed()` の中で障壁を通る provider（ジョブが Memory を読んだ後に止まる）。 */
class GatedEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  private readonly inner: DeterministicEmbeddingProvider;

  constructor(
    space: EmbeddingSpaceId,
    private readonly gate: Gate | null,
  ) {
    this.space = space;
    this.inner = new DeterministicEmbeddingProvider(space);
  }

  async embed(ctx: Ctx, texts: string[]): Promise<number[][]> {
    await this.gate?.pass();
    return this.inner.embed(ctx, texts);
  }
}

/** `upsert()` の入口で障壁を通る VectorStore（provider の応答の後、書く直前に止まる）。 */
class GatedUpsertVectorStore extends PostgresVectorStore {
  gate: Gate | null = null;

  override async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    await this.gate?.pass();
    return super.upsert(ctx, space, memoryId, vector);
  }
}

/**
 * Issue #1035 / ADR 0124: `purge()` は法的要求のための物理削除であり、`content`/`digest` を
 * トゥームストーンで上書きしたうえで、対応する埋め込みも消す（決定5）。
 *
 * embed ジョブ（`tick()` の `processEmbedJob`）は Memory を読んでから provider を呼び、
 * その結果を upsert する。その間に `forget()` → `purge()` が完了すると、ジョブは purge
 * **前**の内容から作ったベクトルを、purge の削除の**後**に書き込む。⟹ `purge()` が
 * `"purged"` を返したのに、消したはずの内容の埋め込みが残る。
 *
 * 止める地点を2つ持つ:
 * - provider の中（provider の応答が遅い、という現実の形）
 * - `upsert()` の入口（provider が返った後、書く直前）。purge 済みかの確かめを
 *   upsert の**前**に置く直し方では、ここで割り込まれると残る——確かめは書いた**後**で
 *   なければならないことを固定する。
 */
describe("embed ジョブの最中に purge しても、purge した記憶の埋め込みは残らない（Issue #1035、本物の Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  async function purgeWhileEmbedJobIsStopped(stopAt: "embed" | "upsert"): Promise<number> {
    const { db } = await getTestClient();
    const gate = new Gate();
    const vectorStore = new GatedUpsertVectorStore(db);
    const runtime = createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      outboxStore: new PostgresOutboxStore(db),
      vectorStore,
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider: new GatedEmbeddingProvider(
        TEST_EMBEDDING_SPACE,
        stopAt === "embed" ? gate : null,
      ),
      hashContent: sha256Hex,
    });
    const ctx: Ctx = { tenantId: `tenant-purge-during-embed-${stopAt}` };
    const observed = await runtime.observe(ctx, {
      kind: "utterance",
      text: "消してほしい個人的な内容",
      speaker: "u",
    });
    expect(observed.memoryIds).toHaveLength(1);
    const memoryId = observed.memoryIds[0]!;

    if (stopAt === "upsert") {
      vectorStore.gate = gate;
    }
    const tick = runtime.tick(ctx, { leaseMs: 60_000 });
    // ジョブが Memory を読んだ後の地点で止まっている。
    await gate.entered;

    const forgotten = await runtime.forget(ctx, { memoryId });
    expect(forgotten.outcomes[0]?.kind).toBe("forgotten");
    const purged = await runtime.purge(ctx, { memoryId });
    expect(purged.outcomes[0]?.kind).toBe("purged");

    gate.release();
    await tick;

    const rows = await db.execute(
      sql.raw(`SELECT count(*)::int AS n FROM ${TABLE} WHERE memory_id = '${memoryId}'`),
    );
    return (rows.rows[0] as { n: number }).n;
  }

  it("provider の応答を待っている間に forget → purge が完了しても、tick の後に埋め込み行は無い", async () => {
    expect(await purgeWhileEmbedJobIsStopped("embed")).toBe(0);
  });

  it("provider が返った後・upsert の直前に forget → purge が完了しても、tick の後に埋め込み行は無い", async () => {
    expect(await purgeWhileEmbedJobIsStopped("upsert")).toBe(0);
  });
});
