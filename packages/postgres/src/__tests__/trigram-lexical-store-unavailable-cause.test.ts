import { describe, expect, it } from "vitest";
import type { Db } from "../client.js";
import {
  PostgresTrigramLexicalStore,
  TrigramLexicalStoreUnavailableError,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";

/**
 * [Issue #892](https://github.com/takecchi/mnemora/issues/892) の歯。
 *
 * ⚠ **DB を要求しない。** `probeTrigramLexicalSupport`/`PostgresTrigramLexicalStore.create`
 * が呼ぶ `db.execute` を、呼び出し順で応答を切り替える偽の `Db`（型だけ満たすスタブ、
 * 本物の接続を一切持たない）で差し替える——
 * `memory-store-contested-write-guard.test.ts` と同じ理由・同じ形。
 *
 * 検査していること: `CREATE EXTENSION IF NOT EXISTS pg_trgm` の発行（`db.execute` の
 * 3回目の呼び出し）が失敗したとき、
 * - `PostgresTrigramLexicalStore.create()` が投げる {@link TrigramLexicalStoreUnavailableError}
 *   の `.cause` が、元の Postgres エラーオブジェクトと**同一**であること（`extension_create_denied`/
 *   `extension_create_failed` の両方）。
 * - 公開の {@link probeTrigramLexicalSupport} の戻り値には、`cause` に相当する欄が
 *   一切漏れていないこと（`ok: false` の結果に `cause` キーが無いこと）。
 * - 値ベースの判定（`server_encoding_not_utf8`）で弾かれる経路は、そもそも Postgres の
 *   エラーオブジェクトを持たないため、`create()` が投げる例外の `.cause` は `undefined`
 *   のままであること（cause を持たせる対象が2つの reason に限られることの陽性対照）。
 */

type FakeDbOptions = {
  /** 3回目の呼び出し（CREATE EXTENSION）で投げるエラー。省略すると全呼び出しが成功する。 */
  extensionCreateError?: Error;
};

function createFakeDb(opts: FakeDbOptions = {}): Db {
  let call = 0;
  const execute = async (): Promise<{ rows: unknown[] }> => {
    call += 1;
    if (call === 1) {
      // SHOW server_encoding
      return { rows: [{ server_encoding: "UTF8" }] };
    }
    if (call === 2) {
      // pg_available_extensions
      return { rows: [{ present: 1 }] };
    }
    if (call === 3) {
      // CREATE EXTENSION IF NOT EXISTS pg_trgm
      if (opts.extensionCreateError) {
        throw opts.extensionCreateError;
      }
      return { rows: [] };
    }
    // word_similarity の自己一致検査
    return { rows: [{ score: 1 }] };
  };
  return { execute } as unknown as Db;
}

describe("TrigramLexicalStoreUnavailableError.cause（Issue #892、DB 不要）", () => {
  it("extension_create_denied: create() が投げる例外の .cause は元の Postgres エラーと同一である", async () => {
    const original = new Error("permission denied to create extension \"pg_trgm\"");
    const db = createFakeDb({ extensionCreateError: original });

    const thrown: unknown = await PostgresTrigramLexicalStore.create(db).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TrigramLexicalStoreUnavailableError);
    const err = thrown as TrigramLexicalStoreUnavailableError;
    expect(err.reason).toBe("extension_create_denied");
    expect(err.cause).toBe(original);
  });

  it("extension_create_failed: create() が投げる例外の .cause も元の Postgres エラーと同一である", async () => {
    const original = new Error("could not open extension control file");
    const db = createFakeDb({ extensionCreateError: original });

    const thrown: unknown = await PostgresTrigramLexicalStore.create(db).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TrigramLexicalStoreUnavailableError);
    const err = thrown as TrigramLexicalStoreUnavailableError;
    expect(err.reason).toBe("extension_create_failed");
    expect(err.cause).toBe(original);
  });

  it("陽性対照: server_encoding_not_utf8（値ベースの判定）は元々 Postgres エラーを持たないので .cause は undefined のままである", async () => {
    let call = 0;
    const db = {
      execute: async (): Promise<{ rows: unknown[] }> => {
        call += 1;
        if (call === 1) {
          return { rows: [{ server_encoding: "SQL_ASCII" }] };
        }
        throw new Error("この歯では呼ばれないはずの呼び出し");
      },
    } as unknown as Db;

    const thrown: unknown = await PostgresTrigramLexicalStore.create(db).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TrigramLexicalStoreUnavailableError);
    const err = thrown as TrigramLexicalStoreUnavailableError;
    expect(err.reason).toBe("server_encoding_not_utf8");
    expect(err.cause).toBeUndefined();
  });

  it("公開の probeTrigramLexicalSupport の戻り値には cause 欄が漏れていない", async () => {
    const original = new Error("permission denied to create extension \"pg_trgm\"");
    const db = createFakeDb({ extensionCreateError: original });

    const result = await probeTrigramLexicalSupport(db);

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("cause");
  });
});
