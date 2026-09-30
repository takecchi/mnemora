import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import * as schema from "../schema.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * [ADR 0395](../../../docs/decisions/0395-create-recall-activity-clock-single-statement.md):
 * `createRecall` の `advanceActivityClock` ありの分岐は、`recalls` の INSERT と活動カウンタの
 * UPSERT を **1つの SQL 文**（`WITH ... INSERT ... INSERT ...`）で撃つ。同じテナント（subject）への
 * 同時 createRecall がカウンタの行で直列になる時間を、往復2回分＋トランザクション開閉の分だけ
 * 短くするための変更で、意味は変えない。
 *
 * 2種類の歯:
 * - 意味の歯（変更前の実装でも緑。挙動を変えていないことを縛る）: 並列 N 件でカウンタ合計が
 *   ちょうど N（数え漏れ・二重計上なし）／返り値の id が書かれた行と一致／どちらの表への書き込みが
 *   失敗しても、もう片方も残らない。
 * - 形の歯（変更前は赤）: `recalls` を書く文が、カウンタ表にも触れる1文であること。
 */

const usage = {
  chars: 0,
  estimatedTokens: 0,
  counter: "heuristic",
  byTier: { full: 0, digest: 0, index: 0 },
  indexChars: 0,
};

const record = (
  ctx: Ctx,
  text: string,
  advanceActivityClock: true | { scope: "subject"; subjectId: string },
  subjectId: string | null = null,
) =>
  ({
    tenantId: ctx.tenantId,
    subjectId,
    query: { text },
    budget: null,
    omitted: [],
    usage,
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
    advanceActivityClock,
  }) as never;

afterAll(async () => {
  await closeTestClient();
});

const N = 24;

describe("createRecall（advanceActivityClock あり）: 1文にしても意味は変わらない", () => {
  it("tenant 単位: 並列 N 件を撃つと、カウンタはちょうど N、recalls は N 行、返った id は全部別で全部実在する", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const settings = new PostgresTenantSettingsStore(db);
    const ctx: Ctx = { tenantId: `single-stmt-t-${Date.now()}` };

    const ids = await Promise.all(
      Array.from({ length: N }, (_, i) => store.createRecall(ctx, record(ctx, `q${i}`, true))),
    );

    expect(new Set(ids).size).toBe(N);
    expect(await settings.getActivitySeq(ctx)).toBe(N);
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM recalls WHERE tenant_id = $1",
      [ctx.tenantId],
    );
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(await store.getRecall(ctx, ids[0]!)).not.toBeNull();
  });

  it("subject 単位: subject ごとに並列 N 件ずつ撃つと、各 subject のカウンタがちょうど N、tenant のカウンタは 0 のまま", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const settings = new PostgresTenantSettingsStore(db);
    const ctx: Ctx = { tenantId: `single-stmt-s-${Date.now()}` };

    const calls = ["alice", "bob"].flatMap((subjectId) =>
      Array.from({ length: N }, (_, i) =>
        store.createRecall(ctx, record(ctx, `q${i}`, { scope: "subject", subjectId }, subjectId)),
      ),
    );
    const ids = await Promise.all(calls);

    expect(new Set(ids).size).toBe(2 * N);
    expect(await settings.getActivitySeq(ctx)).toBe(0);
    expect(await settings.getSubjectActivitySeqs(ctx, ["alice", "bob"])).toEqual({
      alice: N,
      bob: N,
    });
  });

  it("advance なし（false）は、カウンタ表を一度も触らない（行を作らない）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: `single-stmt-off-${Date.now()}` };
    await store.createRecall(ctx, {
      ...(record(ctx, "q", true) as object),
      advanceActivityClock: false,
    } as never);
    const t = await pool.query("SELECT 1 FROM tenant_activity WHERE tenant_id = $1", [
      ctx.tenantId,
    ]);
    const s = await pool.query("SELECT 1 FROM tenant_subject_activity WHERE tenant_id = $1", [
      ctx.tenantId,
    ]);
    expect(t.rows).toHaveLength(0);
    expect(s.rows).toHaveLength(0);
  });

  it("recalls への書き込みが失敗すると、カウンタも進まない（tenant 単位・subject 単位）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: `single-stmt-fail-${Date.now()}` };
    await store.createRecall(ctx, record(ctx, "seed", true));
    await store.createRecall(ctx, record(ctx, "seed", { scope: "subject", subjectId: "alice" }));

    await pool.query(
      `CREATE OR REPLACE FUNCTION single_stmt_fail() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'single-stmt: injected failure'; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER single_stmt_fail BEFORE INSERT ON recalls
         FOR EACH ROW EXECUTE FUNCTION single_stmt_fail()`,
    );
    try {
      await expect(store.createRecall(ctx, record(ctx, "x", true))).rejects.toThrow();
      await expect(
        store.createRecall(ctx, record(ctx, "x", { scope: "subject", subjectId: "alice" })),
      ).rejects.toThrow();
    } finally {
      await pool.query("DROP TRIGGER single_stmt_fail ON recalls");
      await pool.query("DROP FUNCTION single_stmt_fail()");
    }

    const settings = new PostgresTenantSettingsStore(db);
    expect(await settings.getActivitySeq(ctx)).toBe(1);
    expect(await settings.getSubjectActivitySeqs(ctx, ["alice"])).toEqual({ alice: 1 });
  });
});

describe("createRecall（advanceActivityClock あり）: 形の歯 — recalls を書く文がカウンタ表にも触れる1文である", () => {
  it.each([
    ["tenant_activity", true as const],
    ["tenant_subject_activity", { scope: "subject" as const, subjectId: "alice" }],
  ])("%s: 撃った文は1本で、BEGIN/COMMIT を伴わない", async (counterTable, advance) => {
    await resetTestDatabase();
    const { pool } = await getTestClient();
    const logged: string[] = [];
    const db = drizzle(pool, {
      schema,
      logger: { logQuery: (query) => void logged.push(query) },
    });
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: `single-stmt-shape-${Date.now()}` };

    await store.createRecall(ctx, record(ctx, "q", advance));

    // 何を撃ったかが見えていること（ロガーが生きている）。
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.filter((q) => /insert\s+into\s+"?recalls"?/i.test(q))).toHaveLength(1);
    const insertRecall = logged.find((q) => /insert\s+into\s+"?recalls"?/i.test(q))!;
    expect(insertRecall).toMatch(new RegExp(`insert\\s+into\\s+${counterTable}\\b`, "i"));
    expect(logged).toHaveLength(1);
  });
});
