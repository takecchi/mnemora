import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type {
  Clock,
  Ctx,
  EventStore,
  LLMProvider,
  MemoryStore,
  OutboxJobKind,
  OutboxJobRecord,
  OutboxStore,
  Runtime,
} from "@mnemora/core";
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
import { rowToOutboxJob, type OutboxJobRow } from "../mapping.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
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
  outboxStore: OutboxStore;
  /** その kind の直近1件を、終端の有無によらず読む（claim を消費しない）。 */
  latestOutboxJob(kind: OutboxJobKind): Promise<OutboxJobRecord | null>;
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
      const outboxStore = new InMemoryOutboxStore(memoryStore.outboxJobs);
      return {
        memoryStore,
        eventStore,
        outboxStore,
        async latestOutboxJob(kind) {
          const matches = memoryStore.outboxJobs.filter((j) => j.kind === kind);
          return matches.length > 0 ? { ...matches[matches.length - 1]! } : null;
        },
        runtime: createRuntime({
          ...sharedWith(clock),
          memoryStore,
          eventStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          outboxStore,
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
      const outboxStore = new PostgresOutboxStore(db);
      return {
        memoryStore,
        eventStore,
        outboxStore,
        async latestOutboxJob(kind) {
          const result = await db.execute(sql`
            SELECT * FROM outbox WHERE kind = ${kind} ORDER BY created_at DESC, id DESC LIMIT 1
          `);
          return result.rows.length > 0
            ? rowToOutboxJob(result.rows[0] as unknown as OutboxJobRow)
            : null;
        },
        runtime: createRuntime({
          ...sharedWith(clock),
          memoryStore,
          eventStore,
          vectorStore: new PostgresVectorStore(db),
          outboxStore,
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "injected-clock-reach" };
const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2030-01-01T00:00:00.000Z");

/** 呼ぶたびに `base` から1秒ずつ進む時計（固定の時計では、作成と同じ時刻の強化が書かれないため）。 */
function steppingClockFrom(base: Date): Clock {
  let t = base.getTime();
  return { now: () => new Date((t += 1000)) };
}

/** `base` の前後 `windowMs`（既定1時間）以内の時刻か。注入した時計はここに落ちる。 */
function isNear(date: Date | null | undefined, base: Date, windowMs = 3_600_000): boolean {
  return (
    date instanceof Date &&
    date.getTime() >= base.getTime() &&
    date.getTime() < base.getTime() + windowMs
  );
}

/** テストが走っている間の壁時計の時刻か（前後1秒の余裕）。「省略時は壁時計」の対照に使う。 */
function isWallNow(date: Date, startedAt: number): boolean {
  return date.getTime() >= startedAt - 1000 && date.getTime() <= Date.now() + 1000;
}

afterAll(async () => {
  await closeTestClient();
});

for (const [name, makeKit] of KITS) {
  describe(`${name}: 案1適用後——注入した時計がどこまで届くか`, () => {
    for (const [label, clockAt] of [
      ["PAST（2020）", PAST],
      ["FUTURE（2030）", FUTURE],
    ] as const) {
      it(`${label}: outbox の available_at・created_at が注入した時計に従うため、tick は積んだジョブを取る（processed: 1）`, async () => {
        const kit = await makeKit(steppingClockFrom(clockAt));

        await kit.runtime.observe(ctx, {
          kind: "utterance",
          text: "事実を1つ",
          extract: "deferred",
        });

        const extractJobBefore = await kit.latestOutboxJob("extract");
        expect(isNear(extractJobBefore?.availableAt, clockAt)).toBe(true);
        expect(isNear(extractJobBefore?.createdAt, clockAt)).toBe(true);

        expect(await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 })).toEqual({
          processed: 1,
          failed: 0,
          unsupported: [],
          leaseConflicts: [],
        });

        const extractJobAfter = await kit.latestOutboxJob("extract");
        expect(isNear(extractJobAfter?.completedAt, clockAt)).toBe(true);

        const [created] = await kit.eventStore.list(ctx, { kind: "created" });
        expect(isNear(created?.at, clockAt)).toBe(true);

        const embedJobBefore = await kit.latestOutboxJob("embed");
        expect(isNear(embedJobBefore?.availableAt, clockAt)).toBe(true);
        expect(isNear(embedJobBefore?.createdAt, clockAt)).toBe(true);

        expect(await kit.runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 })).toEqual({
          processed: 1,
          failed: 0,
          unsupported: [],
          leaseConflicts: [],
        });

        const embedJobAfter = await kit.latestOutboxJob("embed");
        expect(isNear(embedJobAfter?.completedAt, clockAt)).toBe(true);
      });
    }

    it("created・recall の createdAt は注入した時計に従う（省略時は壁時計になる、という以前の縛りの裏返し）", async () => {
      const kit = await makeKit({ now: () => new Date(FUTURE) });
      const observed = await kit.runtime.observe(ctx, { kind: "utterance", text: "事実を1つ" });
      const memoryId = observed.memoryIds[0]!;
      expect((await kit.memoryStore.get(ctx, memoryId))?.recordedAt).toEqual(FUTURE);

      const [created] = await kit.eventStore.list(ctx, { memoryId, kind: "created" });
      expect(created!.at).toEqual(FUTURE);

      const recalled = await kit.runtime.recall(ctx, { text: "事実", limit: 3, association: null });
      const record = await kit.runtime.getRecall(ctx, recalled.recallId);
      expect(record!.createdAt).toEqual(FUTURE);
    });

    it("forget・purge: forgotten/purged の at と purgedAt は注入した時計に従う", async () => {
      const kit = await makeKit(steppingClockFrom(FUTURE));
      const observed = await kit.runtime.observe(ctx, { kind: "utterance", text: "事実を1つ" });
      const memoryId = observed.memoryIds[0]!;

      await kit.runtime.forget(ctx, { memoryId });
      const [forgotten] = await kit.eventStore.list(ctx, { memoryId, kind: "forgotten" });
      expect(isNear(forgotten?.at, FUTURE)).toBe(true);

      const purged = await kit.runtime.purge(ctx, { memoryId });
      expect(purged.outcomes.map((o) => o.kind)).toEqual(["purged"]);
      const [purgedEvent] = await kit.eventStore.list(ctx, { memoryId, kind: "purged" });
      expect(isNear(purgedEvent?.at, FUTURE)).toBe(true);
      // `purged_at` と `memory_events.at` は同じ値でなければならない（1つの壁時計を2箇所に使う——
      // 省略時に2回 `new Date()` を呼んで別の値になることがない、という設計上の要求）。
      const memoryAfterPurge = await kit.memoryStore.get(ctx, memoryId);
      expect(memoryAfterPurge?.purgedAt).toEqual(purgedEvent!.at);
    });

    it("復帰と掃引: reinforce は注入した時計、sweepArchive は opts.now で選び archived の at も opts.now、restored/unsuperseded の at は注入した時計", async () => {
      const kit = await makeKit(steppingClockFrom(FUTURE));
      const a = (await kit.runtime.observe(ctx, { kind: "utterance", text: "事実を1つ" }))
        .memoryIds[0]!;
      const b = (await kit.runtime.observe(ctx, { kind: "utterance", text: "事実をもう1つ" }))
        .memoryIds[0]!;
      const createdA = (await kit.memoryStore.get(ctx, a))!;
      expect(isNear(createdA.recordedAt, FUTURE)).toBe(true);
      const floorA = createdA.decayFloorAt!;

      const recalled = await kit.runtime.recall(ctx, { text: "事実", limit: 3, association: null });
      await kit.runtime.observe(ctx, {
        kind: "memory_usage",
        recallId: recalled.recallId,
        usedMemoryIds: [b],
      });
      expect(isNear((await kit.memoryStore.get(ctx, b))!.lastReinforcedAt, FUTURE)).toBe(true);

      const sweepNow = new Date(floorA.getTime() + 1000);
      const swept = await kit.runtime.sweepArchive(ctx, { now: sweepNow, limit: 10 });
      expect(swept.archived.map((x) => x.memoryId)).toContain(a);
      const [archived] = await kit.eventStore.list(ctx, { memoryId: a, kind: "archived" });
      expect(archived!.at).toEqual(sweepNow);

      const restoredArchived = await kit.runtime.restoreArchived(ctx, { memoryId: a });
      expect(restoredArchived.outcomes.map((o) => o.kind)).toEqual(["restored"]);
      const afterRestore = (await kit.memoryStore.get(ctx, a))!;
      expect(isNear(afterRestore.lastReinforcedAt, FUTURE)).toBe(true);
      expect(afterRestore.decayFloorAt!.getTime()).toBeGreaterThan(floorA.getTime());
      const [restored] = await kit.eventStore.list(ctx, { memoryId: a, kind: "restored" });
      expect(isNear(restored?.at, FUTURE)).toBe(true);

      const consolidated = await kit.runtime.consolidate(ctx, { target: { memoryIds: [a, b] } });
      const reinforcedBefore = (await kit.memoryStore.get(ctx, a))!.lastReinforcedAt!;
      const restoredSuperseded = await kit.runtime.restoreSuperseded(ctx, {
        supersededById: consolidated.consolidatedMemoryId!,
      });
      expect(restoredSuperseded.outcomes.map((o) => o.kind)).toEqual(["restored", "restored"]);
      const afterUnsupersede = (await kit.memoryStore.get(ctx, a))!;
      expect(isNear(afterUnsupersede.lastReinforcedAt, FUTURE)).toBe(true);
      expect(afterUnsupersede.lastReinforcedAt!.getTime()).toBeGreaterThan(
        reinforcedBefore.getTime(),
      );
      const [unsuperseded] = await kit.eventStore.list(ctx, { memoryId: a, kind: "unsuperseded" });
      expect(isNear(unsuperseded?.at, FUTURE)).toBe(true);
    });

    it("opts を省略すると、outbox の3欄・purgedAt・recall の createdAt は今日どおり壁時計になる（非破壊の確認）", async () => {
      const startedAt = Date.now();
      // `clock` 自体は FUTURE に注入しても、store の口への `opts` は runtime が必ず埋めるため
      // ここでは直接 store を呼び、`opts` を省略したときの実装の既定を確かめる
      // （runtime を経由すると常に `opts` が埋まるため、runtime からは確認できない）。
      const kit = await makeKit({ now: () => new Date(FUTURE) });
      const { jobs } = await kit.memoryStore.createObservationWithOutbox(
        ctx,
        {
          tenantId: ctx.tenantId,
          subjectId: null,
          externalId: null,
          kind: "utterance",
          payload: { text: "壁時計の確認" },
          occurredAt: null,
          recordedAt: new Date(FUTURE),
          validFrom: null,
          validUntil: null,
          attributes: {},
        },
        ["extract"],
      );
      expect(isWallNow(jobs[0]!.availableAt, startedAt)).toBe(true);
      expect(isWallNow(jobs[0]!.createdAt, startedAt)).toBe(true);
    });
  });
}
