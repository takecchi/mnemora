import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * ADR 0142「確かめていないこと」を埋める歯:
 *
 * > **本物の並行**（複数プロセスが実際に同時にネットワーク越しで CAS な `UPDATE` を撃つ
 * > ときに「ちょうど1本だけ成功する」こと）は、この作業環境では検証していない。
 *
 * `packages/testkit/src/outbox-store-conformance.ts` の CAS の歯（`complete は attempts
 * が一致しないと OutboxLeaseConflictError を投げる`等）は、いずれも**逐次**に呼ぶ形
 * （先に片方を呼んで結果を見てから、もう片方を呼ぶ）であり、2接続から `Promise.all` で
 * 同時に撃つ形は無い。本ファイルは、**2本の独立した `pg.Pool`**（`createPostgresClient`
 * を2回呼び、それぞれ `max: 1` で1接続専用にする）から `complete`/`fail` を
 * `Promise.all` で同時に撃つ。
 *
 * ## 分かったこと（この歯を書く前に、使い捨てスクリプトで実測した）
 *
 * `expectedAttempts` が**同じ**（＝同じ claim 世代）2本の呼び出しを競わせたとき:
 *
 * | 組 | 結果 |
 * | --- | --- |
 * | `complete` + `complete` | **両方とも成功**（例外なし）。最終状態は `completed_at` のみ非 null。 |
 * | `fail` + `fail` | **両方とも成功**（例外なし）。最終状態は `failed_at` のみ非 null（`last_error` は後勝ち）。 |
 * | `complete` + `fail` | 🔴 **両方とも成功**（例外なし）。最終状態は `completed_at`/`failed_at` **両方**が非 null。 |
 *
 * ⟹ タスクの前提「ちょうど1本だけ成功する」は、**`complete`+`complete` と `fail`+`fail`
 * については正しい**（が、理由は「もう片方が CAS で弾かれるから」ではなく、**`interfaces/
 * outbox-store.ts` が明記する冪等性**——`UPDATE ... WHERE attempts = expectedAttempts`
 * は現在の `completed_at`/`failed_at` を見ないため、同じ `attempts` の呼び出しは
 * 常に「もう一度成功」する。2回目が投げないのは意図された契約であり、CAS の敗北ではない）。
 *
 * **`complete`+`fail` については前提が誤っている。** CAS の `WHERE` 節は
 * `attempts` だけを見て、**相手側の終端列**（`completed_at`/`failed_at`）を見ない
 * ため、同じ `attempts` を持つ `complete` と `fail` が競合すると、**両方成功し、
 * ADR 0142 が「直したはず」の矛盾した終端状態（`completed_at`/`failed_at` の両方が
 * 非 null）が別経路で再現する**。
 *
 * ⚠ **ただしこの経路は、現在の呼び出し元からは到達できない**（【現物】確認）。
 * - `packages/core/src/runtime.ts` の `tick()` は、1件のジョブについて `complete()` と
 *   `fail()` を**同じ `attempts` に対して同時に呼ぶことがない**——`handler` が成功すれば
 *   `complete()` だけ、例外を投げれば `catch` 節で `fail()` だけを呼ぶ、逐次・排他な形。
 * - 2つの独立した `tick()` 呼び出し（別ワーカー）が同じジョブを処理しうるのは、
 *   **`claimBatch` が `attempts` を1増やしてから**である（ADR 0032）——同じ `attempts`
 *   を2つの claim が同時に持つことは `claimBatch` の行ロックが構造的に防ぐ。
 * ⟹ **今回見つかった「両方成功」は、CAS の設計が防ぎ損ねている経路として実在するが、
 * この repo の現在の呼び出しパターンの下では無害（到達不能）である。** バグとして
 * 挙動を変える修正は、`complete`/`fail` の冪等性の契約（`interfaces/outbox-store.ts`
 * が明記）を壊さずに行うには「相手側の終端列も CAS の条件に含める」設計判断と、
 * その場合に何を投げるか（`OutboxLeaseConflictError` は `expectedAttempts !==
 * observedAttempts` を主張する型であり、`attempts` が一致するのに弾かれるこの新しい
 * ケースには意味が合わない）という新しい判断を要る——「挙動・公開 API を変えずに直せる
 * 明らかな誤り」ではないため、この歯はこの branch では**直さず、現状の挙動を固定する
 * characterization test として残す**。
 */
describe("PostgresOutboxStore.complete/fail — 本物の2接続での同時 CAS（ADR 0142 の確かめていないこと）", () => {
  const TENANT = `outbox-cas-concurrency-${randomUUID()}`;

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  /** claim 可能なジョブを1本 seed し、1度 claim して `expectedAttempts` を得る。 */
  async function seedClaimedJob(ctx: Ctx): Promise<{ jobId: string; attempts: number }> {
    const { pool, db } = await getTestClient();
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
       VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now(), 0, now())
       RETURNING id`,
      [ctx.tenantId],
    );
    const jobId = seeded.rows[0]?.id;
    if (jobId === undefined) throw new Error("seed 失敗");
    const store = new PostgresOutboxStore(db);
    const claimed = await store.claimBatch(ctx, {
      limit: 10,
      now: new Date(),
      claimedBy: "seed-claimer",
      leaseMs: 60_000,
    });
    const job = claimed.find((j) => j.id === jobId);
    if (job === undefined) throw new Error("claim 失敗");
    return { jobId, attempts: job.attempts };
  }

  /** 2本の独立した `pg.Pool`（各 `max: 1`）に対応する `PostgresOutboxStore` を作る。 */
  function twoIndependentStores(): {
    storeA: PostgresOutboxStore;
    storeB: PostgresOutboxStore;
    cleanup: () => Promise<void>;
  } {
    const clientA = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    const clientB = createPostgresClient(requireDatabaseUrl(), { max: 1 });
    return {
      storeA: new PostgresOutboxStore(clientA.db),
      storeB: new PostgresOutboxStore(clientB.db),
      cleanup: async () => {
        await closePostgresClient(clientA);
        await closePostgresClient(clientB);
      },
    };
  }

  async function readRow(jobId: string) {
    const { pool } = await getTestClient();
    const result = await pool.query<{
      completed_at: Date | null;
      failed_at: Date | null;
      last_error: string | null;
      attempts: number;
    }>(`SELECT completed_at, failed_at, last_error, attempts FROM outbox WHERE id = $1`, [jobId]);
    const row = result.rows[0];
    if (row === undefined) throw new Error("行が消えている");
    return row;
  }

  it("complete + complete を同時に撃つと、両方成功する（同じ attempts の再呼び出しは冪等、契約どおり）", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const { jobId, attempts } = await seedClaimedJob(ctx);
    const { storeA, storeB, cleanup } = twoIndependentStores();
    try {
      const results = await Promise.allSettled([
        storeA.complete(ctx, jobId, attempts),
        storeB.complete(ctx, jobId, attempts),
      ]);
      // 両方とも例外を投げない（interfaces/outbox-store.ts が明記する冪等性）。
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      const row = await readRow(jobId);
      expect(row.completed_at).not.toBeNull();
      expect(row.failed_at).toBeNull();
      expect(row.attempts).toBe(attempts);
    } finally {
      await cleanup();
    }
  });

  it("fail + fail を同時に撃つと、両方成功する（同じ attempts の再呼び出しは冪等、契約どおり）", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const { jobId, attempts } = await seedClaimedJob(ctx);
    const { storeA, storeB, cleanup } = twoIndependentStores();
    try {
      const results = await Promise.allSettled([
        storeA.fail(ctx, jobId, "error-from-A", attempts),
        storeB.fail(ctx, jobId, "error-from-B", attempts),
      ]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      const row = await readRow(jobId);
      expect(row.completed_at).toBeNull();
      expect(row.failed_at).not.toBeNull();
      // 後勝ち（どちらのメッセージが残るかは実行順で決まる非決定要素）。
      expect(["error-from-A", "error-from-B"]).toContain(row.last_error);
      expect(row.attempts).toBe(attempts);
    } finally {
      await cleanup();
    }
  });

  it("🔴 complete + fail（同じ attempts）を同時に撃つと、両方成功し、completed_at/failed_at の両方が非 null になる — CAS が防いでいない経路（現在の呼び出し元からは到達不能、ファイル冒頭の doc 参照）", async () => {
    const ctx: Ctx = { tenantId: TENANT };
    const { jobId, attempts } = await seedClaimedJob(ctx);
    const { storeA, storeB, cleanup } = twoIndependentStores();
    try {
      const results = await Promise.allSettled([
        storeA.complete(ctx, jobId, attempts),
        storeB.fail(ctx, jobId, "error-from-B", attempts),
      ]);
      // ⚠ タスクの前提（「ちょうど1本だけ成功する」）はここでは成立しない。
      // WHERE 節が `attempts` しか見ないため、両方が成功する。
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      const row = await readRow(jobId);
      // 🔴 矛盾した終端状態——ADR 0142 が別経路（stale attempts）で潰したはずの症状が、
      // 同じ attempts の complete/fail 競合という別経路で再現する。
      expect(row.completed_at).not.toBeNull();
      expect(row.failed_at).not.toBeNull();
    } finally {
      await cleanup();
    }
  });
});
