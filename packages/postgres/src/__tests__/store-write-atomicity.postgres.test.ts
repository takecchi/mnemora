import { afterAll, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Ctx, MemoryId, NewMemoryEvent, ObservationId, RecallId } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 1回の呼び出しで複数の表に書く `PostgresMemoryStore` の口が、書き込みの途中で DB に失敗されたとき、
 * 書いた分を全部取り消すこと（`MemoryStore` の TSDoc の「1トランザクションで」「同一トランザクションで」）。
 *
 * - 失敗の起こし方: その口が書く表のうち、トランザクションの**最後のほう**に書く表へ、行を書こうとすると
 *   例外を投げるトリガーを一時的に付ける。先に書いた表の行が残っていれば、巻き戻っていない。
 * - 見るもの: 下の `TABLES` の全行の写し（件数と md5）。呼ぶ前と後で1文字も変わらないこと。
 * - 陽性対照: 同じ呼び出しをトリガー無しで撃つと、2つ以上の表が変わる（写しが書き込みを拾えること、
 *   その口が実際に複数の表に書くこと）。
 *
 * testkit の fixture の側は `packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts`。
 * 接続断で落ちる件は #868（プロセスごと落ちる）で、ここでは扱わない。
 */

const ctx: Ctx = { tenantId: "store-write-atomicity" };
const TABLES = [
  "memories",
  "observations",
  "outbox",
  "memory_events",
  "labels",
  "memory_labels",
  "recalls",
  "recall_usages",
  "tenant_activity",
];
let seq = 0;

afterAll(async () => {
  await closeTestClient();
});

function event(memoryId: MemoryId, kind: NewMemoryEvent["kind"]): NewMemoryEvent {
  return { memoryId, kind, actor: { type: "system" }, meta: {} } as NewMemoryEvent;
}

const recallRecord = (text: string) =>
  ({
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
    advanceActivityClock: true,
  }) as never;

async function memory(store: PostgresMemoryStore, over: object = {}) {
  seq += 1;
  return store.createMemory(
    ctx,
    buildNewMemoryFixture({
      content: `content ${seq}`,
      contentHash: `hash-${seq}`,
      tags: [`tag-${seq}`],
      ...over,
    } as never),
  );
}

async function snapshotTables(): Promise<Record<string, string>> {
  const { pool } = await getTestClient();
  const out: Record<string, string> = {};
  for (const table of TABLES) {
    const { rows } = await pool.query<{ d: string }>(
      `SELECT count(*)::text || ':' || md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS d FROM ${table} x`,
    );
    out[table] = rows[0]!.d;
  }
  return out;
}

function changedTables(before: Record<string, string>, after: Record<string, string>): string[] {
  return TABLES.filter((table) => before[table] !== after[table]);
}

async function withFailingTrigger<T>(table: string, fn: () => Promise<T>): Promise<T> {
  const { pool } = await getTestClient();
  await pool.query(
    `CREATE OR REPLACE FUNCTION store_write_atomicity_fail() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'store-write-atomicity: injected failure on %', TG_TABLE_NAME; END $$`,
  );
  await pool.query(
    `CREATE TRIGGER store_write_atomicity_fail BEFORE INSERT OR UPDATE OR DELETE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION store_write_atomicity_fail()`,
  );
  try {
    return await fn();
  } finally {
    await pool.query(`DROP TRIGGER store_write_atomicity_fail ON ${table}`);
    await pool.query("DROP FUNCTION store_write_atomicity_fail()");
  }
}

/** 口の名前・失敗させる表・「準備して、撃つ関数を返す」・陽性対照で変わる表の数の下限（既定2）。 */
type Case = [string, string, (store: PostgresMemoryStore) => Promise<() => Promise<unknown>>, number?];

const CASES: Case[] = [
  [
    "createObservationWithOutbox",
    "outbox",
    async (s) => () =>
      s.createObservationWithOutbox(ctx, { kind: "utterance", payload: { text: "x" }, text: "x" } as never, ["extract"]),
  ],
  [
    "createMemoryWithOutbox",
    "outbox",
    async (s) => () =>
      s.createMemoryWithOutbox(ctx, buildNewMemoryFixture({ content: "new", contentHash: "new", tags: ["fresh"] } as never), [
        "embed",
      ]),
  ],
  [
    "updateStatusWithEvent",
    "memory_events",
    async (s) => {
      const m = await memory(s);
      return () => s.updateStatusWithEvent(ctx, m.id, "forgotten", { expectedStatus: "active" }, event(m.id, "forgotten"));
    },
  ],
  [
    "supersedeWithNewMemories",
    "memory_events",
    async (s) => {
      const old = await memory(s);
      return () =>
        s.supersedeWithNewMemories(
          ctx,
          [{ input: buildNewMemoryFixture({ content: "new", contentHash: "new", tags: ["fresh"] } as never), jobKinds: ["embed"] }],
          [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event: event(old.id, "superseded") }],
        );
    },
  ],
  [
    "purgeMemory",
    "memory_events",
    async (s) => {
      const m = await memory(s);
      await s.updateStatus(ctx, m.id, "forgotten");
      return () => s.purgeMemory(ctx, m.id, { content: "[purged]", digest: "[purged]" }, event(m.id, "purged"));
    },
  ],
  [
    "markContestedPair",
    "memory_events",
    async (s) => {
      const a = await memory(s);
      const b = await memory(s);
      return () => s.markContestedPair(ctx, { id: a.id, event: event(a.id, "updated") }, { id: b.id, event: event(b.id, "updated") });
    },
  ],
  [
    "resolveContestedPair",
    "memory_events",
    async (s) => {
      const a = await memory(s);
      const b = await memory(s);
      await s.markContestedPair(ctx, { id: a.id, event: event(a.id, "updated") }, { id: b.id, event: event(b.id, "updated") });
      return () =>
        s.resolveContestedPair(
          ctx,
          { id: a.id, status: "active", event: event(a.id, "updated") },
          { id: b.id, status: "superseded", supersededById: a.id, event: event(b.id, "superseded") },
        );
    },
  ],
  [
    "resolveOrphanedContested",
    "memory_events",
    async (s) => {
      const a = await memory(s);
      const b = await memory(s);
      await s.markContestedPair(ctx, { id: a.id, event: event(a.id, "updated") }, { id: b.id, event: event(b.id, "updated") });
      // 相手の側だけを contested の外へ出して、a を孤立させる（準備なので SQL で直接書く）。
      const { pool } = await getTestClient();
      await pool.query("UPDATE memories SET status = 'forgotten', contested_with_id = NULL WHERE id = $1", [b.id]);
      return () => s.resolveOrphanedContested(ctx, { id: a.id, contestedWithId: b.id, event: event(a.id, "updated") });
    },
  ],
  [
    "restoreSupersededBy",
    "memory_events",
    async (s) => {
      const anchor = await memory(s);
      for (let i = 0; i < 2; i++) {
        const m = await memory(s);
        await s.updateStatus(ctx, m.id, "superseded", { supersededById: anchor.id });
      }
      return () => s.restoreSupersededBy(ctx, anchor.id, { at: new Date() });
    },
  ],
  [
    "archiveDecayed",
    "memory_events",
    async (s) => {
      await memory(s);
      await memory(s);
      return () => s.archiveDecayed(ctx, { now: new Date("2999-01-01T00:00:00.000Z"), limit: 100 } as never);
    },
  ],
  [
    "purgeExpiredEvents",
    "memory_events",
    async (s) => {
      const m = await memory(s);
      await s.updateStatusWithEvent(ctx, m.id, "forgotten", { expectedStatus: "active" }, event(m.id, "forgotten"));
      // 削除の後に書く `events_purged` の INSERT で失敗させる——先に消した行が戻ること。
      return () => s.purgeExpiredEvents(ctx, { olderThan: new Date("2999-01-01T00:00:00.000Z"), limit: 1000 } as never);
    },
    // 書くのは memory_events だけ（古い行の DELETE と events_purged の INSERT）。
    1,
  ],
  [
    "recordUsageAndReinforce",
    "memories",
    async (s) => {
      const m = await memory(s);
      const recallId = await s.createRecall(ctx, recallRecord("q"));
      return () => s.recordUsageAndReinforce(ctx, recallId as RecallId, [m.id], new Date());
    },
  ],
  ["createRecall", "tenant_activity", async (s) => () => s.createRecall(ctx, recallRecord("q"))],
  [
    "requeueEmbedJobs",
    "outbox",
    async (s) => {
      await memory(s);
      return () => s.requeueEmbedJobs(ctx, { statuses: ["pending", "failed", "ready"], limit: 100 } as never);
    },
  ],
];

describe("PostgresMemoryStore: 複数の表に書く口は、途中で失敗すると書いた分を全部取り消す", () => {
  for (const [name, table, prepare, minTables = 2] of CASES) {
    it(`${name}（${table} への書き込みで失敗させる）`, async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const store = new PostgresMemoryStore(db);
      const call = await prepare(store);
      const before = await snapshotTables();
      await expect(withFailingTrigger(table, call)).rejects.toThrow();
      expect(changedTables(before, await snapshotTables())).toEqual([]);

      // 陽性対照: トリガー無しなら書く（既定では2つ以上の表に）。
      await call();
      expect(changedTables(before, await snapshotTables()).length).toBeGreaterThanOrEqual(minTables);
    });
  }

  describe("supersedeWithNewMemories: news の2件目が書けないとき、1件目も残さない", () => {
    for (const [label, bad] of [
      ["本文に NUL", { content: "bad\u0000" }],
      ["元の Observation が無い（外部キー）", { sourceObservationId: "00000000-0000-4000-8000-000000000000" as ObservationId }],
    ] as const) {
      it(label, async () => {
        await resetTestDatabase();
        const { db } = await getTestClient();
        const store = new PostgresMemoryStore(db);
        const old = await memory(store);
        const before = await snapshotTables();
        await expect(
          store.supersedeWithNewMemories(
            ctx,
            [
              { input: buildNewMemoryFixture({ content: "new 1", contentHash: "new-1", tags: ["fresh"] } as never), jobKinds: ["embed"] },
              { input: buildNewMemoryFixture({ content: "new 2", contentHash: "new-2", ...bad } as never), jobKinds: ["embed"] },
            ],
            [{ id: old.id, supersededByIndex: 0, expectedStatus: "active", event: event(old.id, "superseded") }],
          ),
        ).rejects.toThrow();
        expect(changedTables(before, await snapshotTables())).toEqual([]);
      });
    }
  });
});
