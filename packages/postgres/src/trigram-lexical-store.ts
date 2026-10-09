import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Ctx, LexicalFilter, LexicalHit, LexicalStore } from "@mnemora/core";
import { assertWellFormedCtx, assertWellFormedFilter } from "@mnemora/core";
import type { Db } from "./client.js";
import { omittingParams } from "./omit-params.js";
import { assertNoNul, assertNoNulInScopeFilter } from "./input-check.js";
import {
  TRIGRAM_JAPANESE_QUERY_MAX_CHARS,
  capLexicalQueryTotalChars,
  capLexicalQueryWords,
} from "./lexical-query-cap.js";
import { toPgTimestampClamped } from "./mapping.js";
import { isCreateExtensionPermissionDenied } from "./migration-failure-message.js";
import { EXTENSION_LOCK_KEY } from "./migrate.js";

/**
 * `LexicalStore` の **opt-in** 実装（ADR 0149 §6、ADR 0319）。`PostgresLexicalStore`（`./lexical-store.ts`）とは別の、
 * 導入側が明示的に選ぶ差し替えで、日本語（非 ASCII）の語彙照合に `pg_trgm` の `word_similarity` を使う。
 *
 * - `pg_trgm` は必須依存にしない。`REQUIRED_EXTENSIONS`（`./migrate.ts`）も `migrations/*.sql` も変えず、
 *   `CREATE EXTENSION` は {@link probeTrigramLexicalSupport} が**呼ばれたときだけ**（`PostgresTrigramLexicalStore.create()`
 *   で opt-in したときだけ）発行する。
 * - `buildLexicalSearchSelect` を呼ばず、フィルタ条件の組み立てを**複製している**。切り出すと既定の実装
 *   （`lexical-store.ts`）の diff が増え、既定を変えていないことの確認コストが上がるため。両者が将来ずれる負債を
 *   引き受けた（ADR 0319）。
 *
 * ## ASCII 部分の意味論
 *
 * ASCII の識別子（`PROJ-1234` 等）は `PostgresLexicalStore` と**同じ意味**で、`mnemora_lexical_query_or` /
 * `mnemora_lexical_normalize` / `mnemora_lexical_query_tsqueries`（`migrations/0008`/`0009`）をそのまま再利用する。
 * クエリが完全に ASCII のとき、`coverage`/`rank`/候補集合は `PostgresLexicalStore` と同じ値になる。
 *
 * ## 日本語（非 ASCII）部分の意味論
 *
 * クエリから非 ASCII の連なりを取り出し（`mnemora_trigram_query_nonascii`）、一部の機能語・語尾
 * （{@link TRIGRAM_NOISE_STOPWORD_PATTERN}）を取り除いた文字列を「日本語側の1項」として扱う。
 *
 * **ASCII 側の分母に日本語側の1項を足す形（分子/分母の拡張）にしない。**`PROJ-1234について前に何か言ってたはず` で、
 * `PostgresLexicalStore` は `coverage = 1`（ASCII 語1つが一致、分母1）を返すのに、日本語側の残り「前に何か言ってたはず」が
 * 語尾リストで削り切れずに残ると分母が増えて `coverage = 0.5` になる（日本語の残りを AND の一項にすると偽陰性だけを
 * 作る、というADR 0084 §2.1.1 と同じ現象の、分母の希釈という別の顔）。ADR 0084 §5 が similarity と lexicalMatch の
 * 合成に使った `affinity = max(...)` と同じ、max 合成にする。
 *
 * ```
 * hybridCoverage = GREATEST(
 *   coalesce(mnemora_lexical_coverage(content, query), 0),
 *   (日本語側の項が非空 AND word_similarity(項, content) >= threshold) ? 1 : 0
 * )
 * ```
 *
 * `mnemora_lexical_coverage`（`migrations/0009`）は**書き直さず、そのまま呼ぶ**。ASCII 側の計算式を独自に書くと
 * 「ASCII 部分は既存経路と同じ意味」が構造として保証されなくなるため。クエリが完全に ASCII のとき日本語側の項は無い
 * （`NULL`）ので `GREATEST(ascii側, 0)` になり、完全に日本語のときは ASCII 側が0で、一致すれば `1`、一致しなければ
 * `WHERE` を通らない（`LexicalHit.coverage` は常に `(0, 1]`）。両方に一致がある混在クエリは、高いほうが採用される
 * （二重に加点しない）。
 *
 * **素の `word_similarity` を使わない。**自然文の問い（「田中さんについて何か言ってましたか」）をそのまま渡すと、
 * 「について」「ました」「ですか」のような機能語がクエリのトライグラムの大半を占め、「田中さん」を含まない文にも高い
 * スコアが付いて、固定の閾値で切り分けられない（target 0.222 に対し noise 0.167・0.115）。{@link TRIGRAM_NOISE_STOPWORD_PATTERN}
 * で語尾・助詞を削ると target 0.400・noise 0.000 になる。
 * {@link DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD} の根拠はこの実測だけで、サンプル数は小さい（人手の4文+7 probe）。
 * 一般化を主張しない（ADR 0319）。
 *
 * **retrieval-quality の probe set（`examples/chat/src/probe-set.ts`）は、この緩和策をほぼ素通りする。**fact と query が
 * 内容語を共有しないよう設計されているので（`lexicalControl: true` の `color` 1件を除く）、この語彙チャンネルからは
 * 何も拾えない。`color` は fact/distractor の両方が「色」を含むため coverage が同点になり、順位を decay/freshness だけが
 * 決める（ADR 0084 §5.1/§8、ADR 0294）。
 *
 * ## 静かな0件を潰す
 *
 * `PostgresTrigramLexicalStore.create()` は、`pg_trgm` が (i) 拡張として使えるか、(ii) 現在の DB のロケール／
 * エンコーディングで日本語のトライグラムを実際に作れるかを確かめ、どちらかがダメなら
 * {@link TrigramLexicalStoreUnavailableError} を投げる。判定は {@link probeTrigramLexicalSupport} の戻り値
 * （{@link TrigramLexicalProbeResult}）として構造化された値でも手に入り、呼び出し側が例外の文字列を読まずに
 * 「なぜ使えないか」を分類できる。
 */

/**
 * `probeTrigramLexicalSupport` が「使えない」と判定したときの理由。
 *
 * - `"server_encoding_not_utf8"`: `SHOW server_encoding` が `UTF8` ではない（`SQL_ASCII`/`C` では `pg_trgm` 自体は
 *   `CREATE EXTENSION` できるが日本語を正しく格納できないので、早期に弾く。ADR 0103）。
 * - `"extension_unavailable"`: `pg_available_extensions` に `pg_trgm` が無い（contrib モジュールが未インストール）。
 * - `"extension_create_denied"`: `CREATE EXTENSION` が権限不足で失敗した。
 * - `"extension_create_failed"`: `CREATE EXTENSION` がそれ以外の理由で失敗した。
 * - `"locale_no_japanese_trigrams"`: 拡張は使えるが、**同一の日本語リテラル同士の `word_similarity` が 1 にならない**。
 *   `C` ロケールのクラスタで `pg_trgm` の日本語トライグラムが黙って空になる「静かな0件」を検出する（ADR 0084 §3.2）。
 * - `"extension_not_visible"`: `pg_trgm` は DB のどこかには存在するが、この接続の `search_path`
 *   （`current_schemas(true)`）から見えないスキーマに入っている（専用スキーマの構成で、別の名前空間が先に `pg_trgm` を
 *   作った場合）。`detail` に、拡張が実際に入っているスキーマ名を入れる。直すには、拡張の権限を持つロールで
 *   `ALTER EXTENSION pg_trgm SET SCHEMA <extensionSchema>` を実行する。`pg_trgm` をその名前空間の中に入れたまま
 *   `DROP SCHEMA <schema> CASCADE` すると、拡張ごと消える。
 */
export type TrigramLexicalUnavailableReason =
  | "server_encoding_not_utf8"
  | "extension_unavailable"
  | "extension_create_denied"
  | "extension_create_failed"
  | "locale_no_japanese_trigrams"
  | "extension_not_visible";

/** `pg_trgm` の前提の確認が通った結果。 */
export interface TrigramLexicalProbeOk {
  /** 常に `true`。 */
  readonly ok: true;
}

/** `pg_trgm` の前提の確認が通らなかった結果。 */
export interface TrigramLexicalProbeUnavailable {
  /** 常に `false`。 */
  readonly ok: false;
  /** 通らなかった理由（{@link TrigramLexicalUnavailableReason}）。機械判定はこの値で行う。 */
  readonly reason: TrigramLexicalUnavailableReason;
  /** 診断用の生の値・エラーメッセージ。人間が読むためのものであり、機械判定には `reason` を使うこと。 */
  readonly detail?: string;
}

/**
 * `probeTrigramLexicalSupport` の戻り値。「なぜ使えないか」を値として返す（投げるのは
 * {@link PostgresTrigramLexicalStore.create} の責務）。
 *
 * **「使えない」ことを値で返すのであって、この関数が一切 reject しないわけではない。**先頭の `SHOW server_encoding` と
 * `pg_available_extensions` の問い合わせは、失敗を握らずそのまま伝える。接続の失敗・権限の不足はここで reject する
 * （値の {@link TrigramLexicalProbeUnavailable} にはならない）。値になるのは、エンコーディングが UTF8 でない・拡張が
 * 入手できない・`CREATE EXTENSION` 以降で失敗した場合である。ヘルスチェックに使うときは、reject も「使えるか
 * 分からない」として扱うこと。
 */
export type TrigramLexicalProbeResult = TrigramLexicalProbeOk | TrigramLexicalProbeUnavailable;

/**
 * `extension_create_denied`/`extension_create_failed` のときだけ、元の Postgres エラーオブジェクトを運ぶ内部専用の拡張。
 * **export しない**（公開の {@link TrigramLexicalProbeResult} には `cause` を持たせない）。
 */
interface InternalTrigramLexicalProbeUnavailable extends TrigramLexicalProbeUnavailable {
  readonly cause?: unknown;
}

type InternalTrigramLexicalProbeResult =
  TrigramLexicalProbeOk | InternalTrigramLexicalProbeUnavailable;

/**
 * `PostgresTrigramLexicalStore.create()` が投げる例外の、メッセージの接頭辞。ADR 0084 §4.2 の
 * `LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX` と同じ作法だが、**同じ定数を再利用しない**。あちらは「`channels` に
 * `'lexical'` を要求したのに配線されていない」という配線の誤りで、こちらは「配線しようとしたが、拡張・ロケールの前提が
 * 満たせない」という別の失敗の族であるため。
 */
export const TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX =
  "PostgresTrigramLexicalStore.create: pg_trgm を日本語の語彙照合に使える状態ではありません: ";

/**
 * `PostgresTrigramLexicalStore.create()` が拡張・ロケールの前提を満たせなかったときに投げる例外。`reason`/`detail` は
 * {@link TrigramLexicalProbeUnavailable} と同じ形で保持し、`catch` した側が文字列を読まずに分岐できる。
 * `options?.cause` を渡すと、`Error` 標準の `cause` チェーンに乗る。
 *
 * **`advisory-lock.ts` の `AdvisoryLockTimeoutError`/`AdvisoryLockUnavailableError`（`cause` が必須の第2位置引数）には
 * 揃えない。**揃えると、`detail`（`string | undefined`）を第2引数に渡す既存の呼び出しが全て壊れる破壊的変更になる。
 * `options?: ErrorOptions` を任意の第3引数として足す形なら非破壊で済む。
 */
export class TrigramLexicalStoreUnavailableError extends Error {
  /** 通らなかった理由（{@link TrigramLexicalUnavailableReason}）。機械判定はこの値で行う。 */
  readonly reason: TrigramLexicalUnavailableReason;
  /** 診断用の生の値・エラーメッセージ（人間が読むためのもの）。無ければ `undefined`。 */
  readonly detail: string | undefined;

  constructor(reason: TrigramLexicalUnavailableReason, detail?: string, options?: ErrorOptions) {
    super(
      TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX + reason + (detail ? ` (${detail})` : ""),
      options,
    );
    this.name = "TrigramLexicalStoreUnavailableError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * 自己一致検査に使う固定の日本語リテラル。内容に意味は無く、`word_similarity(x, x)` が 1 になるかだけを見る。
 * ロケールが日本語のトライグラムを1つも作れない場合（`C` ロケール。ADR 0084 §3.2）は `show_trgm` が空集合になり、
 * 空集合同士の類似度は `pg_trgm` の定義上 0 になる（`SQL_ASCII`/`C` の DB では 0、`UTF8`/`C.UTF-8` では 1）。
 */
const JAPANESE_TRIGRAM_SELF_TEST_LITERAL = "田中さんが会議に参加します";

/** 自己一致検査で「1」とみなす下限。浮動小数の誤差のため、ちょうど1ではなく閾値で見る。 */
const SELF_SIMILARITY_OK_THRESHOLD = 0.99;

/**
 * `pg_trgm` が日本語の語彙照合に使える状態かどうかを確かめる。
 *
 * **副作用がある**: (ii) の検査の前提として `CREATE EXTENSION IF NOT EXISTS pg_trgm` を実際に発行する。呼ぶこと自体が
 * opt-in の意思表示で、呼ばれなければ `pg_trgm` は一切要求されない。
 *
 * 検査の順序（早い段階で弾けるものから）:
 * 1. `SHOW server_encoding` が `UTF8` か。
 * 2. `pg_available_extensions` に `pg_trgm` があるか。
 * 3. `CREATE EXTENSION IF NOT EXISTS pg_trgm` が成功するか。`pg_extension`/`pg_namespace` から `vector` 拡張
 *    （`runMigrations` が `extensionSchema` に入れたもの）のスキーマを引き、それが現在の `search_path` の先頭
 *    （`current_schema()`）と違うときだけ `WITH SCHEMA "<そのスキーマ>"` を付ける（専用スキーマの構成で、どの名前空間から
 *    呼んでも `pg_trgm` が `extensionSchema` に入り、全ての名前空間から見えるように）。`vector` が見つからない・
 *    スキーマが同じときは、SQL は `SCHEMA` を指定しない。
 * 4. 作った（または既にあった）`pg_trgm` が、この接続の `search_path`（`current_schemas(true)`）から見えるか
 *    （見えなければ `extension_not_visible`。素の `42883` は出さない）。
 * 5. 日本語リテラルの自己一致（`word_similarity(x, x) >= 0.99`）が成り立つか（ADR 0084 §3.2 の「`C` ロケールで
 *    黙って0件になる」を検出する本体）。
 *
 * この関数自身は、公開の {@link TrigramLexicalProbeResult}（`cause` を持たない）を返す薄いラッパーで、元の Postgres
 * エラーを運ぶのは export しない {@link probeTrigramLexicalSupportWithCause}（{@link PostgresTrigramLexicalStore.create}
 * が使う）のほうである。
 */
export async function probeTrigramLexicalSupport(db: Db): Promise<TrigramLexicalProbeResult> {
  const result = await withExtensionLock(db, (tx) => probeTrigramLexicalSupportWithCause(tx));
  if (result.ok) {
    return result;
  }
  // 公開の戻り値のオブジェクトに `cause` キーが漏れないよう、分割代入で明示的に取り除く。
  const { cause: _cause, ...publicResult } = result;
  return publicResult;
}

/**
 * `CREATE EXTENSION`・`CREATE OR REPLACE FUNCTION` は「在るか見る」と「作る」がアトミックではなく、別々の接続から
 * 同時に流すと 23505（`pg_extension_name_index`）や XX000（`tuple concurrently updated`）で落ちる。`body` を1つの
 * トランザクションに包み、先頭で `migrate.ts` の {@link EXTENSION_LOCK_KEY} の `pg_advisory_xact_lock` を取って
 * 直列にする（ADR 0430）。
 *
 * - **待ちに mnemora の上限は掛けない**（`lock_timeout` を敷かない・待ち時間切れの例外を足さない）。利用者の
 *   `lock_timeout` / `statement_timeout` は効く。
 * - `body` が返す結果（`ok: false` を含む）は、そのまま返す。`body` が投げれば、ロールバックされて同じ例外が出る。
 * - `CREATE EXTENSION` が失敗するとトランザクションは中断状態になる（25P02）。probe は失敗を値にしてすぐ返すので、
 *   以降の SQL は流れない。
 */
async function withExtensionLock<T>(db: Db, body: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${EXTENSION_LOCK_KEY.toString()}::bigint)`);
    return body(tx);
  });
}

/**
 * {@link probeTrigramLexicalSupport} の内部専用の実体。`extension_create_denied`/`extension_create_failed` のときは
 * 元の Postgres エラーオブジェクトを `cause` に載せて返す。**export しない。**
 */
async function probeTrigramLexicalSupportWithCause(
  db: Db,
): Promise<InternalTrigramLexicalProbeResult> {
  const encodingResult = await db.execute(sql`SHOW server_encoding`);
  const encodingRow = encodingResult.rows[0] as { server_encoding: string } | undefined;
  const encoding = encodingRow?.server_encoding ?? "(unknown)";
  if (encoding.toUpperCase() !== "UTF8") {
    return { ok: false, reason: "server_encoding_not_utf8", detail: encoding };
  }

  const availableResult = await db.execute(
    sql`SELECT 1 AS present FROM pg_available_extensions WHERE name = 'pg_trgm'`,
  );
  if (availableResult.rows.length === 0) {
    return { ok: false, reason: "extension_unavailable" };
  }

  try {
    // `vector` 拡張のスキーマが現在の `search_path` の先頭と違うときだけ、そこへ `WITH SCHEMA` で `pg_trgm` を入れる
    // （`probeTrigramLexicalSupport` の doc 手順3）。
    const vectorSchemaResult = await db.execute(sql`
      SELECT n.nspname AS ext_schema, current_schema() AS cur_schema
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'vector'
    `);
    const vectorSchemaRow = vectorSchemaResult.rows[0] as
      { ext_schema: string; cur_schema: string } | undefined;
    if (
      vectorSchemaRow !== undefined &&
      vectorSchemaRow.ext_schema !== vectorSchemaRow.cur_schema
    ) {
      // スキーマ名はカタログから読んだ値で、mnemora が検証した名前とは限らない。`assertSafeSchemaName` で弾くと
      // 今まで通っていた構成が `extension_create_failed` で落ちるので、弾かずに `sql.identifier` で識別子として埋め込む。
      await db.execute(
        sql`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA ${sql.identifier(vectorSchemaRow.ext_schema)}`,
      );
    } else {
      await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: isCreateExtensionPermissionDenied(err)
        ? "extension_create_denied"
        : "extension_create_failed",
      detail: message,
      // `TrigramLexicalStoreUnavailableError.cause` に渡すため、元の Postgres エラーを保持する。
      cause: err,
    };
  }

  // 見えなければ、拡張が実際に入っているスキーマ名を `detail` に入れて返す。ここで検出せずに次の自己一致検査へ進むと、
  // `word_similarity` が見えない DB の素の例外（42883）になる。
  const visibilityResult = await db.execute(sql`
    SELECT n.nspname AS ext_schema, n.nspname = ANY(current_schemas(true)) AS visible
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_trgm'
  `);
  const visibilityRow = visibilityResult.rows[0] as
    { ext_schema: string; visible: boolean } | undefined;
  if (visibilityRow === undefined || !visibilityRow.visible) {
    return {
      ok: false,
      reason: "extension_not_visible",
      detail: visibilityRow?.ext_schema,
    };
  }

  const selfSimilarityResult = await db.execute(
    sql`SELECT word_similarity(${JAPANESE_TRIGRAM_SELF_TEST_LITERAL}, ${JAPANESE_TRIGRAM_SELF_TEST_LITERAL}) AS score`,
  );
  const scoreRow = selfSimilarityResult.rows[0] as { score: number } | undefined;
  const score = Number(scoreRow?.score ?? 0);
  if (!(score >= SELF_SIMILARITY_OK_THRESHOLD)) {
    return { ok: false, reason: "locale_no_japanese_trigrams", detail: String(score) };
  }

  return { ok: true };
}

/** クエリから非 ASCII の連なりを取り出す（前後の ASCII は空白に落とし、trim する）。空なら `NULL`。`mnemora_lexical_query_terms` の**逆方向**。 */
const TRIGRAM_QUERY_NONASCII_FUNCTION_SQL = sql`
  CREATE OR REPLACE FUNCTION mnemora_trigram_query_nonascii(text) RETURNS text AS $$
    SELECT nullif(btrim(regexp_replace($1, '[[:ascii:]]+', ' ', 'g')), '');
  $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;
`;

/**
 * 自然文の質問に頻出する語尾・助詞を削る、**小さく非網羅的な**キュレーションリスト。形態素解析器ではない。
 * 増やすときは、実測（target の `word_similarity` が上がり、noise が下がること）を伴わせること。「日本語っぽい語尾を
 * 足す」だけでは分離が良くなる保証がない。
 */
export const TRIGRAM_NOISE_STOPWORD_PATTERN =
  "について|でしたか|ましたか|でしょうか|ませんか|ますか|ですか|ください|という|" +
  "かどうか|ですが|ました|きました|ています|でした|ですね|ますね|ません|なので|" +
  "けれど|でも|また|ところで|わたしの|私の|うちの|次の|どんな";

const TRIGRAM_STRIP_NOISE_FUNCTION_SQL = sql.raw(`
  CREATE OR REPLACE FUNCTION mnemora_trigram_strip_noise(text) RETURNS text AS $$
    SELECT nullif(btrim(regexp_replace($1, '(${TRIGRAM_NOISE_STOPWORD_PATTERN})', '', 'g')), '');
  $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;
`);

/**
 * ASCII 側（`mnemora_lexical_coverage`。**書き直さず、そのまま呼ぶ**）と日本語側（`mnemora_trigram_query_nonascii` +
 * `mnemora_trigram_strip_noise`）を `GREATEST` で混ぜる。分子/分母を足す形は採らない（モジュール冒頭の doc）。
 * `threshold` は GUC に頼らず引数で取る。
 *
 * **この関数は `ensureTrigramLexicalFunctions` で引き続きインストールするが、`buildTrigramLexicalSearchSelect` は
 * もう直接呼ばない。**`mnemora_lexical_coverage(content, query)` を候補行ごとに呼ぶと `query` の分解を行ごとに
 * やり直すため、同じ式を事前に1回だけ計算した配列を受け取る形にインライン展開している。この関数自体は互換のために
 * 残している。
 */
const TRIGRAM_HYBRID_COVERAGE_FUNCTION_SQL = sql`
  CREATE OR REPLACE FUNCTION mnemora_trigram_hybrid_coverage(content text, query text, threshold float8)
  RETURNS float8 AS $$
    SELECT GREATEST(
      coalesce(mnemora_lexical_coverage(content, query), 0),
      (CASE
        WHEN mnemora_trigram_strip_noise(mnemora_trigram_query_nonascii(query)) IS NOT NULL
         AND word_similarity(
               mnemora_trigram_strip_noise(mnemora_trigram_query_nonascii(query)),
               content
             ) >= threshold
        THEN 1 ELSE 0 END)
    )
  $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;
`;

/**
 * `PostgresTrigramLexicalStore` が使う SQL 関数をインストールする（`CREATE OR REPLACE FUNCTION`、冪等）。
 * `PostgresTrigramLexicalStore.create()` が内部で呼ぶので、呼び出し側が個別に呼ぶ必要は無い。`migrations/*.sql` には
 * 足さない。
 *
 * **索引は含まない。**`CREATE INDEX` は {@link createOptionalTrigramIndex} という別の口に分けてある。`memories` は
 * 行数が大きくなりうるので、索引の作成（`ShareLock` を取り、書き込みだけを止めうる）を関数のインストールと同じ
 * タイミングで強制しない。
 */
export async function ensureTrigramLexicalFunctions(db: Db): Promise<void> {
  // `CREATE OR REPLACE FUNCTION` も同時呼び出しでは XX000（`tuple concurrently updated`）で落ちるので、
  // {@link withExtensionLock} の中で流す（`create()` の中からは入れ子になるが、同じセッションの advisory lock は重ねて取れる）。
  await withExtensionLock(db, async (tx) => {
    await tx.execute(TRIGRAM_QUERY_NONASCII_FUNCTION_SQL);
    await tx.execute(TRIGRAM_STRIP_NOISE_FUNCTION_SQL);
    await tx.execute(TRIGRAM_HYBRID_COVERAGE_FUNCTION_SQL);
  });
}

/**
 * `memories.content` に `gin_trgm_ops` の GIN 索引を張る、**完全に任意の**性能向上策。呼ばなくても
 * {@link PostgresTrigramLexicalStore.search} は正しい結果を返す（Seq Scan になるだけ）。`WHERE` の日本語側の述語を
 * `content %> $ja` という pg_trgm の演算子の形にしてあり、この索引が無くても意味は変わらない。
 *
 * `CONCURRENTLY` は付けない（呼び出し側が自分のトランザクション管理に合わせて選べるよう、単純な `CREATE INDEX` にする）。
 * `CONCURRENTLY` 付きで張りたい呼び出し側のために {@link createOptionalTrigramIndexConcurrently} を別に用意している。
 */
export async function createOptionalTrigramIndex(db: Db): Promise<void> {
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_memories_trigram
      ON memories USING gin (tenant_id, content gin_trgm_ops)
      WHERE status IN ('active', 'contested')
  `);
}

/**
 * {@link createOptionalTrigramIndex} と**同じ形の索引**（名前・`gin (tenant_id, content gin_trgm_ops)`・
 * `WHERE status IN ('active', 'contested')`）を、`CREATE INDEX CONCURRENTLY` で張る。`memories` への書き込みを
 * 止めない（`ShareUpdateExclusiveLock`。素の版は `ShareLock` で書き込みを止める）。
 *
 * **トランザクションの外で呼ぶこと。**`CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` はトランザクション
 * ブロックの中では実行できない。`db` には `db.transaction(...)` の `tx` ではなく、プール由来の `Db` を渡す。
 * migration の経路には載せない。
 *
 * **前回の `CONCURRENTLY` が失敗・中断すると、`indisvalid = false` の索引が残る**（`IF NOT EXISTS` は名前だけを見るので、
 * 残ったまま何もせず返り、検索に使われない索引が居座る）。そこで、`memories` と同じスキーマに INVALID な
 * `idx_memories_trigram` が在れば `DROP INDEX CONCURRENTLY` で消してから作り直す。VALID な索引が既にあれば何もしない
 * （冪等）。
 *
 * **複数の呼び出し元が同時に呼んだときの競合（片方が DROP している間に他方が CREATE する等）は防いでいない。**
 */
export async function createOptionalTrigramIndexConcurrently(db: Db): Promise<void> {
  // `CREATE INDEX` は索引をテーブルと同じスキーマに作るので、`memories` と同じスキーマの `idx_memories_trigram` だけを見る。
  const invalid = await db.execute(sql`
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE i.indrelid = to_regclass('memories')
       AND c.relname = 'idx_memories_trigram'
       AND NOT i.indisvalid
  `);
  const row = invalid.rows[0] as { qualified_name: string } | undefined;
  if (row !== undefined) {
    // 名前は上の SELECT が `format('%I.%I')` で引用済み。
    await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${row.qualified_name}`));
  }
  await db.execute(sql`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_trigram
      ON memories USING gin (tenant_id, content gin_trgm_ops)
      WHERE status IN ('active', 'contested')
  `);
}

/** {@link PostgresTrigramLexicalStore} の既定の word_similarity 閾値。根拠はモジュール冒頭の doc（サンプル数は小さい）。 */
export const DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD = 0.3;

/**
 * `PostgresTrigramLexicalStore.search` が打つ `SELECT` を組み立てる。`buildLexicalSearchSelect` と同じ理由で本体から
 * 切り出してある（`EXPLAIN` の歯が同じ関数を使うため）。
 *
 * `WHERE` の各条件は `buildLexicalSearchSelect` と同じ形・同じ意味に揃えるが、`lexical-store.ts` のコードは import せず
 * 独立に書く（モジュール冒頭の doc）。`opts.ctxTenantId` も同じ欄・同じ意味。
 *
 * `threshold` は、日本語側の `WHERE` 述語（`content %> $ja`。`pg_trgm.word_similarity_threshold` セッション変数に依存）と
 * `coverage`/`rank` の計算（明示引数）の両方に使う。`search()` がトランザクション内で
 * `pg_trgm.word_similarity_threshold` を先に設定する（`set_config(…, true)`）ことが前提。
 *
 * **ASCII 側にだけ `capLexicalQueryWords` を通す。日本語側（`jaTerm`）には通さない。**`capLexicalQueryWords` は
 * 非 ASCII を落とす前提の関数で、日本語側に通すと日本語の語彙が消える。代わりに日本語側には別の文字数の上限
 * （{@link TRIGRAM_JAPANESE_QUERY_MAX_CHARS}）を `LEFT(...)` で直接掛ける。クエリ全体の文字数の上限は、ASCII 側・日本語側の
 * 両方に同じ1つの上限として効く（`lexical-query-cap.ts`）。
 *
 * `coverage` は `lexical-store.ts` と同じ理由で、`mnemora_lexical_query_tsqueries(asciiQuery)` を
 * `WITH qc AS MATERIALIZED (...)` で1回だけ計算し、`mnemora_trigram_hybrid_coverage` の本体と同じ形
 * （`GREATEST(ASCII側, 日本語側)`）にインライン展開して使う。`WHERE`/`rank` 側（`asciiTsQuery`/`jaTerm`）は `qc` を使わない
 * 形のままにする。`query` の具体的な値をプランナから見える形に保ち、`idx_memories_lexical`/`idx_memories_trigram` の選択を
 * 壊さないため（`LEFT(...)` も束縛パラメータだけに依存する IMMUTABLE な式で、他リレーションの列参照ではないので影響しない）。
 */
export function buildTrigramLexicalSearchSelect(
  query: string,
  opts: {
    limit: number;
    filter: LexicalFilter;
    threshold: number;
    ctxTenantId?: string | undefined;
  },
): SQL {
  // 全体の文字数の上限は、ASCII 側・日本語側の両方に、同じ1つの切り詰め結果として効かせる。
  const totalCappedQuery = capLexicalQueryTotalChars(query);
  const asciiQuery = capLexicalQueryWords(query);
  const conditions = [sql`TRUE`];
  if (opts.ctxTenantId !== undefined) {
    conditions.push(sql`tenant_id = ${opts.ctxTenantId}`);
  }
  if (opts.filter.status !== undefined) {
    conditions.push(sql`status = ANY(${sql.param(opts.filter.status)}::text[])`);
  }
  if (opts.filter.subjectId !== undefined) {
    conditions.push(
      opts.filter.includeSubjectless === true
        ? sql`(subject_id = ${opts.filter.subjectId} OR subject_id IS NULL)`
        : sql`subject_id = ${opts.filter.subjectId}`,
    );
  }
  if (opts.filter.attributes !== undefined) {
    conditions.push(sql`attributes @> ${JSON.stringify(opts.filter.attributes)}::jsonb`);
  }
  if (opts.filter.labels !== undefined) {
    conditions.push(sql`tags && ${sql.param(opts.filter.labels)}::text[]`);
  }
  if (opts.filter.occurredAfter !== undefined) {
    conditions.push(
      sql`COALESCE(occurred_at, recorded_at) >= ${toPgTimestampClamped(opts.filter.occurredAfter)}`,
    );
  }
  if (opts.filter.occurredBefore !== undefined) {
    conditions.push(
      sql`COALESCE(occurred_at, recorded_at) <= ${toPgTimestampClamped(opts.filter.occurredBefore)}`,
    );
  }
  if (opts.filter.validAt !== undefined) {
    conditions.push(
      sql`(valid_from IS NULL OR valid_from <= ${toPgTimestampClamped(opts.filter.validAt)}) AND (valid_until IS NULL OR valid_until > ${toPgTimestampClamped(opts.filter.validAt)})`,
    );
  }
  if (
    opts.filter.excludeProvenanceKinds !== undefined &&
    opts.filter.excludeProvenanceKinds.length > 0
  ) {
    conditions.push(
      sql`provenance_kind <> ALL(${sql.param(opts.filter.excludeProvenanceKinds)}::text[])`,
    );
  }

  const asciiTsQuery = sql`mnemora_lexical_query_or(${asciiQuery})`;
  // `mnemora_trigram_query_nonascii` には `query` でなく `totalCappedQuery` を渡す（日本語側にも全体の上限を効かせる）。
  // 抽出した非 ASCII の連なりに、`word_similarity` へ渡す前に `LEFT(...)` で別の文字数の上限をかけ、
  // `mnemora_trigram_strip_noise` は切り詰めた**後**の文字列に掛ける（上限に触れるとき、短い文字列に掛けるほうが軽い）。
  // この順序により、切り詰め境界のすぐ手前にノイズ語尾の一部が残ることがある（`strip_noise` は完全な語形を対象にし、
  // 途中で切れた断片は除去しない）。上限に触れるクエリでのみ起きる、引き受けた挙動である。
  const jaTerm = sql`mnemora_trigram_strip_noise(LEFT(mnemora_trigram_query_nonascii(${totalCappedQuery}), ${TRIGRAM_JAPANESE_QUERY_MAX_CHARS}))`;

  // ASCII 側は既存経路と同じ述語（式索引 `idx_memories_lexical` がそのまま選ばれる）。日本語側は pg_trgm の演算子形
  // （`content %> $ja`）。`createOptionalTrigramIndex` の GIN 索引がプランナに選ばれるのはこの演算子形のときだけで、
  // `word_similarity(...)` を関数として書くと索引は使われない。
  conditions.push(sql`(
    mnemora_lexical_tsvector(content) @@ ${asciiTsQuery}
    OR (${jaTerm} IS NOT NULL AND content %> ${jaTerm})
  )`);
  const whereClause = sql.join(conditions, sql` AND `);

  return sql`
    WITH qc AS MATERIALIZED (
      -- Issue #878: ASCII 側の語の分解（mnemora_lexical_query_tsqueries）を1回だけ
      -- 計算し、coverage の計算（下、候補行ごとに評価される）で使い回す。
      SELECT mnemora_lexical_query_tsqueries(${asciiQuery}) AS terms
    )
    SELECT
      id AS memory_id,
      -- mnemora_trigram_hybrid_coverage（このファイル冒頭付近）と同じ式
      -- （GREATEST(ASCII 側, 日本語側)）。ASCII 側は mnemora_lexical_coverage の式を、
      -- 上の qc で1回だけ計算した terms を受け取る形に書き直したもの
      -- （lexical-store.ts の buildLexicalSearchSelect と同じ形）。
      GREATEST(
        coalesce(
          (
            SELECT count(*) FILTER (
                     WHERE mnemora_lexical_tsvector(content) @@ tq
                   )::float8 / NULLIF(count(*), 0)
            FROM unnest(qc.terms) AS tq
          ),
          0
        ),
        (CASE
          WHEN ${jaTerm} IS NOT NULL AND word_similarity(${jaTerm}, content) >= ${opts.threshold}
          THEN 1 ELSE 0 END)
      ) AS coverage,
      (
        ts_rank_cd(
          mnemora_lexical_tsvector(content),
          ${asciiTsQuery},
          33
        )
        + coalesce(
            CASE WHEN ${jaTerm} IS NOT NULL THEN word_similarity(${jaTerm}, content) ELSE 0 END,
            0
          )
      ) AS rank
    FROM memories, qc
    WHERE ${whereClause}
    ORDER BY coverage DESC, rank DESC, recorded_at DESC, id
    LIMIT ${opts.limit}
  `;
}

/**
 * `LexicalStore` の pg_trgm 版 opt-in 実装。`PostgresLexicalStore` を置き換えるものではなく、**導入側が明示的に選ぶ
 * 差し替え**である（ADR 0084 §3.4）。
 *
 * 生成は必ず {@link PostgresTrigramLexicalStore.create} を経由すること。`new` を直接公開していないのは、静かな0件を
 * 作れないようにするため。
 *
 * `search` の `ORDER BY` は `PostgresLexicalStore` と同じ4段（`coverage DESC, rank DESC, recorded_at DESC, id`。ADR 0175）。
 * `rank` はこの adapter の内部でしか比較できない値（`LexicalHit.rank` の doc、ADR 0084 §5）で、ASCII の `ts_rank_cd` と
 * 日本語の `word_similarity` を単純に足しているだけであり、両者の尺度が本質的に同じという主張はしない。
 *
 * **`coverage` の尺度**: `GREATEST(ASCII 側, 日本語側)`。ASCII 側は `PostgresLexicalStore` と同じ 1/n 刻み。
 * **日本語側は `word_similarity(日本語の部分, content) >= threshold` なら 1、そうでなければ 0 の二値**で、日本語の複数語は
 * 語ごとに数えない（非 ASCII の連なり全体が1つの項）。`word_similarity` の値そのものは `coverage` に入らず、`rank` に入る。
 * ASCII の語がいくつあっても、日本語側が当たれば `coverage` は 1 になる。3つの store の対応は ADR 0553。
 */
export class PostgresTrigramLexicalStore implements LexicalStore {
  private constructor(
    private readonly db: Db,
    private readonly threshold: number,
  ) {}

  /**
   * `pg_trgm` の前提（拡張・ロケール）を確かめ、満たせなければ {@link TrigramLexicalStoreUnavailableError} を投げる。
   * 満たせれば、この store が使う SQL 関数（{@link ensureTrigramLexicalFunctions}）をインストールしてから返す。
   * **索引（{@link createOptionalTrigramIndex}）はここでは作らない**（呼び出し側が自分のタイミングで呼ぶ）。
   */
  static async create(
    db: Db,
    opts?: { threshold?: number | undefined },
  ): Promise<PostgresTrigramLexicalStore> {
    // probe の `CREATE EXTENSION` と関数のインストールを、1つのトランザクションの中で `EXTENSION_LOCK_KEY` の
    // advisory lock の下に置く（ADR 0430）。失敗（`ok: false`）は値で返してから、トランザクションの外で例外にする。
    const probe = await withExtensionLock(db, async (tx) => {
      const result = await probeTrigramLexicalSupportWithCause(tx);
      if (result.ok) {
        await ensureTrigramLexicalFunctions(tx);
      }
      return result;
    });
    if (!probe.ok) {
      // `probe.cause` が無いときは `options` を渡さない（`{ cause: undefined }` を常に渡すと、`"cause" in error` が
      // 意味もなく true になる）。
      throw new TrigramLexicalStoreUnavailableError(
        probe.reason,
        probe.detail,
        probe.cause !== undefined ? { cause: probe.cause } : undefined,
      );
    }
    const threshold = opts?.threshold ?? DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError(
        `PostgresTrigramLexicalStore.create: threshold は [0, 1] の有限数である必要がある（実際: ${threshold}）`,
      );
    }
    return new PostgresTrigramLexicalStore(db, threshold);
  }

  async search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedFilter(opts.filter, "opts.filter");
    assertNoNul("PostgresTrigramLexicalStore.search", "query", query);
    assertNoNulInScopeFilter("PostgresTrigramLexicalStore.search", opts.filter, "opts.filter");
    const threshold = this.threshold;
    // `content %> $ja` は `pg_trgm.word_similarity_threshold`（セッション変数）を読むので、`set_config(name, value, true)`
    // で、このトランザクションの中だけに効かせて設定する。設定と本体の SELECT は、同一トランザクション・同一接続で
    // 発行する必要がある。
    return omittingParams(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(threshold)}, true)`,
        );
        const select = buildTrigramLexicalSearchSelect(query, {
          ...opts,
          threshold,
          ctxTenantId: ctx.tenantId,
        });
        const result = await tx.execute(select);
        return result.rows.map((row) => {
          const r = row as unknown as { memory_id: string; coverage: number; rank: number };
          return { memoryId: r.memory_id, coverage: r.coverage, rank: r.rank };
        });
      }),
    );
  }
}
