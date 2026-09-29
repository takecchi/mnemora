import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryId, MemoryStore } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/** `forget`/`purge` しか呼ばない側の runtime に渡す——LLM は一切呼ばれないダミー。 */
const unusedLLMProvider: LLMProvider = {
  complete: async () => {
    throw new Error("unusedLLMProvider: forget/purge は LLM を呼ばない");
  },
  completeStructured: async () => {
    throw new Error("unusedLLMProvider: forget/purge は LLM を呼ばない");
  },
};

/**
 * Issue #1226 / ADR 0375 決定7（クローン miku の判断）: `PostgresMemoryStore.supersedeWithNewMemories`/
 * `createMemoryWithOutbox` の `opts.abortIfForgotten` が使う `SELECT … FOR UPDATE`
 * （`assertNotForgottenForUpdate`、`memory-store.ts`）が、**runtime 自身の「書く直前の
 * 読み直し」だけでは閉じない窓を、実際に閉じていること**を陽性対照で示す
 * （`packages/postgres/src/__tests__/purge-during-embed-job.postgres.test.ts` ＝
 * Issue #1035 と同じ形——「障壁で止めて、その間に割り込ませ、外す」）。
 *
 * 窓の位置: `runtime.consolidate`/`runtime.reflect` は (1) LLM が返った直後に eligible を
 * `getMany` で読み直し（shallow recheck）、(2) forgotten が無ければ書き込み
 * （`supersedeWithNewMemories`/`createMemoryWithOutbox`）を呼ぶ。(1) と (2) の間には、
 * 別々の DB 往復であるがゆえの小さな窓がある——この窓の中で forget/purge が完了すると、
 * (1) の読み直しでは検出できない。この歯は、**その窓の中で割り込ませても** (2) 側
 * （書き込みメソッド自身の `SELECT … FOR UPDATE`）が検出して打ち切ることを示す。
 *
 * 止める地点: 書き込みメソッド（`supersedeWithNewMemories`/`createMemoryWithOutbox`）の
 * 入口（(1) の読み直しは別メソッド `getMany` なので影響を受けない。(2) の呼び出し
 * そのものが実行される直前で止める）。
 *
 * `consolidate`（`supersedeWithNewMemories` 経由）と `reflect`（`createMemoryWithOutbox`
 * 経由）の両方を、同じ作法で確かめる——2つは別のメソッドで別の `SELECT … FOR UPDATE`
 * を持つため、片方が閉じていても他方が閉じているとは限らない。
 */

/** `GatedPostgresMemoryStore` の各書き込みメソッドの入口で1回だけ通る障壁。 */
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

/**
 * `supersedeWithNewMemories`/`createMemoryWithOutbox` の入口（runtime の shallow recheck の
 * 直後）で、それぞれ独立した障壁を通る。1つの歯（1回の `runConsolidateOnce`/
 * `runReflectOnce`）はどちらか一方の障壁しか使わない——他方は `null` のまま（素通り）。
 */
class GatedPostgresMemoryStore extends PostgresMemoryStore {
  supersedeGate: Gate | null = null;
  createGate: Gate | null = null;

  override async supersedeWithNewMemories(
    ...args: Parameters<PostgresMemoryStore["supersedeWithNewMemories"]>
  ): ReturnType<PostgresMemoryStore["supersedeWithNewMemories"]> {
    await this.supersedeGate?.pass();
    return super.supersedeWithNewMemories(...args);
  }

  override async createMemoryWithOutbox(
    ...args: Parameters<PostgresMemoryStore["createMemoryWithOutbox"]>
  ): ReturnType<PostgresMemoryStore["createMemoryWithOutbox"]> {
    await this.createGate?.pass();
    return super.createMemoryWithOutbox(...args);
  }
}

const ctx: Ctx = { tenantId: "consolidate-reflect-source-forgotten-for-update-race" };
let seq = 0;

interface RaceResult {
  outcome: string;
  writtenMemoryId: MemoryId | null;
  llmRequestContainedA: boolean;
}

async function runConsolidateOnce(): Promise<RaceResult> {
  const { db } = await getTestClient();
  const gatedStore = new GatedPostgresMemoryStore(db);
  const plainStore: MemoryStore = new PostgresMemoryStore(db);
  let lastRequest = "";
  const runtime = createRuntime({
    memoryStore: gatedStore,
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: {
      complete: async () => ({ content: "unused" }),
      completeStructured: async (_c, req) => {
        lastRequest = JSON.stringify(req);
        const parsed = req.schema.safeParse({ content: "統合", digest: "統合" });
        return parsed.success ? parsed.data : req.schema.parse({});
      },
    },
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_c, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  });
  // forget/purge を撃つ側は、書き込み障壁を持たない別の runtime（別の js オブジェクトだが
  // 同じ Postgres 接続プール——DB 側のトランザクション分離だけで十分であり、別プロセス・
  // 別接続を用意する必要は無い。`purge-during-embed-job.postgres.test.ts` と同じ作法）。
  const interruptRuntime = createRuntime({
    memoryStore: plainStore,
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: unusedLLMProvider,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_c, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  });

  seq += 1;
  const a = await plainStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `consolidate-race-a-${seq}`,
      content: "A の秘密",
      digest: "A の秘密",
    }),
  );
  const b = await plainStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `consolidate-race-b-${seq}`,
      content: "B の話",
      digest: "B の話",
    }),
  );

  const gate = new Gate();
  gatedStore.supersedeGate = gate;
  const pending = runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });

  // shallow recheck（getMany、gate されていない別メソッド）はもう終わっている
  // ——ここで forget/purge を完了させる。
  await gate.entered;
  const forgotten = await interruptRuntime.forget(ctx, { memoryId: a.id });
  expect(forgotten.outcomes[0]?.kind).toBe("forgotten");
  const purged = await interruptRuntime.purge(ctx, { memoryId: a.id });
  expect(purged.outcomes[0]?.kind).toBe("purged");

  gate.release();
  const result = await pending;

  return {
    outcome: result.outcome,
    writtenMemoryId: result.consolidatedMemoryId,
    llmRequestContainedA: lastRequest.includes("A の秘密"),
  };
}

async function runReflectOnce(): Promise<RaceResult> {
  const { db } = await getTestClient();
  const gatedStore = new GatedPostgresMemoryStore(db);
  const plainStore: MemoryStore = new PostgresMemoryStore(db);
  let lastRequest = "";
  const runtime = createRuntime({
    memoryStore: gatedStore,
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: {
      complete: async () => ({ content: "unused" }),
      completeStructured: async (_c, req) => {
        lastRequest = JSON.stringify(req);
        const parsed = req.schema.safeParse({
          outcome: "reflected",
          content: "内省",
          digest: "内省",
        });
        return parsed.success ? parsed.data : req.schema.parse({});
      },
    },
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_c, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  });
  const interruptRuntime = createRuntime({
    memoryStore: plainStore,
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: unusedLLMProvider,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_c, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  });

  seq += 1;
  const a = await plainStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `reflect-race-a-${seq}`,
      content: "A の秘密",
      digest: "A の秘密",
    }),
  );
  const b = await plainStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `reflect-race-b-${seq}`,
      content: "B の話",
      digest: "B の話",
    }),
  );

  const gate = new Gate();
  gatedStore.createGate = gate;
  const pending = runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });

  await gate.entered;
  const forgotten = await interruptRuntime.forget(ctx, { memoryId: a.id });
  expect(forgotten.outcomes[0]?.kind).toBe("forgotten");
  const purged = await interruptRuntime.purge(ctx, { memoryId: a.id });
  expect(purged.outcomes[0]?.kind).toBe("purged");

  gate.release();
  const result = await pending;

  return {
    outcome: result.outcome,
    writtenMemoryId: result.reflectedMemoryId,
    llmRequestContainedA: lastRequest.includes("A の秘密"),
  };
}

afterAll(async () => {
  await closeTestClient();
});

describe("consolidate: shallow recheck と書き込みの間の窓は、supersedeWithNewMemories の SELECT … FOR UPDATE が閉じる（Issue #1226、陽性対照）", () => {
  it("beforeAll: DB を用意する", async () => {
    await resetTestDatabase();
  });

  // 10回連続で実行し、揺れないことを示す（`purge-during-embed-job.postgres.test.ts` の
  // 「障壁で順序を固定しているので揺れない」と同じ理由——確率的な再現ではなく、決定的な
  // 順序を10回繰り返して安定性を確かめる）。
  for (let i = 0; i < 10; i += 1) {
    it(`試行 ${i + 1}/10: FOR UPDATE の見直しが打ち切る（outcome: aborted_source_forgotten）`, async () => {
      const result = await runConsolidateOnce();
      expect(result.llmRequestContainedA).toBe(true);
      expect(result.outcome).toBe("aborted_source_forgotten");
      expect(result.writtenMemoryId).toBeNull();
    });
  }
});

describe("reflect: shallow recheck と書き込みの間の窓は、createMemoryWithOutbox の SELECT … FOR UPDATE が閉じる（Issue #1226、陽性対照）", () => {
  for (let i = 0; i < 10; i += 1) {
    it(`試行 ${i + 1}/10: FOR UPDATE の見直しが打ち切る（outcome: aborted_source_forgotten）`, async () => {
      const result = await runReflectOnce();
      expect(result.llmRequestContainedA).toBe(true);
      expect(result.outcome).toBe("aborted_source_forgotten");
      expect(result.writtenMemoryId).toBeNull();
    });
  }
});
