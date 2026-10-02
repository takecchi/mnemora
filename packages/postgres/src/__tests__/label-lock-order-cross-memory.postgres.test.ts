import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, MemoryId, NewMemory } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0511（ADR 0476 の負債1・2）: 記憶をまたぐ `labels` の行ロックの順と、`purgeMemory`/`scrubPurged` の
 * `UPDATE labels … FROM counted` の更新順が、並行する書き込みと 40P01（`deadlock detected`）を起こさないこと。
 *
 * 歯の作り方（確実に起こす）: `labels` に「1行を更新（または挿入）するたびに 0.2 秒眠る」トリガを、
 * このテストの間だけ付ける。行ロックは眠っている間も掴んだままなので、
 * 「最初の1行を掴んで眠る → もう一方も別の1行を掴んで眠る → 互いの行を欲しがる」が、タイミングの運に
 * 頼らず毎回起こる。トリガは AFTER ROW なので、`INSERT … ON CONFLICT DO UPDATE` が行ロックを取った後に眠る。
 * 実装の SQL は一切変えない（歯は外から呼ぶだけ）。
 *
 * 見たいのは「落ちないこと」。直す前は赤である（ADR 0511 の「測ったこと」に実測を書く）。
 */
const SLEEP_FN = "adr0511_label_sleep";
const SLEEP_TRIGGER = "adr0511_label_sleep_trg";

async function installSleepTrigger(): Promise<void> {
  const { pool } = await getTestClient();
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${SLEEP_FN}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`);
  await pool.query(`DROP TRIGGER IF EXISTS ${SLEEP_TRIGGER} ON labels`);
  await pool.query(
    `CREATE TRIGGER ${SLEEP_TRIGGER} BEFORE UPDATE ON labels
       FOR EACH ROW EXECUTE FUNCTION ${SLEEP_FN}()`,
  );
}

async function removeSleepTrigger(): Promise<void> {
  const { pool } = await getTestClient();
  await pool.query(`DROP TRIGGER IF EXISTS ${SLEEP_TRIGGER} ON labels`);
  await pool.query(`DROP FUNCTION IF EXISTS ${SLEEP_FN}()`);
}

afterAll(async () => {
  await removeSleepTrigger();
  await closeTestClient();
});

beforeEach(async () => {
  await removeSleepTrigger();
  await resetTestDatabase();
});

/** 失敗の SQLSTATE（drizzle は pg のエラーを `cause` に包む）。落ちなければ空。 */
function failureCodes(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((r) => {
    if (r.status !== "rejected") return [];
    const e = r.reason as { code?: string; cause?: { code?: string } };
    return [
      e.cause?.code ?? e.code ?? `(no code) ${String((r.reason as Error).message).slice(0, 80)}`,
    ];
  });
}

describe("記憶をまたぐ upsertProposedLabels の順（ADR 0511 負債1）", () => {
  it("supersedeWithNewMemories: news の語彙の並びが逆の2つの呼び出しを同時に走らせても deadlock しない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "adr0511-supersede" };
    const build = (hash: string, tag: string): NewMemory =>
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: hash,
        content: hash,
        tags: [tag],
      });
    // 先に両方のラベルを作っておく（眠るトリガを入れる前。行ロックの取り合いだけを見る）。
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "seed",
        content: "seed",
        tags: ["a", "b"],
      }),
    );
    const olds: MemoryId[] = [];
    for (const i of [1, 2]) {
      olds.push(
        (
          await store.createMemory(
            ctx,
            buildNewMemoryFixture({
              tenantId: ctx.tenantId,
              contentHash: `old-${i}`,
              content: `old-${i}`,
            }),
          )
        ).id,
      );
    }
    const call = (n: number, first: string, second: string) =>
      store.supersedeWithNewMemories(
        ctx,
        [
          { input: build(`new-${n}-0`, first), jobKinds: [] },
          { input: build(`new-${n}-1`, second), jobKinds: [] },
        ],
        [
          {
            id: olds[n]!,
            supersededByIndex: 0,
            event: buildNewMemoryEventFixture({
              tenantId: ctx.tenantId,
              memoryId: olds[n]!,
              kind: "superseded",
            }),
          },
        ],
      );
    await installSleepTrigger();
    const results = await Promise.allSettled([call(0, "a", "b"), call(1, "b", "a")]);
    expect(failureCodes(results)).toEqual([]);
  }, 60_000);

  it("createMemoriesWithOutboxAndEvents: 語彙の並びが逆の2つの呼び出しで、deadlock も dropped も出ない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "adr0511-create-many" };
    const build = (hash: string, tag: string): NewMemory =>
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: hash,
        content: hash,
        tags: [tag],
      });
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "seed",
        content: "seed",
        tags: ["a", "b"],
      }),
    );
    const call = (n: number, first: string, second: string) =>
      store.createMemoriesWithOutboxAndEvents(
        ctx,
        [
          { input: build(`new-${n}-0`, first), jobKinds: [] },
          { input: build(`new-${n}-1`, second), jobKinds: [] },
        ],
        (memory) => buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: memory.id }),
      );
    await installSleepTrigger();
    const results = await Promise.allSettled([call(0, "a", "b"), call(1, "b", "a")]);
    expect(failureCodes(results)).toEqual([]);
    // ⚠ この口は候補ごとの SAVEPOINT で失敗を `dropped` に積む。deadlock は raw の例外ではなく
    // 「候補が黙って落ちる」形で現れうる（ADR 0511 の「測ったこと」）。
    const dropped = results.flatMap((r) => (r.status === "fulfilled" ? r.value.dropped : []));
    expect(
      dropped.map((d) => (d.error as { cause?: { code?: string } }).cause?.code ?? "(no code)"),
    ).toEqual([]);
    const written = results.flatMap((r) => (r.status === "fulfilled" ? r.value.written : []));
    expect(written).toHaveLength(4);
  }, 60_000);
});

describe("対照（眠るトリガ自体は deadlock を起こさない）", () => {
  it("同じ順 [a, b] で並行して作る2つの createMemoriesWithOutboxAndEvents は両方成功する", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "adr0511-control" };
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "seed",
        content: "seed",
        tags: ["a", "b"],
      }),
    );
    const call = (n: number) =>
      store.createMemoriesWithOutboxAndEvents(
        ctx,
        ["a", "b"].map((tag, i) => ({
          input: buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: `new-${n}-${i}`,
            content: `new-${n}-${i}`,
            tags: [tag],
          }),
          jobKinds: [],
        })),
        (memory) => buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: memory.id }),
      );
    await installSleepTrigger();
    const results = await Promise.allSettled([call(0), call(1)]);
    expect(failureCodes(results)).toEqual([]);
    const dropped = results.flatMap((r) => (r.status === "fulfilled" ? r.value.dropped : []));
    expect(dropped).toEqual([]);
  }, 60_000);
});

describe("purgeMemory・scrubPurged の UPDATE labels FROM counted の更新順（ADR 0511 負債2）", () => {
  const NAMES = Array.from({ length: 6 }, (_, i) => `n${i}`);

  /**
   * 隣り合う2語 `[n_k, n_{k+1}]` を持つ記憶の作成を5本。作成は名前順に `n_k` → `n_{k+1}` と掴む。
   * purge/scrub の `UPDATE labels … FROM counted` の更新順は名前順ではない（ハッシュ集約の順で、行の id
   * 次第。実測では `n0,n4,n5,n1,n2,n3` のような並びになる）。並びが昇順でない限り、値が隣り合う
   * どこかの組 `k, k+1` で purge の順が逆になるので、その組の作成と互いの行を欲しがる
   * （1/720 の確率で並びが昇順になれば起きないが、その回は赤にならない＝偽陰性側）。
   */
  function creates(store: PostgresMemoryStore, ctx: Ctx) {
    // purge/scrub が先に最初の行を掴んで眠っている間に作成が入るよう、100ms 遅らせて始める
    // （遅らせないと、作成が先に行を掴み、purge は何も掴まずに待つだけになって循環しない）。
    return NAMES.slice(0, -1).map(async (name, k) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: `concurrent-create-${k}`,
          content: `concurrent-create-${k}`,
          tags: [name, NAMES[k + 1]!],
        }),
      );
    });
  }

  async function seedForgottenWithAllLabels(store: PostgresMemoryStore, ctx: Ctx) {
    // テナントに語彙が多い状況にする。`labels` が小さいと、プランナは `idx_labels_by_status` の索引順（名前順）で
    // 行を更新し、作成の名前順と偶然そろって deadlock しない（実測: 6行だけのとき n0..n5 の昇順）。
    // 3000 行 + ANALYZE だと Hash Join になり、更新順はハッシュ順（実測: z01000,z00010,z02500,… で昇順でない）。
    const { pool } = await getTestClient();
    await pool.query(
      `INSERT INTO labels (id, tenant_id, name, status, proposed_count)
       SELECT gen_random_uuid(), $1, 'z' || lpad(i::text, 5, '0'), 'proposed', 1 FROM generate_series(1, 3000) i`,
      [ctx.tenantId],
    );
    await pool.query("ANALYZE labels");
    const old = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "to-purge",
        content: "to-purge",
        tags: NAMES,
      }),
    );
    await store.updateStatus(ctx, old.id, "forgotten");
    return old;
  }

  it("purgeMemory と、同じ6語を持つ記憶の作成を同時に走らせても deadlock しない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "adr0511-purge" };
    const old = await seedForgottenWithAllLabels(store, ctx);
    await installSleepTrigger();
    const results = await Promise.allSettled([
      store.purgeMemory(
        ctx,
        old.id,
        { content: "[p]", digest: "[p]" },
        buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: old.id, kind: "purged" }),
      ),
      ...creates(store, ctx),
    ]);
    expect(failureCodes(results)).toEqual([]);
  }, 60_000);

  it("scrubPurged と、同じ6語を持つ記憶の作成を同時に走らせても deadlock しない", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "adr0511-scrub" };
    const old = await seedForgottenWithAllLabels(store, ctx);
    // `scrubPurged` は purged 済みで memory_labels が残っている行だけを対象にする。
    // purged_at だけを立て、memory_labels と tags は残す（purge の途中状態の再現）。
    await db.execute(
      sql`UPDATE memories SET purged_at = now() WHERE tenant_id = ${ctx.tenantId} AND id = ${old.id}`,
    );
    await installSleepTrigger();
    const results = await Promise.allSettled([
      store.scrubPurged!(ctx, [old.id]),
      ...creates(store, ctx),
    ]);
    expect(failureCodes(results)).toEqual([]);
  }, 60_000);

  it("purgeMemory の先取りは無関係なラベルを塞がない（やりすぎ防止）: purge の間に、無関係なラベルの行ロックを待たずに取れる", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "adr0511-purge-unrelated" };
    const old = await seedForgottenWithAllLabels(store, ctx);
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "unrelated-seed",
        content: "unrelated-seed",
        tags: ["z00001"],
      }),
    );
    await installSleepTrigger();
    // purge は 6 行 x 0.2 秒眠り、その間 6 行の行ロックを持つ。無関係な既存ラベル（purge の対象外）の
    // 行ロックは、待たずに取れる。時間ではなくロックで見る: 作成の upsert が取るのと同じ行ロックを
    // `SET LOCAL lock_timeout`（短い値）つきで取りにいき、ロック待ちで 55P03 にならず成功すること。
    // 待たされるなら（purge が全ラベルを掴んでいるなら）、負荷に関わらず 55P03 になる。
    const purge = store.purgeMemory(
      ctx,
      old.id,
      { content: "[p]", digest: "[p]" },
      buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: old.id, kind: "purged" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { pool } = await getTestClient();
    const client = await pool.connect();
    let code: string | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '300ms'");
      try {
        const r = await client.query(
          "SELECT id FROM labels WHERE tenant_id = $1 AND name = $2 FOR UPDATE",
          [ctx.tenantId, "z00002"],
        );
        expect(r.rows).toHaveLength(1);
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await purge;
    expect(code).toBeUndefined();
  }, 60_000);
});
