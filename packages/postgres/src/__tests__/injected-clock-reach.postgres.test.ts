import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Clock, Ctx, EventStore, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
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
 * 注入した時計（`RuntimeDeps.clock`）が届く時刻と届かない時刻の今の振る舞いを縛る（Issue #1237。
 * `Clock` の doc の 2026-09-27 追記）。振る舞いは変えていない。Postgres と testkit の fixture で同じ。
 *
 * 1. Memory の `recordedAt` は注入した時計、監査ログの `at` と recall の記録の `createdAt` は壁時計。
 * 2. outbox の `available_at` は壁時計、`tick` の claim の `now` は注入した時計。そのため、壁時計より
 *    過去の時計では `tick` がジョブを1本も取らない（何も名乗らない）。
 * 3. 復帰と掃引の口（`Clock` の doc の 2026-09-28 追記）: reinforce（`lastReinforcedAt`・`decayFloorAt`）は
 *    どの経路でも注入した時計。`sweepArchive` の選定は `opts.now` で、`archived` の `at` は壁時計。
 *    `restoreArchived` の `restored` の `at` は壁時計、`restoreSuperseded` の `unsuperseded` の `at` は注入した時計。
 */

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    // 抽出（`memories`）と統合（`content`）の両方のスキーマに答える。
    const extracted = req.schema.safeParse({
      memories: [{ content: "事実です", provenanceKind: "stated" }],
    });
    return extracted.success ? extracted.data : req.schema.parse({ content: "統合した本文" });
  },
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

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

const KITS: Array<[string, (clock: Clock) => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async (clock) => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...sharedWith(clock),
          memoryStore,
          eventStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async (clock) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...sharedWith(clock),
          memoryStore,
          eventStore,
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "injected-clock-reach" };
const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2030-01-01T00:00:00.000Z");

/** 呼ぶたびに FUTURE から1秒ずつ進む時計（固定の時計では、作成と同じ時刻の強化が書かれないため。ADR 0048）。 */
function steppingFutureClock(): Clock {
  let t = FUTURE.getTime();
  return { now: () => new Date((t += 1000)) };
}

/** 注入した時計（FUTURE から1時間以内）の時刻か。 */
function isInjected(date: Date | null | undefined): boolean {
  return (
    date instanceof Date &&
    date.getTime() > FUTURE.getTime() &&
    date.getTime() < FUTURE.getTime() + 3_600_000
  );
}

/** テストが走っている間の壁時計の時刻か（前後1秒の余裕）。 */
function isWallNow(date: Date, startedAt: number): boolean {
  return date.getTime() >= startedAt - 1000 && date.getTime() <= Date.now() + 1000;
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 注入した時計が届く時刻と届かない時刻（今の振る舞い）`, () => {
    it("Memory の recordedAt は注入した時計、監査ログの at と recall の記録の createdAt は壁時計", async () => {
      const startedAt = Date.now();
      const kit = await makeKit({ now: () => new Date(FUTURE) });
      const observed = await kit.runtime.observe(ctx, { kind: "utterance", text: "事実を1つ" });
      const memoryId = observed.memoryIds[0]!;
      expect((await kit.memoryStore.get(ctx, memoryId))?.recordedAt).toEqual(FUTURE);

      const [created] = await kit.eventStore.list(ctx, { memoryId, kind: "created" });
      expect(isWallNow(created!.at, startedAt)).toBe(true);

      const recalled = await kit.runtime.recall(ctx, { text: "事実", limit: 3, association: null });
      const record = await kit.runtime.getRecall(ctx, recalled.recallId);
      expect(isWallNow(record!.createdAt, startedAt)).toBe(true);
    });

    it("復帰と掃引: reinforce は注入した時計、sweepArchive は opts.now で選び archived の at は壁時計、restored の at は壁時計、unsuperseded の at は注入した時計", async () => {
      const startedAt = Date.now();
      const kit = await makeKit(steppingFutureClock());
      const a = (await kit.runtime.observe(ctx, { kind: "utterance", text: "事実を1つ" }))
        .memoryIds[0]!;
      const b = (await kit.runtime.observe(ctx, { kind: "utterance", text: "事実をもう1つ" }))
        .memoryIds[0]!;
      const createdA = (await kit.memoryStore.get(ctx, a))!;
      expect(isInjected(createdA.recordedAt)).toBe(true);
      const floorA = createdA.decayFloorAt!;

      // 使用報告の強化: 注入した時計。
      const recalled = await kit.runtime.recall(ctx, { text: "事実", limit: 3, association: null });
      await kit.runtime.observe(ctx, {
        kind: "memory_usage",
        recallId: recalled.recallId,
        usedMemoryIds: [b],
      });
      expect(isInjected((await kit.memoryStore.get(ctx, b))!.lastReinforcedAt)).toBe(true);

      // sweepArchive: 選ぶ基準は opts.now。注入した時計はまだ floorA の手前だが、opts.now で a を選ぶ。
      const swept = await kit.runtime.sweepArchive(ctx, {
        now: new Date(floorA.getTime() + 1000),
        limit: 10,
      });
      expect(swept.archived.map((x) => x.memoryId)).toContain(a);
      const [archived] = await kit.eventStore.list(ctx, { memoryId: a, kind: "archived" });
      expect(isWallNow(archived!.at, startedAt)).toBe(true);

      // restoreArchived: reinforce は注入した時計、restored の at は壁時計。
      const restoredArchived = await kit.runtime.restoreArchived(ctx, { memoryId: a });
      expect(restoredArchived.outcomes.map((o) => o.kind)).toEqual(["restored"]);
      const afterRestore = (await kit.memoryStore.get(ctx, a))!;
      expect(isInjected(afterRestore.lastReinforcedAt)).toBe(true);
      expect(afterRestore.decayFloorAt!.getTime()).toBeGreaterThan(floorA.getTime());
      const [restored] = await kit.eventStore.list(ctx, { memoryId: a, kind: "restored" });
      expect(isWallNow(restored!.at, startedAt)).toBe(true);

      // restoreSuperseded: reinforce も unsuperseded の at も注入した時計。
      const consolidated = await kit.runtime.consolidate(ctx, { target: { memoryIds: [a, b] } });
      const reinforcedBefore = (await kit.memoryStore.get(ctx, a))!.lastReinforcedAt!;
      const restoredSuperseded = await kit.runtime.restoreSuperseded(ctx, {
        supersededById: consolidated.consolidatedMemoryId!,
      });
      expect(restoredSuperseded.outcomes.map((o) => o.kind)).toEqual(["restored", "restored"]);
      const afterUnsupersede = (await kit.memoryStore.get(ctx, a))!;
      expect(isInjected(afterUnsupersede.lastReinforcedAt)).toBe(true);
      expect(afterUnsupersede.lastReinforcedAt!.getTime()).toBeGreaterThan(
        reinforcedBefore.getTime(),
      );
      const [unsuperseded] = await kit.eventStore.list(ctx, { memoryId: a, kind: "unsuperseded" });
      expect(isInjected(unsuperseded!.at)).toBe(true);
    });

    it("壁時計より過去の時計では、tick は積んだジョブを1本も取らない（未来の時計なら取る）", async () => {
      for (const [clockAt, expected] of [
        [PAST, 0],
        [FUTURE, 1],
      ] as const) {
        const kit = await makeKit({ now: () => new Date(clockAt) });
        await kit.runtime.observe(ctx, {
          kind: "utterance",
          text: "事実を1つ",
          extract: "deferred",
        });
        expect(await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 })).toEqual({
          processed: expected,
          failed: 0,
          unsupported: [],
          leaseConflicts: [],
        });
      }
    });
  });
}
