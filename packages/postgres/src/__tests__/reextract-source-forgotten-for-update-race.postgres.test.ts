import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
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

/**
 * `reextract` 版の Issue #1226 の陽性対照（`consolidate-reflect-source-forgotten-for-update-race.postgres.test.ts`
 * と同じ作法。ADR 0406）: runtime 自身の「書く直前の読み直し」（`getMany`）と書き込みの間に開いた窓に、
 * `forget` を割り込ませても、書き込みメソッド自身の `SELECT … FOR UPDATE`（`opts.abortIfForgotten`）が
 * 検出して打ち切ること。書き込みメソッドの入口で障壁を張る（読み直しは別メソッドなので影響を受けない）。
 *
 * `supersedeWithNewMemories`（口の有る経路）と `createMemoryWithOutbox`（口の無い adapter 向けのループ）は
 * 別のメソッドで別の見直しを持つので、両方を確かめる。
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

const ctx: Ctx = { tenantId: "reextract-source-forgotten-for-update-race" };
let contents: string[] = [];

const llmProvider: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_c, req) =>
    req.schema.parse({
      memories: contents.map((content) => ({ content, provenanceKind: "stated" as const })),
    }),
};

function makeRuntime(
  memoryStore: MemoryStore,
  db: Awaited<ReturnType<typeof getTestClient>>["db"],
) {
  return createRuntime({
    memoryStore,
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_c, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  });
}

async function runOnce(hidePort: boolean) {
  const { db } = await getTestClient();
  const gatedStore = new GatedPostgresMemoryStore(db);
  const plainStore = new PostgresMemoryStore(db);
  // 口なしの経路では、runtime に渡す store から `supersedeWithNewMemories` を隠す。
  const runtimeStore: MemoryStore = hidePort
    ? new Proxy(gatedStore, {
        get(target, prop) {
          if (prop === "supersedeWithNewMemories") return undefined;
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : gatedStore;
  const runtime = makeRuntime(runtimeStore, db);
  const plainRuntime = makeRuntime(plainStore, db);

  contents = ["猫は3匹"];
  const first = await plainRuntime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
  const x = first.memoryIds[0]!;

  contents = ["猫を3匹飼っている"];
  const gate = new Gate();
  if (hidePort) gatedStore.createGate = gate;
  else gatedStore.supersedeGate = gate;
  const pending = runtime.reextract(ctx, first.observationId);

  await gate.entered;
  expect((await plainRuntime.forget(ctx, { memoryId: x })).outcomes[0]?.kind).toBe("forgotten");
  gate.release();
  const result = await pending;

  const all = await plainStore.listBySourceObservationAllVersions(ctx, first.observationId);
  return { result, x, all };
}

afterAll(async () => {
  await closeTestClient();
});

for (const hidePort of [false, true]) {
  describe(`reextract: 読み直しと書き込みの間の窓は、${
    hidePort ? "createMemoryWithOutbox（口なし）" : "supersedeWithNewMemories"
  } の SELECT … FOR UPDATE が閉じる（陽性対照）`, () => {
    it("beforeAll: DB を用意する", async () => {
      await resetTestDatabase();
    });

    for (let i = 0; i < 3; i += 1) {
      it(`試行 ${i + 1}/3: 見直しが打ち切り、active の記憶は書かれない`, async () => {
        const { result, x, all } = await runOnce(hidePort);
        expect(result.memoryIds).toEqual([]);
        expect(result.supersededMemoryIds).toEqual([]);
        expect(result.atomicity).toBe("not_attempted");
        expect(result.extraction).toBe("skipped");
        expect(result.skipped).toEqual([
          { kind: "status_not_active", memoryId: x, status: "forgotten" },
        ]);
        expect(all.map((m) => ({ id: m.id, status: m.status }))).toEqual([
          { id: x, status: "forgotten" },
        ]);
      });
    }
  });
}
