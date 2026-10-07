import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, EventStore, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime, isClaimKeyIndexLimitError } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "@mnemora/testkit";
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
 * 検査の形は、アダプタが新しい任意メソッドを持つかどうかに依らない。`Runtime.observe/tick` を実 adapter（testkit の InMemory と Postgres）に載せ、`created` イベントの書き込みそのものを DB／配列の側で失敗させる:
 * - Postgres: `memory_events` への `kind = 'created'` の INSERT を拒むトリガ。別の文で append する経路も、記憶と同じトランザクションで積む経路も、同じところで落ちる。
 * - InMemory: 共有の `events` 配列の `push` が、`kind = 'created'` のとき投げる。
 *
 * 1. 失敗している間、記憶は残らない（記憶と `created` は同じトランザクション。落ちたら巻き戻る）。
 * 2. 失敗を外して再試行すれば、書けた候補ごとに `created` が1件ずつ揃う（保存できない候補は `meta.droppedCandidates` に残る）。
 *    ⚠ deferred の extract ジョブは、落ちると終端 `failed` になり自動では再試行されない。そのため deferred は「失敗中は何も残らない」と「記憶と created が食い違わない」だけを縛り、再試行後に件数が揃うことは sync だけで縛る。
 * ⚠ 範囲は抽出の経路（sync／deferred）だけ。`createMemoryWithOutbox` 経由の経路しか持たない adapter は取りこぼしが残る。ここが縛るのは、実 adapter 2つ。
 */

let candidates: string[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({
      memories: candidates.map((content) => ({ content, provenanceKind: "stated" })),
    }),
};

/** sync の extract ジョブは claim 済みで積まれ、失敗で完了にならなければリース切れまで tick に拾われない。リース切れを待つ代わりに、時計を進める（実時間は待たない）。 */
let nowMs = Date.now();
const clock = { now: () => new Date(nowMs) };
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
  /** `created` の書き込みを失敗させる／戻す。 */
  failCreated(on: boolean): Promise<void>;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
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
        failCreated: async (on) => {
          failing = on;
        },
        runtime: createRuntime({
          ...shared,
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
      return {
        memoryStore,
        eventStore,
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
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "observe-created-event-same-tx" };
const NUL = "二件目\u0000";

afterAll(async () => {
  const { db } = await getTestClient();
  await db.execute(sql`DROP TRIGGER IF EXISTS test_fail_created ON memory_events`);
  await db.execute(sql`DROP FUNCTION IF EXISTS test_fail_created_fn()`);
  await closeTestClient();
});

async function snapshot(kit: Kit, observationId: string) {
  const memories = await kit.memoryStore.listBySourceObservation(ctx, observationId, "v1");
  const created = await kit.eventStore.list(ctx, { kind: "created" });
  return { memories, created };
}

/** `created` の書き込みが失敗している間に抽出し、失敗を外して再送・tick で再試行する。失敗中の状態と、再試行後の状態を返す。 */
async function extractWithCreatedFailure(
  kit: Kit,
  given: string[],
  externalId: string,
  extract: "sync" | "deferred",
) {
  candidates = given;
  const input = { kind: "utterance" as const, text: "発話", externalId, extract };
  await kit.failCreated(true);
  const first = await kit.runtime.observe(ctx, input).then(
    (r) => ({ threw: false as const, observationId: r.observationId }),
    () => ({ threw: true as const, observationId: null }),
  );
  const failedTick =
    extract === "deferred"
      ? await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 })
      : null;
  await kit.failCreated(false);
  const resent = await kit.runtime.observe(ctx, input);
  const observationId = resent.observationId;
  const whileFailed = await snapshot(kit, observationId);
  nowMs += 10 * 60_000;
  let ticks = 0;
  for (let i = 0; i < 3; i += 1) {
    const t = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: 60_000 });
    ticks += t.processed;
  }
  const after = await snapshot(kit, observationId);
  return { first, failedTick, whileFailed, after, ticks };
}

for (const [name, makeKit] of KITS) {
  for (const extract of ["sync", "deferred"] as const) {
    describe(`${name} / ${extract}: created の append が失敗したとき（穴 D-3）`, () => {
      it("失敗中は記憶が残らず（同じトランザクション）、再試行後は記憶の数だけ created が揃う", async () => {
        const kit = await makeKit();
        const got = await extractWithCreatedFailure(
          kit,
          ["一件目の事実", "二件目の事実", "三件目の事実"],
          `same-tx-${extract}`,
          extract,
        );
        if (extract === "sync") expect(got.first.threw).toBe(true);
        expect(got.whileFailed.memories).toHaveLength(0);
        expect(got.whileFailed.created).toHaveLength(0);
        expect(got.after.created.map((e) => e.memoryId).sort()).toEqual(
          got.after.memories.map((m) => m.id).sort(),
        );
        if (extract === "sync") {
          expect(got.after.memories.map((m) => m.content).sort()).toEqual([
            "一件目の事実",
            "三件目の事実",
            "二件目の事実",
          ]);
          expect(got.after.created).toHaveLength(3);
        }
      });

      it("保存できない候補（NUL）が混じっても、失敗中は何も残らず、再試行後は書けた候補ぶんの created が droppedCandidates 付きで揃う", async () => {
        const kit = await makeKit();
        const got = await extractWithCreatedFailure(
          kit,
          ["一件目の事実", NUL, "三件目の事実"],
          `same-tx-nul-${extract}`,
          extract,
        );
        if (extract === "sync") expect(got.first.threw).toBe(true);
        expect(got.whileFailed.memories).toHaveLength(0);
        expect(got.whileFailed.created).toHaveLength(0);
        expect(got.after.created.map((e) => e.memoryId).sort()).toEqual(
          got.after.memories.map((m) => m.id).sort(),
        );
        if (extract === "sync") {
          expect(got.after.memories.map((m) => m.content).sort()).toEqual([
            "一件目の事実",
            "三件目の事実",
          ]);
          expect(got.after.created).toHaveLength(2);
        }
        for (const e of got.after.created) {
          const dropped = (e.meta ?? {}).droppedCandidates as Array<Record<string, unknown>>;
          expect(dropped).toHaveLength(1);
          expect(dropped[0]).toMatchObject({ index: 1, contentHash: hashContent(NUL) });
        }
      });
    });
  }
}

/**
 * 候補ごとの SAVEPOINT の歯。上の「保存できない候補（NUL）」は SQL を投げる前に JS 側で落ちるのでトランザクションは aborted にならず、SAVEPOINT の有無を区別できない。
 * ここでは SQL を投げてから DB が断る値（claim key の索引の1行の上限。SQLSTATE 54000）を真ん中の候補に置く。SAVEPOINT が無いと、その INSERT の失敗でトランザクションが aborted になり、後ろの候補と `created` の INSERT が `current transaction is aborted` で落ちる。
 */
describe("Postgres: DB が拒む候補（claim key の索引上限 54000）が真ん中に在っても、前後の候補と created は書ける", () => {
  it("悪い候補だけが dropped になり、前後の記憶と、書けた記憶ぶんの created が同じトランザクションで残る", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const sctx: Ctx = { tenantId: "observe-created-event-same-tx-savepoint" };
    // 圧縮が効かない長い hex（"ab".repeat(n) のような繰り返しは圧縮されて通る）。
    let tooLong = "";
    for (let i = 0; tooLong.length < 2700; i += 1) {
      tooLong += createHash("sha256").update(`p:${i}`).digest("hex");
    }
    const build = (content: string, claimKey?: { subject: string; predicate: string }) => ({
      input: buildNewMemoryFixture({
        tenantId: sctx.tenantId,
        content,
        contentHash: hashContent(content),
        ...(claimKey !== undefined ? { claimKey } : {}),
      }),
      jobKinds: ["embed" as const],
    });

    const result = await store.createMemoriesWithOutboxAndEvents(
      sctx,
      [
        build("一件目の事実"),
        build("二件目の事実", { subject: "s", predicate: tooLong.slice(0, 2700) }),
        build("三件目の事実"),
      ],
      (memory) =>
        buildNewMemoryEventFixture({
          tenantId: sctx.tenantId,
          memoryId: memory.id,
          kind: "created",
        }),
    );

    expect(result.written.map((w) => w.index)).toEqual([0, 2]);
    expect(result.dropped.map((d) => d.index)).toEqual([1]);
    expect(isClaimKeyIndexLimitError(result.dropped[0]!.error)).toBe(true);
    const memories = await db.execute(
      sql`SELECT content FROM memories WHERE tenant_id = ${sctx.tenantId} ORDER BY content`,
    );
    expect(memories.rows.map((r) => (r as { content: string }).content).sort()).toEqual(
      ["一件目の事実", "三件目の事実"].sort(),
    );
    const created = await db.execute(
      sql`SELECT memory_id FROM memory_events WHERE tenant_id = ${sctx.tenantId} AND kind = 'created'`,
    );
    expect(created.rows.map((r) => (r as { memory_id: string }).memory_id).sort()).toEqual(
      result.written.map((w) => w.memory.id).sort(),
    );
  });
});
