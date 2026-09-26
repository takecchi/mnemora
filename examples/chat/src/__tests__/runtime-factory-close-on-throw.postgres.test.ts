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
    const databaseUrl = requireDatabaseUrl();
    const { pool: sharedPool } = await getTestClient();

    const countOtherBackends = async (): Promise<number> => {
      const { rows } = await sharedPool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
      );
      return Number(rows[0]?.n ?? "0");
    };

    const before = await countOtherBackends();

    await expect(
      createExampleRuntime(databaseUrl, {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
        // `runMigrations`/`registerEmbeddingSpace` が両方成功した**後**、
        // `selectLexicalStoreMode` がここで同期的に投げる（`runtime-factory.ts`）。
        MNEMORA_LEXICAL_STORE: "bogus-value-that-does-not-exist",
      }),
    ).rejects.toThrow(/MNEMORA_LEXICAL_STORE/);

    // reject の直後（`Pool` 側の既定 `idleTimeoutMillis`＝10秒より十分前）に数える。
    // `close()` が呼べていれば、reject した時点で `pool.end()` 済みのはずで、
    // 新たに増えたバックエンドは残らない。
    const after = await countOtherBackends();

    // 他のファイルが残した idle な接続が、この間に idleTimeoutMillis で切れて減ることは
    // ありうる。増えていないことだけを見る。
    expect(after).toBeLessThanOrEqual(before);
  });
});
