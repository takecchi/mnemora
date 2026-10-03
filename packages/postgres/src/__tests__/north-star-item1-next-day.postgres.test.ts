import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Clock, Ctx, LLMProvider, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
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
 * 北極星「目指す姿」の項目1（言ったことを、次の日も覚えている）を名指しで縛る（Issue #387、
 * `docs/north-star-paths.md` の項目1）。振る舞いは変えていない。Postgres と testkit の fixture で同じ。
 *
 * 注入した時計で `observe` し、時計を1日より先へ進めてから `recall` しても、その記憶が返る。
 * テナント設定は既定のまま（壁時計・既定の半減期）で、`includeFullyDecayed` も渡さない。
 *
 * 陽性対照として、同じ時計を減衰の床より先へ進めると `filtered(decayed)` で落ちることも見る
 * ——注入した時計が recall の減衰ゲートまで届いていなければ、1日後に返るのは当たり前だからである。
 */

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({ memories: [{ content: "猫を3匹飼っている", provenanceKind: "stated" }] }),
};

function sharedWith(clock: Clock) {
  return {
    llmProvider: llm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
    clock,
  };
}

const KITS: Array<[string, (clock: Clock) => Promise<Runtime>]> = [
  [
    "testkit の InMemory",
    async (clock) => {
      const memoryStore = new InMemoryMemoryStore();
      return createRuntime({
        ...sharedWith(clock),
        memoryStore,
        eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
        vectorStore: new InMemoryVectorStore(memoryStore),
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
      });
    },
  ],
  [
    "Postgres",
    async (clock) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return createRuntime({
        ...sharedWith(clock),
        memoryStore: new PostgresMemoryStore(db),
        eventStore: new PostgresEventStore(db),
        vectorStore: new PostgresVectorStore(db),
        outboxStore: new PostgresOutboxStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
      });
    },
  ],
];

const ctx: Ctx = { tenantId: "north-star-item1-next-day" };
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * 手で進める時計。壁時計より少し先から始める（歴史的な理由で残している。今は outbox の
 * `available_at` も注入した時計に従うので、壁時計より過去でも embed ジョブは取れる。ADR 0559、
 * `injected-clock-reach.postgres.test.ts` の 2.）。
 */
function manualClock() {
  let t = Date.now() + 1000;
  return {
    clock: { now: () => new Date(t) } satisfies Clock,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** 観測して embed まで済ませ、時計を `elapsedMs` 進めてから同じ言葉で recall する。 */
async function observeThenRecallAfter(
  makeRuntime: (clock: Clock) => Promise<Runtime>,
  elapsedMs: number,
) {
  const { clock, advance } = manualClock();
  const runtime = await makeRuntime(clock);
  const observed = await runtime.observe(ctx, { kind: "utterance", text: "猫を3匹飼っているよ" });
  expect(observed.memoryIds).toHaveLength(1);
  await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });
  advance(elapsedMs);
  const result = await runtime.recall(ctx, { text: "飼っている猫" });
  return { memoryId: observed.memoryIds[0]!, result };
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeRuntime] of KITS) {
  describe(`${name}: 北極星の項目1（言ったことを、次の日も覚えている）`, () => {
    it("注入した時計で observe し、1日と1時間進めてから recall しても、その記憶が返る（既定のテナント設定、includeFullyDecayed なし）", async () => {
      const { memoryId, result } = await observeThenRecallAfter(makeRuntime, DAY_MS + HOUR_MS);
      expect(result.memories.map((m) => m.memoryId)).toContain(memoryId);
      expect(result.omitted).not.toContainEqual(
        expect.objectContaining({ kind: "filtered", condition: "decayed" }),
      );
    });

    it("陽性対照: 同じ時計を1年進めると、その記憶は返らず filtered(decayed) に数えられる（時計が減衰ゲートまで届いている）", async () => {
      const { memoryId, result } = await observeThenRecallAfter(makeRuntime, 365 * DAY_MS);
      expect(result.memories.map((m) => m.memoryId)).not.toContain(memoryId);
      expect(result.omitted).toContainEqual(
        expect.objectContaining({ kind: "filtered", condition: "decayed", count: 1 }),
      );
    });
  });
}
