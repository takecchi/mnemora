import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  captureClientQuery,
  closeTestClient,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `assertNotForgottenForUpdate`（`memory-store.ts`。`createMemoryWithOutbox`/`supersedeWithNewMemories` の
 * `opts.abortIfForgotten` が使う `SELECT … FOR UPDATE`）が、行ロックを **id 昇順**で取ること。
 *
 * `markContestedPair`/`resolveContestedPair`/`markContestedGroup` は `ORDER BY id ASC FOR UPDATE` で行ロックの
 * 順序を揃えている（`contested-pair-lock-order-concurrency.postgres.test.ts`）。この SELECT だけ `ORDER BY` が
 * 無いと、ロックを取る順序が実行計画（ふつうは heap の並び）に依存し、`consolidate` と `markContestedPair` が
 * 同じ行を逆順で掴み合って 40P01（`deadlock detected`）が生のまま漏れうる。
 *
 * 歯の作り方: 実装が実際に発行した SQL とパラメータを捕まえ、別の接続で同じ文を流して、**返ってくる行の順**
 * （`FOR UPDATE` の `LockRows` は行を掴んだ順に返す）が id 昇順であることを見る。タイミングに依存しない。
 * 行は id の並びと heap の並びが食い違うよう、ランダムな uuid を多めに積んで作る
 * （偶然に昇順で積まれる確率は 1/12! 未満）。
 */
describe("assertNotForgottenForUpdate — 行ロックを id 昇順で取る", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("実際に発行された SELECT … FOR UPDATE が、id 昇順で行を返す（掴む）", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const ctx: Ctx = { tenantId: "assert-not-forgotten-lock-order" };
    const ids: MemoryId[] = [];
    for (let i = 0; i < 12; i++) {
      const m = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `lock-order-${i}` }),
      );
      ids.push(m.id);
    }
    // 引数の並びも id 降順にして、呼び出し順に頼る実装でも昇順にならないようにする。
    const argIds = [...ids].sort().reverse();

    const captured = await captureClientQuery(
      (text) => /FOR UPDATE/i.test(text) && /status/i.test(text) && /memories/i.test(text),
      () =>
        store.createMemoryWithOutbox(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "lock-order-new" }),
          [],
          { abortIfForgotten: argIds },
        ),
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(captured.text, captured.params);
      await client.query("ROLLBACK");
      const returned = result.rows.map((r: { id: string }) => r.id);
      expect(returned).toHaveLength(ids.length);
      expect(returned).toEqual([...returned].sort());
    } finally {
      client.release();
    }
  });
});
