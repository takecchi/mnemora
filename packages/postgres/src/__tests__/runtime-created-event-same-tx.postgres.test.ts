import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type {
  Ctx,
  EventStore,
  LLMProvider,
  Memory,
  MemoryId,
  MemoryStore,
  Runtime,
  VectorStore,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
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
 * reextract・consolidate・reflect の書き込みも、「記憶が在るのに `created` が0件」を残さない
 * （穴 D-3 の続き。ADR 0410 は抽出の経路だけを直した。残りは ADR 0416 で扱う）。
 *
 * 今の3経路は、記憶を（`supersedeWithNewMemories` または `createMemoryWithOutbox` で）コミットしたあと、
 * `created` を別の文（`appendCreatedEvent` / `eventStore.append`）で積む。`created` の append が一時的に失敗すると
 * 呼び出しは例外になるが、記憶は残る。再試行は、
 * - reextract: 同じ内容の記憶が「在る」と見て素通しする（`created` は0件のまま）。
 * - consolidate: 統合元が `superseded` になっているので、対象なしになる。
 * - reflect: 孤児の反映先が残ったまま、`created` は揃わない。
 *
 * ## 範囲
 * **`supersedeWithNewMemories` の口がある経路だけ**（reextract の口あり、consolidate の口あり）と、reflect。
 * 口が無い adapter 向けの経路（`createMemoryWithOutbox` + ループ。reextract・consolidate の口なし）は、
 * 直さない負債として残るので、ここでは縛らない。実 adapter 2つ（testkit の InMemory と Postgres）は
 * どちらも口を持つ。
 *
 * ## 検査の形
 * `observe-created-event-same-tx.postgres.test.ts` と同じ。`created` の書き込みそのものを DB／配列の側で失敗させる
 * （Postgres: `memory_events` への `kind = 'created'` の INSERT を拒むトリガ／InMemory: 共有 `events` 配列の
 * `push` が投げる）ので、別の文で積む今の経路も、記憶と同じトランザクションで積む直した経路も、同じところで落ちる。
 *
 * 1. 失敗している間、新しい記憶は0件で、`created` も0件（consolidate では統合元が active のまま、reextract では
 *    旧い記憶が superseded になっていない）。
 * 2. 失敗を外して再試行すれば、新しい記憶の数と `created` の数が一致する（直接の呼び出しでは、ちょうど1件ずつ）。
 *
 * ⚠ tick のジョブ経由（`processConsolidateJob` / `processReflectJob`）は、落ちると outbox の `fail()` に
 * 倒れる。再試行後に件数が揃うことは縛らない（ジョブの再配達の仕様は別の話で、この歯の対象ではない）——
 * 「失敗中は何も残らない」と「新しい記憶と `created` が食い違わない」だけを縛る。
 * 件数が揃うこと自体は、直接の呼び出しで縛っている。
 */

type LlmMode = "extract" | "consolidate" | "reflect";
let mode: LlmMode = "extract";
let candidates: string[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    if (mode === "extract") {
      return req.schema.parse({
        memories: candidates.map((content) => ({ content, provenanceKind: "stated" })),
      });
    }
    if (mode === "consolidate") return req.schema.parse({ content: "統合後の本文" });
    return req.schema.parse({ outcome: "reflected", content: "内省の本文" });
  },
};

/**
 * tick のジョブはリース・backoff を経て再配達される。実時間は待たず、時計を進める。
 * 時計は実時刻より1秒だけ未来を返す（outbox の `available_at` は DB の `now()` で書かれるため。
 * `consolidate-reflect-carryover.postgres.test.ts` の同じ注記を見ること）。
 */
let nowMs = Date.now();
const clock = { now: () => new Date(nowMs + 1_000) };
const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");
const shared = {
  clock,
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent,
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
  vectorStore: VectorStore;
  /** テナント内の記憶の総数（status を問わない）。 */
  countMemories(): Promise<number>;
  /** `created` の書き込みを失敗させる／戻す。 */
  failCreated(on: boolean): Promise<void>;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      const vectorStore = new InMemoryVectorStore(memoryStore);
      const events = memoryStore.events;
      const realPush = events.push.bind(events);
      let failing = false;
      events.push = (...items) => {
        if (failing && items.some((e) => e.kind === "created")) {
          throw new Error("created の書き込みが一時的に失敗した（テストの注入）");
        }
        return realPush(...items);
      };
      return {
        memoryStore,
        eventStore,
        vectorStore,
        countMemories: async () =>
          (memoryStore as unknown as { memories: Map<string, Memory> }).memories.size,
        failCreated: async (on) => {
          failing = on;
        },
        runtime: createRuntime({
          ...shared,
          memoryStore,
          eventStore,
          vectorStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_created ON memory_events`);
      await db.execute(sql`
        CREATE OR REPLACE FUNCTION test_fail_created_fn() RETURNS trigger AS $$
        BEGIN
          IF NEW.kind = 'created' THEN
            RAISE EXCEPTION 'created の書き込みが一時的に失敗した（テストの注入）';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql
      `);
      const memoryStore = new PostgresMemoryStore(db);
      const eventStore = new PostgresEventStore(db);
      const vectorStore = new PostgresVectorStore(db);
      return {
        memoryStore,
        eventStore,
        vectorStore,
        countMemories: async () => {
          const res = await db.execute(sql`SELECT count(*)::int AS n FROM memories`);
          return Number((res.rows[0] as { n: number }).n);
        },
        failCreated: async (on) => {
          if (on) {
            await db.execute(sql`
              CREATE TRIGGER test_fail_created BEFORE INSERT ON memory_events
              FOR EACH ROW EXECUTE FUNCTION test_fail_created_fn()
            `);
          } else {
            await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_created ON memory_events`);
          }
        },
        runtime: createRuntime({
          ...shared,
          memoryStore,
          eventStore,
          vectorStore,
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "runtime-created-event-same-tx" };

afterAll(async () => {
  const { db } = await getTestClient();
  await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_created ON memory_events`);
  await db.execute(sql`DROP FUNCTION IF EXISTS test_fail_created_fn()`);
  await closeTestClient();
});

/** 統合・内省の材料になる、同じ向きのベクトルを持つ ready の記憶。`jobKinds` を渡すと outbox にジョブも積む。 */
async function seedMemory(kit: Kit, name: string, jobKinds?: string[]): Promise<Memory> {
  const input = buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    content: `素材 ${name}`,
    contentHash: `seed-${name}`,
    digest: name,
    recordedAt: new Date(nowMs),
    occurredAt: new Date(nowMs),
    embeddingStatus: "ready",
  });
  const memory =
    jobKinds === undefined
      ? await kit.memoryStore.createMemory(ctx, input)
      : (await kit.memoryStore.createMemoryWithOutbox(ctx, input, jobKinds)).memory;
  await kit.vectorStore.upsert(ctx, TEST_EMBEDDING_SPACE, memory.id, [1, 0, 0]);
  return memory;
}

async function state(kit: Kit) {
  const created = await kit.eventStore.list(ctx, { kind: "created" });
  return { memories: await kit.countMemories(), created };
}

const attempt = (fn: () => Promise<unknown>) =>
  fn().then(
    () => ({ threw: false }),
    () => ({ threw: true }),
  );

/** ジョブ経由の再試行: 時計を進めてリース・backoff を切らせ、何度か tick を回す。 */
async function retryTicks(kit: Kit, kind: "consolidate" | "reflect") {
  nowMs += 10 * 60_000;
  for (let i = 0; i < 3; i += 1) {
    await kit.runtime.tick(ctx, { kinds: [kind], leaseMs: 60_000 });
    nowMs += 10 * 60_000;
  }
}

for (const [name, makeKit] of KITS) {
  describe(`${name}: reextract（口あり）の created の append が失敗したとき（穴 D-3）`, () => {
    it("失敗中は新しい記憶が無く旧い記憶も superseded にならず、再試行後は新しい記憶の数だけ created が揃う", async () => {
      const kit = await makeKit();
      mode = "extract";
      candidates = ["旧い事実"];
      const observed = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: "発話",
        externalId: "reextract-same-tx",
        extract: "sync",
      });
      const observationId = observed.observationId;
      const [old] = await kit.memoryStore.listBySourceObservation(ctx, observationId, "v1");
      const base = await state(kit);
      expect(base.memories).toBe(1);
      expect(base.created).toHaveLength(1);

      candidates = ["新しい事実"];
      await kit.failCreated(true);
      const first = await attempt(() => kit.runtime.reextract(ctx, observationId));
      expect(first.threw).toBe(true);

      // 1. 失敗中: 新しい記憶は0件、created も0件。旧い記憶は active のまま。
      const whileFailed = await state(kit);
      expect(whileFailed.memories).toBe(base.memories);
      expect(whileFailed.created).toHaveLength(base.created.length);
      expect((await kit.memoryStore.get(ctx, old!.id))!.status).toBe("active");

      // 2. 再試行後: 新しい記憶の数と created の数が揃う。
      await kit.failCreated(false);
      await kit.runtime.reextract(ctx, observationId);
      const after = await state(kit);
      const newMemories = after.memories - base.memories;
      const newCreated = after.created.length - base.created.length;
      expect(newMemories).toBe(1);
      expect(newCreated).toBe(newMemories);
      expect((await kit.memoryStore.get(ctx, old!.id))!.status).toBe("superseded");
      const current = await kit.memoryStore.listBySourceObservation(ctx, observationId, "v1");
      expect(current.map((m) => m.content)).toEqual(["新しい事実"]);
      expect(after.created.map((e) => e.memoryId)).toContain(current[0]!.id);
    });
  });

  describe(`${name}: consolidate（口あり）の created の append が失敗したとき（穴 D-3）`, () => {
    it("直接の呼び出し: 失敗中は新しい記憶が無く統合元は active のまま、再試行後は新しい記憶の数だけ created が揃う", async () => {
      const kit = await makeKit();
      mode = "consolidate";
      const a = await seedMemory(kit, "a");
      const b = await seedMemory(kit, "b");
      const base = await state(kit);
      expect(base.memories).toBe(2);

      await kit.failCreated(true);
      const first = await attempt(() =>
        kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } }),
      );
      expect(first.threw).toBe(true);

      const whileFailed = await state(kit);
      expect(whileFailed.memories).toBe(base.memories);
      expect(whileFailed.created).toHaveLength(0);
      expect((await kit.memoryStore.get(ctx, a.id))!.status).toBe("active");
      expect((await kit.memoryStore.get(ctx, b.id))!.status).toBe("active");

      await kit.failCreated(false);
      await kit.runtime.consolidate(ctx, { target: { memoryIds: [a.id, b.id] } });
      const after = await state(kit);
      const newMemories = after.memories - base.memories;
      expect(newMemories).toBe(1);
      expect(after.created).toHaveLength(newMemories);
      const aAfter = await kit.memoryStore.get(ctx, a.id);
      expect(aAfter!.status).toBe("superseded");
      expect(after.created.map((e) => e.memoryId)).toEqual([aAfter!.supersededById]);
    });

    it("tick のジョブ: 失敗中は新しい記憶が無く統合元は active のまま、再試行後も新しい記憶と created が食い違わない", async () => {
      const kit = await makeKit();
      mode = "consolidate";
      const seed = await seedMemory(kit, "seed", ["consolidate"]);
      const neighbor = await seedMemory(kit, "neighbor");
      const base = await state(kit);

      await kit.failCreated(true);
      const failedTick = await kit.runtime.tick(ctx, { kinds: ["consolidate"], leaseMs: 60_000 });
      expect(failedTick.failed).toBe(1);

      const whileFailed = await state(kit);
      expect(whileFailed.memories).toBe(base.memories);
      expect(whileFailed.created).toHaveLength(0);
      expect((await kit.memoryStore.get(ctx, seed.id))!.status).toBe("active");
      expect((await kit.memoryStore.get(ctx, neighbor.id))!.status).toBe("active");

      await kit.failCreated(false);
      await retryTicks(kit, "consolidate");
      const after = await state(kit);
      expect(after.created).toHaveLength(after.memories - base.memories);
    });
  });

  describe(`${name}: reflect の created の append が失敗したとき（穴 D-3）`, () => {
    it("直接の呼び出し: 失敗中は新しい記憶が無く、再試行後は新しい記憶の数だけ created が揃う（孤児の反映先が残らない）", async () => {
      const kit = await makeKit();
      mode = "reflect";
      const a = await seedMemory(kit, "a");
      const b = await seedMemory(kit, "b");
      const base = await state(kit);

      await kit.failCreated(true);
      const first = await attempt(() =>
        kit.runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } }),
      );
      expect(first.threw).toBe(true);

      const whileFailed = await state(kit);
      expect(whileFailed.memories).toBe(base.memories);
      expect(whileFailed.created).toHaveLength(0);

      await kit.failCreated(false);
      await kit.runtime.reflect(ctx, { target: { memoryIds: [a.id, b.id] } });
      const after = await state(kit);
      const newMemories = after.memories - base.memories;
      expect(newMemories).toBe(1);
      expect(after.created).toHaveLength(newMemories);
      // reflect は材料の記憶を動かさない。
      const ids: MemoryId[] = [a.id, b.id];
      for (const id of ids) expect((await kit.memoryStore.get(ctx, id))!.status).toBe("active");
    });

    it("tick のジョブ: 失敗中は新しい記憶が無く、再試行後も新しい記憶と created が食い違わない", async () => {
      const kit = await makeKit();
      mode = "reflect";
      await seedMemory(kit, "seed", ["reflect"]);
      await seedMemory(kit, "neighbor");
      const base = await state(kit);

      await kit.failCreated(true);
      const failedTick = await kit.runtime.tick(ctx, { kinds: ["reflect"], leaseMs: 60_000 });
      expect(failedTick.failed).toBe(1);

      const whileFailed = await state(kit);
      expect(whileFailed.memories).toBe(base.memories);
      expect(whileFailed.created).toHaveLength(0);

      await kit.failCreated(false);
      await retryTicks(kit, "reflect");
      const after = await state(kit);
      expect(after.created).toHaveLength(after.memories - base.memories);
    });
  });
}
