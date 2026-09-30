import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, EventStore, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
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
 * 抽出の書き込みは、「記憶が在るのに `created` が0件」を残さない（穴 D-3。ADR 0410 で扱う）。
 *
 * 今の `createMemoriesFromCandidates` は、候補ごとに `createMemoryWithOutbox` で記憶をコミットしたあと、
 * `EventStore.append` を別の文で呼ぶ。`created` の append が一時的に失敗すると `observe`（sync）／`tick`
 * （deferred）は例外になるが、記憶は残る。あとの再送や tick は `listBySourceObservation` で「在る」と見て
 * 素通りする（ADR 0347 決定1）ので、`created` は0件のまま残る。
 *
 * ## 検査の形（アダプタが新しい任意メソッドを持つかどうかに依らない）
 *
 * 新メソッドの名前・形にはここで依存しない。`Runtime.observe/tick` を実 adapter（testkit の InMemory と
 * Postgres）に載せ、**`created` イベントの書き込みそのものを、DB／配列の側で失敗させる**:
 * - Postgres: `memory_events` への `kind = 'created'` の INSERT を拒むトリガ。別の文で append する今の経路も、
 *   記憶と同じトランザクションで積む新しい経路も、同じところで落ちる。
 * - InMemory: 共有の `events` 配列の `push` が、`kind = 'created'` のとき投げる。
 *
 * 失敗を外したあとの再送・tick を経て、次の2つが成り立つこと:
 * 1. 失敗している間、記憶は残らない（記憶と `created` は同じトランザクション。落ちたら巻き戻る）。
 * 2. 失敗を外して再試行すれば、書けた候補ごとに `created` が1件ずつ揃う（保存できない候補は
 *    `meta.droppedCandidates` に残る）。記憶の数と `created` の数が食い違わない。
 *    ⚠ deferred の extract ジョブは、落ちると終端 `failed` になり自動では再試行されない（Phase 1）。
 *    そのため deferred は「失敗中は何も残らない」と「記憶と created が食い違わない」だけを縛り、
 *    再試行後に件数が揃うことは sync だけで縛る（sync のジョブは完了にならずに残り、tick が拾い直す）。
 *
 * ⚠ 範囲は抽出の経路（sync／deferred）だけ。re-extract・consolidate・reflect は範囲外。
 * ⚠ `createMemoryWithOutbox` 経由の今の経路しか持たない adapter は、この PR の直しでも取りこぼしが残る
 * （ADR に「守れないもの」として書く）。ここが縛るのは、実 adapter 2つ。
 */

let candidates: string[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    req.schema.parse({
      memories: candidates.map((content) => ({ content, provenanceKind: "stated" })),
    }),
};

const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");
const shared = {
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

/**
 * `created` の書き込みが失敗している間に抽出し、失敗を外して再送・tick で再試行する。
 * 失敗中の状態（記憶の件数）と、再試行後の状態を返す。
 */
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
  // 再送で Observation の id が分かる（同じ externalId は抽出をやり直さない）。
  await kit.failCreated(false);
  const resent = await kit.runtime.observe(ctx, input);
  const observationId = resent.observationId;
  // 失敗中に書かれたものは、失敗を外す前に読む必要がある——が、失敗を外したあとの再送は
  // 抽出をやり直さないので、この時点の状態は「失敗中の結果」そのもの。
  const whileFailed = await snapshot(kit, observationId);
  // 再試行: 再配達される extract ジョブを、何度か tick で回す（backoff があっても取りこぼさないよう複数回）。
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
        // 1. 失敗中: 記憶だけが残って created が0件、を許さない。
        expect(got.whileFailed.memories).toHaveLength(0);
        expect(got.whileFailed.created).toHaveLength(0);
        // 2. 再試行後: 記憶と created が食い違わない。sync なら3件の記憶と、それぞれの created が揃う。
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
