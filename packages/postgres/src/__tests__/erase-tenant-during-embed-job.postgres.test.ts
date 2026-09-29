import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import { createRuntime, eraseTenant } from "@mnemora/core";
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
 * `purge-during-embed-job.postgres.test.ts`（Issue #1035）と同じ型の障壁。
 * embed ジョブを決まった地点で止める。
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

class GatedEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  private readonly inner: DeterministicEmbeddingProvider;

  constructor(
    space: EmbeddingSpaceId,
    private readonly gate: Gate,
  ) {
    this.space = space;
    this.inner = new DeterministicEmbeddingProvider(space);
  }

  async embed(ctx: Ctx, texts: string[]): Promise<number[][]> {
    await this.gate.pass();
    return this.inner.embed(ctx, texts);
  }
}

/**
 * Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md):
 *
 * embed ジョブ（`tick()` の `processEmbedJob`）は Memory を読んでから provider を呼び、
 * その結果を `vectorStore.upsert` する。その間に `eraseTenant` が完了すると、
 * ジョブが「もう存在しないテナント」へ向けて書こうとする形になる——
 * `vectorStore.upsert` は `memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE
 * CASCADE` を経由するため、`memories` 行が既に消えていれば `INSERT` 自体が外部キー
 * 違反（23503）で失敗する。
 *
 * ⟹ **`eraseTenant` が消し切った後、embed ジョブが後から書き込んでも、埋め込みの行は
 * 残らない**（書き込みそのものが失敗するため）。この歯はそれを実測する。
 */
describe("eraseTenant している最中に embed ジョブが走っても、消し切った後に埋め込みの行は残らない（Issue #1207、本物の Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("provider の応答を待っている間に eraseTenant が完了すると、embed ジョブの upsert は FK 違反で失敗し、埋め込みの行は残らない", async () => {
    const { db, pool } = await getTestClient();
    const gate = new Gate();
    const memoryStore = new PostgresMemoryStore(db);
    const vectorStore = new PostgresVectorStore(db);
    const outboxStore = new PostgresOutboxStore(db);
    const tenantSettingsStore = new PostgresTenantSettingsStore(db);
    const runtime = createRuntime({
      memoryStore,
      outboxStore,
      vectorStore,
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore,
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider: new GatedEmbeddingProvider(TEST_EMBEDDING_SPACE, gate),
      hashContent: sha256Hex,
    });
    const T = "erase-tenant-during-embed";
    const ctx: Ctx = { tenantId: T };
    const observed = await runtime.observe(ctx, {
      kind: "utterance",
      text: "消される予定の内容",
      speaker: "u",
    });
    expect(observed.memoryIds).toHaveLength(1);
    const memoryId = observed.memoryIds[0]!;

    const tick = runtime.tick(ctx, { leaseMs: 60_000 });
    // embed ジョブが Memory を読んだ後、provider の応答待ちで止まっている。
    await gate.entered;

    const deps = { memoryStore, vectorStore, outboxStore, tenantSettingsStore };
    let outcome = await eraseTenant(ctx, deps, { confirmTenantId: T, limit: 100_000 });
    let guard = 0;
    while (outcome.kind === "executed" && outcome.reachedLimit) {
      guard += 1;
      expect(guard).toBeLessThan(20);
      outcome = await eraseTenant(ctx, deps, { confirmTenantId: T, limit: 100_000 });
    }
    expect(outcome.kind).toBe("executed");

    // このテナントの memories はもう無い。
    expect(await memoryStore.get(ctx, memoryId)).toBeNull();

    gate.release();
    // embed ジョブの再開後の書き込みは FK 違反で失敗する——`tick()` がそれを内部で
    // 捕まえて outbox ジョブを失敗として終端にするか、例外を投げて呼び出し元まで
    // 抜けるかは実装の詳細であり、この歯はどちらでも構わない（try/catch で吸収する）。
    await tick.catch(() => {});

    const rows = await db.execute(
      sql.raw(`SELECT count(*)::int AS n FROM ${TABLE} WHERE memory_id = '${memoryId}'`),
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);

    // pool 側からも二重に確認する（`db`/`pool` が同じ接続プールを指すことの確認込み）。
    const poolRows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${TABLE} WHERE tenant_id = $1`,
      [T],
    );
    expect(poolRows.rows[0]!.n).toBe(0);
  }, 60_000);
});
