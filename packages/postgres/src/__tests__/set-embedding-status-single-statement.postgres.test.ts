import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #766 / ADR 0053「引き受けた負債」: `setEmbeddingStatus`
 * （`memory-store.ts` の `WITH updated AS (UPDATE ... RETURNING *) SELECT * FROM updated
 * UNION ALL SELECT ... WHERE NOT EXISTS (...)`）が**1文であること**は、今日の適合テスト
 * のどれでも守られていない——実測: この1文を「`UPDATE ... RETURNING *` → 0行なら別の
 * `SELECT`」の2文へ割る変異（ADR 0053 の Mu5a）を撃っても、`test:db` は1件も赤くならない。
 *
 * ## この歯が塞ぐもの・塞がないもの
 *
 * ADR 0053「引き受けた負債」が名指しした2つの要素——(1) テスト用の delay-injection
 * フック、(2) 「1文/2文で返す行のスナップショットが違う場合にどちらを返すべきか」という
 * ADR 0053 がしていない新しい判断——は、**この歯では採らない。** どちらも本体
 * （非テストコード）を変えることになり、ADR がまだ書いていない判断を要する。
 *
 * 代わりに、**DB へ実際に送られる文の数を数える形**（drizzle/pg クライアントの
 * `query()` 呼び出し回数）で、**「1文である」という形だけを固定する。**
 * ⟹ **Mu5a はこの歯で死ぬ**（2文に割ると呼び出し回数が2になる）。
 * ⟹ ⚠ **並行時にどちらのスナップショットを返すかは、この歯では一切断言しない。**
 * その判断はまだされていない（ADR 0053「引き受けた負債」）。
 */

const TENANT = "set-embedding-status-single-statement-tenant";
const ctx: Ctx = { tenantId: TENANT };

/**
 * `fn` を実行している間に、生の pg `Client.prototype.query` が呼ばれた回数とテキストを
 * 数える。
 *
 * ⚠ **`pool.query` ではなく `Client.prototype.query` をパッチする**理由は
 * `test-db.ts` の `captureClientQuery` と同じ（ADR 0284 の doc コメント参照）——
 * `pool.query()` 自身が内部で同じ `client.query()` を呼ぶ薄いラッパーなので、こちらを
 * 1箇所パッチすれば `db.transaction()` 経由・`pool.query()` 経由のどちらでも同じ場所で
 * 拾える。`setEmbeddingStatus` は `db.transaction()` を使わない単発の `db.execute()` だが、
 * drizzle の node-postgres アダプタが内部でどちらの経路を通っても崩れないように、
 * `captureClientQuery` と同じ観測点をあえて選ぶ。
 *
 * `captureClientQuery` と違い、こちらは「最後に一致した1件」ではなく**全呼び出しを
 * 数える**——形（文の数）そのものを固定したいので、1件だけを捕まえる形では測れない。
 */
async function countClientQueries(
  fn: () => Promise<unknown>,
): Promise<{ count: number; texts: string[] }> {
  const texts: string[] = [];
  const originalQuery = Client.prototype.query;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Client.prototype as any).query = function (this: Client, ...args: unknown[]) {
    const [config] = args as [string | { text: string }];
    const text = typeof config === "string" ? config : config.text;
    texts.push(text);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalQuery as any).apply(this, args);
  };
  try {
    await fn();
  } finally {
    Client.prototype.query = originalQuery;
  }
  return { count: texts.length, texts };
}

describe("setEmbeddingStatus は DB へ1文しか送らない（形の固定、Issue #766 / ADR 0053）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  it("🔴 巻き戻しが弾かれる経路（ready → failed を書こうとして0行更新→読み戻し）でも1文である", async () => {
    // ⚠ ここが Mu5a を殺す本体。ADR 0053 のガードで弾かれる更新は UPDATE が0行しか
    // 更新しないため、「0行なら別の SELECT で読み直す」という Mu5a の分岐が実際に
    // 通る唯一の経路である。成功する更新（下のテスト）では Mu5a の追加分岐そのものが
    // 実行されず、文の数の差が出ない。
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, contentHash: "single-statement-rollback" }),
    );
    await store.setEmbeddingStatus(ctx, memory.id, "ready");

    const { count, texts } = await countClientQueries(() =>
      store.setEmbeddingStatus(ctx, memory.id, "failed"),
    );

    // 前提: ガードは実際に効いている（'failed' への巻き戻しが弾かれ、'ready' のまま）。
    // ⚠ 並行時にどちらのスナップショットを返すかは、ここでも他のどこでも断言しない
    // ——判断していない。断言するのは「弾かれた」ことと「'ready' のまま」ことだけ。
    const result = await store.get(ctx, memory.id);
    expect(result?.embeddingStatus).toBe("ready");

    expect(count, `送られた文: ${JSON.stringify(texts)}`).toBe(1);
  });

  it("通常の更新経路（pending → ready）も1文である", async () => {
    // ⚠ Mu5a に対する捕獲力はこのテストには無い（上のコメント参照。成功する更新では
    // Mu5a の追加分岐が実行されないため、1文でも2文でも呼び出し回数は変わらない）。
    // それでも「今日は1文である」という形自体は固定しておく——将来、成功経路のほうを
    // 複数文へ割る変更が来たときに、この歯が最初に気付く場所になる。
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: TENANT, contentHash: "single-statement-normal" }),
    );

    const { count, texts } = await countClientQueries(() =>
      store.setEmbeddingStatus(ctx, memory.id, "ready"),
    );

    const result = await store.get(ctx, memory.id);
    expect(result?.embeddingStatus).toBe("ready");

    expect(count, `送られた文: ${JSON.stringify(texts)}`).toBe(1);
  });
});
