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
 * 4回目の呼び出し）が失敗したとき、
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
  /** 4回目の呼び出し（CREATE EXTENSION。1回目は ADR 0430 の advisory lock）で投げるエラー。省略すると全呼び出しが成功する。 */
  extensionCreateError?: Error;
};

function createFakeDb(opts: FakeDbOptions = {}): Db {
  let call = 0;
  const execute = async (): Promise<{ rows: unknown[] }> => {
    call += 1;
    if (call === 1) {
      // pg_advisory_xact_lock（ADR 0430。`create()`/probe は EXTENSION_LOCK_KEY の lock を先頭で取る）
      return { rows: [] };
    }
    if (call === 2) {
      // SHOW server_encoding
      return { rows: [{ server_encoding: "UTF8" }] };
    }
    if (call === 3) {
      // pg_available_extensions
      return { rows: [{ present: 1 }] };
    }
    if (call === 4) {
      // CREATE EXTENSION IF NOT EXISTS pg_trgm
      if (opts.extensionCreateError) {
        throw opts.extensionCreateError;
      }
      return { rows: [] };
    }
    // word_similarity の自己一致検査
    return { rows: [{ score: 1 }] };
  };
  const db = { execute } as unknown as { execute: typeof execute; transaction: unknown };
  db.transaction = async (cb: (tx: unknown) => Promise<unknown>) => cb(db);
  return db as unknown as Db;
}

describe("TrigramLexicalStoreUnavailableError.cause（Issue #892、DB 不要）", () => {
  it("extension_create_denied: create() が投げる例外の .cause は元の Postgres エラーと同一である", async () => {
    const original = Object.assign(new Error('permission denied to create extension "pg_trgm"'), {
      code: "42501",
      routine: "execute_extension_script",
    });
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
          return { rows: [] }; // pg_advisory_xact_lock（ADR 0430）
        }
        if (call === 2) {
          return { rows: [{ server_encoding: "SQL_ASCII" }] };
        }
        throw new Error("この歯では呼ばれないはずの呼び出し");
      },
      transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
    } as unknown as Db;

    const thrown: unknown = await PostgresTrigramLexicalStore.create(db).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TrigramLexicalStoreUnavailableError);
    const err = thrown as TrigramLexicalStoreUnavailableError;
    expect(err.reason).toBe("server_encoding_not_utf8");
    expect(err.cause).toBeUndefined();
  });

  it("公開の probeTrigramLexicalSupport の戻り値には cause 欄が漏れていない", async () => {
    const original = Object.assign(new Error('permission denied to create extension "pg_trgm"'), {
      code: "42501",
      routine: "execute_extension_script",
    });
    const db = createFakeDb({ extensionCreateError: original });

    const result = await probeTrigramLexicalSupport(db);

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("cause");
  });

  it("extension_create_denied は message でなく code/routine で決まる（lc_messages が英語以外でも同じ）", async () => {
    const original = Object.assign(new Error('拡張機能"pg_trgm"を作成する権限がありません'), {
      code: "42501",
      routine: "execute_extension_script",
    });
    const result = await probeTrigramLexicalSupport(
      createFakeDb({ extensionCreateError: original }),
    );

    expect(result).toMatchObject({ ok: false, reason: "extension_create_denied" });
  });

  it("drizzle が包んだ失敗（code/routine は cause 側）でも extension_create_denied になる", async () => {
    const pgError = Object.assign(new Error("permission denied to create extension"), {
      code: "42501",
      routine: "execute_extension_script",
    });
    const wrapped = new Error("Failed query: CREATE EXTENSION IF NOT EXISTS pg_trgm\nparams: ", {
      cause: pgError,
    });
    const result = await probeTrigramLexicalSupport(
      createFakeDb({ extensionCreateError: wrapped }),
    );

    expect(result).toMatchObject({ ok: false, reason: "extension_create_denied" });
  });

  it("message が権限不足に見えても、code/routine が違えば extension_create_failed（英語の message で判定しない）", async () => {
    const original = Object.assign(new Error("permission denied for schema public"), {
      code: "42501",
      routine: "aclcheck_error",
    });
    const result = await probeTrigramLexicalSupport(
      createFakeDb({ extensionCreateError: original }),
    );

    expect(result).toMatchObject({ ok: false, reason: "extension_create_failed" });
  });
});

type Step = { rows: unknown[] } | Error;

/**
 * `db.execute` の呼び出し順に、決めた応答（または例外）を返す偽の `Db`。順は
 * `probeTrigramLexicalSupport` が流す SQL の順：advisory lock・`SHOW server_encoding`・
 * `pg_available_extensions`・`vector` のスキーマの読み取り・`CREATE EXTENSION`・
 * `pg_trgm` の見え方・`word_similarity` の自己一致。
 */
function createSequencedDb(steps: readonly Step[]): Db {
  let call = 0;
  const execute = async (): Promise<{ rows: unknown[] }> => {
    const step = steps[call];
    call += 1;
    if (step === undefined) {
      throw new Error(`この歯では呼ばれないはずの ${call} 回目の呼び出し`);
    }
    if (step instanceof Error) {
      throw step;
    }
    return step;
  };
  const db = { execute } as unknown as { execute: typeof execute; transaction: unknown };
  db.transaction = async (cb: (tx: unknown) => Promise<unknown>) => cb(db);
  return db as unknown as Db;
}

const LOCK: Step = { rows: [] };
const UTF8: Step = { rows: [{ server_encoding: "UTF8" }] };
const TRGM_AVAILABLE: Step = { rows: [{ present: 1 }] };
const NO_VECTOR_SCHEMA: Step = { rows: [] };
const CREATE_OK: Step = { rows: [] };

describe("値ベースの判定で弾かれる理由は、cause を持たない（Issue #892、DB 不要）", () => {
  async function createAndCatch(db: Db): Promise<TrigramLexicalStoreUnavailableError> {
    const thrown: unknown = await PostgresTrigramLexicalStore.create(db).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(TrigramLexicalStoreUnavailableError);
    return thrown as TrigramLexicalStoreUnavailableError;
  }

  function expectNoCause(err: TrigramLexicalStoreUnavailableError): void {
    expect(err.cause).toBeUndefined();
    // 値が `undefined` なだけでなく、`cause` のキー自体が無い（`{ cause: undefined }` を
    // 渡すと、`in` が真になる）。
    expect("cause" in err).toBe(false);
    expect(Object.hasOwn(err, "cause")).toBe(false);
  }

  it("server_encoding_not_utf8", async () => {
    const err = await createAndCatch(
      createSequencedDb([LOCK, { rows: [{ server_encoding: "SQL_ASCII" }] }]),
    );
    expect(err.reason).toBe("server_encoding_not_utf8");
    expectNoCause(err);
  });

  it("extension_unavailable", async () => {
    const err = await createAndCatch(createSequencedDb([LOCK, UTF8, { rows: [] }]));
    expect(err.reason).toBe("extension_unavailable");
    expectNoCause(err);
  });

  it("extension_not_visible", async () => {
    const err = await createAndCatch(
      createSequencedDb([
        LOCK,
        UTF8,
        TRGM_AVAILABLE,
        NO_VECTOR_SCHEMA,
        CREATE_OK,
        { rows: [{ ext_schema: "other", visible: false }] },
      ]),
    );
    expect(err.reason).toBe("extension_not_visible");
    expectNoCause(err);
  });

  it("locale_no_japanese_trigrams", async () => {
    const err = await createAndCatch(
      createSequencedDb([
        LOCK,
        UTF8,
        TRGM_AVAILABLE,
        NO_VECTOR_SCHEMA,
        CREATE_OK,
        { rows: [{ ext_schema: "public", visible: true }] },
        { rows: [{ score: 0 }] },
      ]),
    );
    expect(err.reason).toBe("locale_no_japanese_trigrams");
    expectNoCause(err);
  });

  it("コンストラクタを2引数で呼んでも cause のキーは付かず、第3引数の cause はそのまま乗る", () => {
    const plain = new TrigramLexicalStoreUnavailableError("extension_unavailable", "detail");
    expect("cause" in plain).toBe(false);

    const original = new Error("元のエラー");
    const withCause = new TrigramLexicalStoreUnavailableError("extension_create_failed", "d", {
      cause: original,
    });
    expect(withCause.cause).toBe(original);
    expect(withCause.reason).toBe("extension_create_failed");
    expect(withCause.detail).toBe("d");
  });
});

describe("cause は捕まえたエラーそのものである（Issue #892、DB 不要）", () => {
  it("drizzle が包んだエラー（code/routine は入れ子の cause 側）でも、cause は包んだ外側のエラーそのもので、入れ子の cause は辿れる", async () => {
    const pgError = Object.assign(new Error("permission denied to create extension"), {
      code: "42501",
      routine: "execute_extension_script",
    });
    const wrapped = new Error("Failed query: CREATE EXTENSION IF NOT EXISTS pg_trgm\nparams: ", {
      cause: pgError,
    });

    const thrown: unknown = await PostgresTrigramLexicalStore.create(
      createFakeDb({ extensionCreateError: wrapped }),
    ).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TrigramLexicalStoreUnavailableError);
    const err = thrown as TrigramLexicalStoreUnavailableError;
    expect(err.reason).toBe("extension_create_denied");
    expect(err.cause).toBe(wrapped);
    expect((err.cause as Error).cause).toBe(pgError);
  });
});
