import { afterAll, describe, expect, it } from "vitest";
import { createExampleRuntime } from "../runtime-factory.js";
import { closeTestClient, getTestClient, requireDatabaseUrl } from "./test-db.js";

/**
 * `createExampleRuntime` は `createPostgresClient(databaseUrl)` で `Pool` を作った
 * **直後**に、`runMigrations` / `registerEmbeddingSpace` / `selectLexicalStoreMode` /
 * `PostgresTrigramLexicalStore.create` など、失敗しうる複数の非同期処理を経てから
 * ようやく `ExampleRuntimeHandle`（`close()` を持つ）を返す（`runtime-factory.ts`）。
 *
 * すべての呼び出し元（`cli.ts` の30箇所超）は
 * `const handle = await createExampleRuntime(...); try { ... } finally { await handle.close(); }`
 * という形——**`await createExampleRuntime(...)` 自体は `try` の外にある。**
 * ⟹ `createExampleRuntime` が `Pool` を作った後で reject すると、`handle` に一度も
 * 代入されないため、呼び出し側は `close()` を呼びようがない。**`Pool` を閉じる責務が
 * 誰にも渡らないまま、その `Pool` は開いたまま残る。**
 *
 * この歯は、`Pool` を実際に使い切った**後**（`runMigrations`/`registerEmbeddingSpace`
 * が成功し、advisory lock 用・マイグレーション用のコネクションが実際に張られた後）に
 * 起きる同期的な検証エラー（`MNEMORA_LEXICAL_STORE` の不正な値。`selectLexicalStoreMode`
 * が投げる）で reject させ、**Postgres 側から見て、その `Pool` のコネクションが
 * reject 直後もまだ生きているか**を `pg_stat_activity` で数える。
 *
 * 「まだ生きている」が観測されれば、それは `close()` を一度も呼べなかった `Pool` が
 * 開いたまま残っていることの直接証拠である（`Pool` はクライアント側の
 * `idleTimeoutMillis`（既定10秒）が過ぎるまで自発的に接続を切らない——
 * 呼び出し側が `pool.end()` するまで、Postgres 側にはコネクションが残り続ける）。
 */
describe("examples/chat: createExampleRuntime は Pool 構築後の失敗で Pool を閉じ忘れる（本物の Postgres）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("Pool を使い切った後の同期検証エラー（不正な MNEMORA_LEXICAL_STORE）で reject しても、Pool のコネクションが Postgres 側に残らない", async () => {
    // 間欠的な赤（Issue #974）を避けるため、この歯が作らせる
    // `Pool` の接続にだけ固有の `application_name` を付け、それだけを数える。以前は
    // 「自分以外の、同じ DB へのすべての接続」を数えていたため、autovacuum のワーカー等、
    // テスト対象と無関係な接続が before と after の間に現れるだけで赤になっていた。
    const applicationName = `mnemora-close-on-throw-${process.pid}-${Date.now()}`;
    const url = new URL(requireDatabaseUrl());
    url.searchParams.set("application_name", applicationName);
    const databaseUrl = url.toString();
    const { pool: sharedPool } = await getTestClient();

    const countPoolBackends = async (): Promise<number> => {
      const { rows } = await sharedPool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = $1",
        [applicationName],
      );
      return Number(rows[0]?.n ?? "0");
    };

    expect(await countPoolBackends()).toBe(0);

    await expect(
      createExampleRuntime(databaseUrl, {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
        // `runMigrations`/`registerEmbeddingSpace` が両方成功した**後**、
        // `selectLexicalStoreMode` がここで同期的に投げる（`runtime-factory.ts`）。
        MNEMORA_LEXICAL_STORE: "bogus-value-that-does-not-exist",
      }),
    ).rejects.toThrow(/MNEMORA_LEXICAL_STORE/);

    // `close()` が呼べていれば、reject した時点で `pool.end()` 済みのはずで、
    // 新たに増えたバックエンドは残らない。
    //
    // Issue #974（再オープン）: `pool.end()` が返るのはクライアント側がソケットを閉じた
    // 時点であり、Postgres 側で backend が終了して `pg_stat_activity` から消えるのは
    // その少し後になりうる。reject の直後に1回だけ数えると、閉じた Pool の接続が
    // まだ1本見えて赤になることがあった（CI で `expected 1 to be +0`）。そこで短い間隔で
    // 数え直し、0になるのを期限まで待つ。
    //
    // 🔴 **期限（BACKEND_EXIT_DEADLINE_MS）は、Pool の既定 `idleTimeoutMillis`（10秒）より
    // 十分短く保つこと。**閉じ忘れた Pool の接続は、`idleTimeoutMillis` が過ぎるまで
    // 自発的には切れない。期限がそれより短ければ、閉じ忘れは期限内に0にならず赤のまま残る
    // ——期限を延ばしすぎると、この歯は閉じ忘れを見逃す。
    const BACKEND_EXIT_DEADLINE_MS = 2_000;
    const BACKEND_EXIT_POLL_MS = 50;
    const deadline = Date.now() + BACKEND_EXIT_DEADLINE_MS;
    let remaining = await countPoolBackends();
    while (remaining > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, BACKEND_EXIT_POLL_MS));
      remaining = await countPoolBackends();
    }
    expect(remaining).toBe(0);
  });
});
