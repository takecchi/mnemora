import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Ctx, LexicalFilter, LexicalHit, LexicalStore } from "@mnemora/core";
import type { Db } from "./client.js";

/**
 * `LexicalStore` の **opt-in** 実装（[Issue #278](https://github.com/takecchi/mnemora/issues/278)、
 * [ADR 0149](../../../docs/decisions/0149-japanese-lexical-no-required-extension.md) §6、
 * ADR 0319）。
 *
 * ⚠ **この ADR/実装はクローン miku の判断であり、オーナー本人の判断ではない**
 * （[ADR 0220](../../../docs/decisions/0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
 * Issue #278 の棚卸しコメントは本件を「E: 判断が要る」（製品・事業判断を含みうる）と
 * 分類している。**この実装が答えているのは「opt-in なら足せるか」だけであり、
 * 「日本語の想起にどこまで投資するか」自体には答えていない。**
 *
 * ## 何を変えないか（⛔ 既定を変えない）
 *
 * - `PostgresLexicalStore`（`./lexical-store.ts`）は**1バイトも変えていない**。
 *   このファイルは新規ファイルであり、`buildLexicalSearchSelect` を呼ばず、
 *   フィルタ条件の組み立てロジックを独立に複製している（下記「なぜ複製するか」）。
 * - `REQUIRED_EXTENSIONS`（`./migrate.ts`）を変えていない。`pg_trgm` は必須依存にならない。
 * - `migrations/*.sql` に番号付きファイルを足していない——`pg_trgm` の `CREATE EXTENSION`
 *   は {@link probeTrigramLexicalSupport} が**呼ばれたときだけ**（＝導入側が明示的に
 *   `PostgresTrigramLexicalStore.create()` を呼んで opt-in したときだけ）発行される。
 *   `schema-namespace.test.ts` の `REQUIRED_EXTENSIONS` 突き合わせ歯は、
 *   `migrations/*.sql` の中身しか見ないため、この設計はその歯に触れない。
 *
 * ## なぜフィルタ条件の組み立てを複製するか
 *
 * `PostgresLexicalStore`（`./lexical-store.ts`）の `buildLexicalSearchSelect` は
 * `WHERE` 条件の組み立てとクエリ本体が一体になっており、再利用可能な形で切り出されて
 * いない。切り出すと `lexical-store.ts` の diff が増え、⛔「既定の実装を変えない」の
 * 確認コストが上がる（実際に挙動が変わっていないことをレビューする面積が広がる）。
 * **この PR ではファイルを触らない方を優先し、フィルタ条件を複製した。**
 * 複製の負債（両者が将来ずれる可能性）は引き受けた——ADR 0319「引き受けた負債」参照。
 *
 * ## ASCII 部分の意味論（`buildLexicalSearchSelect` と同じ）
 *
 * ASCII の識別子（`PROJ-1234` 等）に対する挙動は `PostgresLexicalStore` と**同じ意味**
 * である——`mnemora_lexical_query_or` / `mnemora_lexical_normalize` /
 * `mnemora_lexical_query_tsqueries`（`migrations/0008`/`0009`、常に導入されているベース
 * スキーマの一部）をそのまま再利用しており、隣接要求（`websearch_to_tsquery` のフレーズ
 * 演算子）・OR 意味論・被覆率の分子分母の数え方を書き換えていない。**⟹ クエリが完全に
 * ASCII のとき、`coverage`/`rank`/候補集合は `PostgresLexicalStore` と同じ値になる**
 * （`buildTrigramLexicalSearchSelect` の doc、および
 * `packages/postgres/src/__tests__/trigram-lexical-store.postgres.test.ts` の
 * 「ASCII 部分の意味論は既存経路と一致する」歯を見ること）。
 *
 * ## 日本語（非 ASCII）部分の意味論 — pg_trgm の word_similarity
 *
 * クエリから非 ASCII の連なりを取り出し（`mnemora_trigram_query_nonascii`）、
 * さらに一部の機能語・語尾（{@link TRIGRAM_NOISE_STOPWORD_PATTERN}）を取り除いた文字列を
 * 「日本語側の1項」として扱う。
 *
 * **🔴 最初の実装は ASCII 側の分母に日本語側の1項を足す形（ADR 0092 の分子/分母をそのまま
 * 拡張する形）にしていたが、変異試験ではなく `trigram-lexical-store.postgres.test.ts` の
 * ASCII パリティ歯そのものが赤くなって発覚した——「`PROJ-1234について前に何か言ってたはず`」
 * （Issue #106 の報告者の逐語、`buildTrigramLexicalSearchSelect` の doc/歯と同じ問い）で
 * `PostgresLexicalStore` は `coverage = 1`（ASCII 語1つが一致、分母1）を返すのに対し、
 * 最初の実装は日本語側の残り「前に何か言ってたはず」を分母に**追加してしまい**
 * `coverage = 0.5` になった。** 識別子の前後を囲む日本語の言い回しが、たまたま
 * {@link TRIGRAM_NOISE_STOPWORD_PATTERN} で削り切れずに残ると、それだけで ASCII 側の
 * coverage を薄めてしまう——**まさに [ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)
 * §2.1.1 が「日本語の残りを AND の一項にすると偽陰性だけを作る、落として失うものが無い」
 * と実測した現象の、別の顔（今回は AND ではなく分母の希釈）である。
 *
 * **⟹ 採用した式は「分子/分母を足す」ではなく、[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)
 * §5 が similarity と lexicalMatch を合成するのに使った `affinity = max(...)` と同じ
 * パターンである**（`recall.ts` の `affinity` の式を参照——掛けると片方が死んだ項になる、
 * 足すと薄まる。どちらも「合成する」を選んだ時点で決まる、という同じ教訓）。
 *
 * ```
 * hybridCoverage = GREATEST(
 *   coalesce(mnemora_lexical_coverage(content, query), 0),  -- ASCII 側。0009 の関数をそのまま呼ぶ
 *   (日本語側の項が非空 AND word_similarity(項, content) >= threshold) ? 1 : 0
 * )
 * ```
 *
 * **`mnemora_lexical_coverage` は `migrations/0009` の関数を1文字も変えずにそのまま呼ぶ**
 * ——ASCII 側の計算式を独自に書き直さないことで、「ASCII 部分は既存経路と同じ意味を保つ」
 * という制約を、テストで確認するだけでなく**構造として**保証する（同じ関数を呼んでいる
 * 以上、値がずれようがない）。
 *
 * **⟹ クエリが完全に ASCII のとき**: 日本語側の項は無い（`NULL`）ので第2引数は常に0。
 * `GREATEST(ascii側, 0) = ascii側`——`PostgresLexicalStore` と**完全に同じ値**になる。
 * **⟹ クエリが完全に日本語のとき**: ASCII 側は0（`mnemora_lexical_coverage` は語彙が
 * 無ければ `NULL`→`coalesce` で0）。一致すれば `coverage = max(0, 1) = 1`。一致しなければ、
 * その行はそもそも `WHERE` を通らない（`LexicalHit.coverage` は常に `(0, 1]` という契約
 * ——`interfaces/lexical-store.ts` の doc——を破らない）。
 * **⟹ 両方に本物の語彙一致がある混在クエリのとき**: 高いほうの値がそのまま採用される
 * （二重に加点しない）。
 *
 * ### 🔴 【実測】機能語のトライグラムが雑音になる — 素の word_similarity では役に立たない
 *
 * 自然文の問い「田中さんについて何か言ってましたか」をそのまま
 * `word_similarity(query, content)` に渡すと、「田中さん」を含まない文にも高いスコアが
 * 付く。手元の PostgreSQL 17.11（`initdb --locale=C.UTF-8 --encoding=UTF8`）で実測:
 *
 * | content | 素の word_similarity |
 * |---|---|
 * | target: `田中さんが来週から新しいプロジェクトに参加します`（田中さんを含む） | 0.222 |
 * | noise: `来週の予定について何も聞いていません`（田中さんを**含まない**） | 0.167 |
 * | noise: `先月のミーティングについて詳しく説明しました`（田中さんを**含まない**） | 0.115 |
 *
 * **⟹ target と noise の差はわずか 0.055〜0.107 しかなく、固定の閾値で安全に切り分けら
 * れない。**「について」「ました」「ですか」のような機能語が、クエリのトライグラムの
 * 大半を占めてしまうため（自然文の質問はほぼ機能語でできている）。
 *
 * ### ⟹ 緩和策: 小さく、非網羅的な語尾リストで機能語を削る
 *
 * {@link TRIGRAM_NOISE_STOPWORD_PATTERN} は、良く出る質問の語尾・助詞（「について」
 * 「ましたか」「でしょうか」等）を正規表現の選言で削るだけの、**キュレーションした
 * 固定リストであり、形態素解析器ではない。** 同じ実測環境で、削った後の
 * `word_similarity` は:
 *
 * | content | 語尾を削った後 |
 * |---|---|
 * | target（田中さんを含む） | **0.400** |
 * | noise（田中さんを含まない、2件とも） | **0.000** |
 *
 * **⟹ この実測4件だけを見れば、閾値 0.3 は target を通し noise を通さない。**
 * {@link DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD} をこの値にした根拠はこれだけであり、
 * **サンプル数は小さい（人手で作った4文+7 probe）。** 一般化を主張しない
 * （ADR 0319「確かめていないこと」参照）。
 *
 * ### ⚠ この緩和策は retrieval-quality の probe set をほぼ素通りする
 *
 * `examples/chat/src/probe-set.ts` の `PROBES` は、**意図的に** fact と query が内容語を
 * 共有しないように設計されている（`lexicalControl: true` の `color` 1件を除く）。
 * ⟹ 語尾を削っても、`color` 以外の6 probe は fact 側にも distractor 側にも一致する
 * 非 ASCII 語彙が実質無く、この語彙チャンネルからは何も拾えない
 * （[ADR 0294](../../../docs/decisions/0294-lexical-tie-density-bench.md) が ASCII 語彙
 * チャンネルについて既に測った「probe 7件の総候補数（合計）: 0」と同じ結論が、
 * この trigram チャンネルにも及ぶ）。**`color` 1件は fact/distractor の両方が「色」を
 * 含むため、coverage が同点になり、順位を決めるのは decay/freshness だけになる**
 * （ADR 0084 §5.1/§8 が ASCII 語彙で警告した「低選択率」と同じ形の負債）。
 * 詳細な数字は ADR 0319 §測定を見ること。
 *
 * ## 静かな0件を潰す — {@link probeTrigramLexicalSupport}
 *
 * `PostgresTrigramLexicalStore.create()` は、`pg_trgm` が (i) 拡張として使えるか、
 * (ii) 現在の DB のロケール／エンコーディングで日本語のトライグラムを実際に作れるか
 * を確かめ、どちらかがダメなら {@link TrigramLexicalStoreUnavailableError} を投げる。
 * 判定はこの関数の戻り値（{@link TrigramLexicalProbeResult}）として構造化された値でも
 * 手に入る——「なぜ使えないか」を呼び出し側が分類して扱えるようにするためであり、
 * 例外の文字列を読み取らせない。
 */

// ---------------------------------------------------------------------------
// 静かな0件を潰す — 拡張・ロケールの実行時検査
// ---------------------------------------------------------------------------

/**
 * `probeTrigramLexicalSupport` が「使えない」と判定したときの理由。
 *
 * - `"server_encoding_not_utf8"`: `SHOW server_encoding` が `UTF8` ではない
 *   （実測: `SQL_ASCII`/`C` エンコーディングでは pg_trgm 自体は `CREATE EXTENSION` できるが、
 *   日本語の文字列を正しく格納できないため、この段階で早期に弾く。
 *   [ADR 0103](../../../docs/decisions/0103-negative-tooth-declares-its-precondition.md)
 *   が `to_tsvector` について実測した「効いているのは `server_encoding` だけ」という
 *   軸を、この opt-in ストアの入口検査にも当てている）。
 * - `"extension_unavailable"`: `pg_available_extensions` に `pg_trgm` が無い
 *   （サーバーに contrib モジュールがインストールされていない）。
 * - `"extension_create_denied"`: `CREATE EXTENSION` が権限不足で失敗した。
 * - `"extension_create_failed"`: `CREATE EXTENSION` がそれ以外の理由で失敗した。
 * - `"locale_no_japanese_trigrams"`: 拡張は使えるが、**同一の日本語リテラル同士の
 *   `word_similarity` が 1 にならない**——[ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md)
 *   §3.2 が実測した「`C` ロケールのクラスタで `pg_trgm` の日本語トライグラムが黙って
 *   空になる」という「静かな0件」を、ここで検出する。
 */
export type TrigramLexicalUnavailableReason =
  | "server_encoding_not_utf8"
  | "extension_unavailable"
  | "extension_create_denied"
  | "extension_create_failed"
  | "locale_no_japanese_trigrams";

export interface TrigramLexicalProbeOk {
  readonly ok: true;
}

export interface TrigramLexicalProbeUnavailable {
  readonly ok: false;
  readonly reason: TrigramLexicalUnavailableReason;
  /** 診断用の生の値・エラーメッセージ。人間が読むためのものであり、機械判定には `reason` を使うこと。 */
  readonly detail?: string;
}

/**
 * `probeTrigramLexicalSupport` の戻り値。「なぜ使えないか」を値として返す
 * （投げるのは {@link PostgresTrigramLexicalStore.create} の責務であり、この関数自身は
 * 投げない——呼び出し側が判定だけを見たい場面（診断ツール・ヘルスチェック等）のために
 * 例外と値の両方の入口を用意する）。
 */
export type TrigramLexicalProbeResult = TrigramLexicalProbeOk | TrigramLexicalProbeUnavailable;

/**
 * `PostgresTrigramLexicalStore.create()` が投げる例外の、メッセージの接頭辞。
 *
 * [ADR 0084](../../../docs/decisions/0084-lexical-recall-channel.md) §4.2 の
 * `LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX` と**同じ作法**（呼び出し側と歯が、メッセージ
 * 文字列を書き写さずに識別できるようにするため）だが、**同じ定数を再利用してはいない**
 * ——あちらは「`channels` に `'lexical'` を要求したのに配線されていない」という**配線の
 * 誤り**を表し、こちらは「配線しようとしたが、拡張・ロケールの前提が満たせない」という
 * **別の失敗の族**である（ADR 0084 §4.2 の「埋め込み provider の失敗」と「`LexicalStore` の
 * 不在」の区別と同じ形——こちらは「実行時に一度だけ確かめれば分かる、環境の前提の不足」
 * であり、`recall()` を呼ぶたびに変わる類のものではない）。
 */
export const TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX =
  "PostgresTrigramLexicalStore.create: pg_trgm を日本語の語彙照合に使える状態ではありません: ";

/**
 * `PostgresTrigramLexicalStore.create()` が拡張・ロケールの前提を満たせなかったときに
 * 投げる例外。`reason`/`detail` は {@link TrigramLexicalProbeUnavailable} と同じ形で
 * 保持し、`catch` した側が文字列を読み取らずに分岐できるようにしてある。
 */
export class TrigramLexicalStoreUnavailableError extends Error {
  readonly reason: TrigramLexicalUnavailableReason;
  readonly detail: string | undefined;

  constructor(reason: TrigramLexicalUnavailableReason, detail?: string) {
    super(TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX + reason + (detail ? ` (${detail})` : ""));
    this.name = "TrigramLexicalStoreUnavailableError";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * 自己一致検査に使う固定の日本語リテラル。**内容に意味は無い**——`word_similarity(x, x)`
 * が 1 になるかどうかだけを見る。同じ文字列同士の一致なので、トライグラムの粒度が
 * バイト単位であろうと文字単位であろうと、正しく動いていれば必ず 1 になる
 * （逆に、ロケールが日本語のトライグラムを1つも作れない場合——ADR 0084 §3.2 の `C`
 * ロケール——は `show_trgm` が空集合になり、空集合同士の類似度は `pg_trgm` の定義上 0 に
 * なる。**実測（この PR の作業者が手元の PostgreSQL で確認、下記「測定条件」参照）**:
 * `SQL_ASCII`/`C` の DB で `word_similarity('田中さんが会議に参加します',
 * '田中さんが会議に参加します')` は **0**、`UTF8`/`C.UTF-8` では **1**）。
 */
const JAPANESE_TRIGRAM_SELF_TEST_LITERAL = "田中さんが会議に参加します";

/** 自己一致検査で「1」とみなす下限。浮動小数の誤差のためちょうど1ではなく閾値で見る。 */
const SELF_SIMILARITY_OK_THRESHOLD = 0.99;

function isPermissionDenied(message: string): boolean {
  return /permission denied|must be (owner|superuser)|insufficient privilege/i.test(message);
}

/**
 * `pg_trgm` が日本語の語彙照合に使える状態かどうかを確かめる。
 *
 * **副作用がある**: (ii) の検査の前提として `CREATE EXTENSION IF NOT EXISTS pg_trgm` を
 * 実際に発行する。これは「呼ぶこと自体が opt-in の意思表示である」という設計
 * （このファイル冒頭の doc）に基づく——呼ばれなければ `pg_trgm` は一切要求されない。
 *
 * 検査の順序（早い段階で弾けるものから）:
 * 1. `SHOW server_encoding` が `UTF8` か。
 * 2. `pg_available_extensions` に `pg_trgm` があるか。
 * 3. `CREATE EXTENSION IF NOT EXISTS pg_trgm` が成功するか。
 * 4. 日本語リテラルの自己一致（`word_similarity(x, x) >= 0.99`）が成り立つか
 *    （ADR 0084 §3.2 の「`C` ロケールで黙って0件になる」を検出する本体）。
 */
export async function probeTrigramLexicalSupport(db: Db): Promise<TrigramLexicalProbeResult> {
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
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: isPermissionDenied(message) ? "extension_create_denied" : "extension_create_failed",
      detail: message,
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

// ---------------------------------------------------------------------------
// SQL 関数のインストール（番号付き migration ではなく、opt-in の別口。Issue #278）
// ---------------------------------------------------------------------------

/**
 * クエリから非 ASCII の連なりを取り出す（前後の ASCII は空白に落とし、trim する）。
 * `mnemora_lexical_query_terms`（`migrations/0008`、非 ASCII を落として ASCII だけ残す）の
 * **逆方向**。空になれば SQL の `NULL` を返す——「非 ASCII 側の項が無い」を表す。
 */
const TRIGRAM_QUERY_NONASCII_FUNCTION_SQL = sql`
  CREATE OR REPLACE FUNCTION mnemora_trigram_query_nonascii(text) RETURNS text AS $$
    SELECT nullif(btrim(regexp_replace($1, '[[:ascii:]]+', ' ', 'g')), '');
  $$ LANGUAGE sql IMMUTABLE PARALLEL SAFE;
`;

/**
 * 自然文の質問に頻出する語尾・助詞を削る、**小さく非網羅的な**キュレーションリスト。
 * 形態素解析器ではない——見つかった具体的な語を正規表現の選言で並べているだけである。
 *
 * 選定根拠: このファイル冒頭の doc「🔴 【実測】機能語のトライグラムが雑音になる」の実測に
 * 使った質問文（`examples/chat/src/probe-set.ts` の `PROBES` の `query` を含む）から、
 * 削ると target/noise の分離が改善した語を採った。**このリストを増やしたいときは、
 * 実測（target の word_similarity が上がり、noise が下がること）を伴わせること**——
 * 「日本語っぽい語尾を足す」だけでは分離が良くなる保証がない。
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
 * ASCII 側（`mnemora_lexical_coverage`、`migrations/0009`。常設のベーススキーマの関数を
 * **そのまま呼ぶ**、書き直さない）と日本語側（`mnemora_trigram_query_nonascii` +
 * `mnemora_trigram_strip_noise`、上記2関数）を `GREATEST`（affinity と同じ max 合成、
 * ADR 0084 §5）で混ぜる。**分子/分母を足す形は採らなかった**——このファイル冒頭の doc
 * 「日本語（非 ASCII）部分の意味論」の「🔴 最初の実装は…」を見ること（ASCII パリティの
 * 歯が実際に赤くなって発覚した）。
 *
 * `threshold` を引数に取る（GUC に頼らない）——このファイルの外から呼ばれる場合にも
 * 閾値の受け渡しが明示的になる。
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
 * `PostgresTrigramLexicalStore` が使う SQL 関数をインストールする（`CREATE OR REPLACE
 * FUNCTION`、冪等）。`PostgresTrigramLexicalStore.create()` が内部で呼ぶ——呼び出し側が
 * 個別に呼ぶ必要は無い。`migrations/*.sql` には**足していない**（このファイル冒頭の doc
 * 「何を変えないか」参照）。
 *
 * **索引は含まない。**`CREATE INDEX` は {@link createOptionalTrigramIndex} という別の口に
 * 分けてある——`memories` は行数が大きくなりうるため（`docs/roadmap.md` §5）、索引の作成
 * （`ACCESS EXCLUSIVE` ロックを伴いうる）を関数のインストールと同じタイミングで強制しない
 * （`migrations/0008_memories_lexical_index.sql` が生成列を避けた理由と同じ配慮）。
 */
export async function ensureTrigramLexicalFunctions(db: Db): Promise<void> {
  await db.execute(TRIGRAM_QUERY_NONASCII_FUNCTION_SQL);
  await db.execute(TRIGRAM_STRIP_NOISE_FUNCTION_SQL);
  await db.execute(TRIGRAM_HYBRID_COVERAGE_FUNCTION_SQL);
}

/**
 * `memories.content` に `gin_trgm_ops` の GIN 索引を張る、**完全に任意の**性能向上策。
 *
 * 呼ばなくても {@link PostgresTrigramLexicalStore.search} は正しい結果を返す
 * （Seq Scan になるだけ）——`WHERE` の日本語側の述語は `content %> $ja` という pg_trgm の
 * 演算子の形にしてあり（`buildTrigramLexicalSearchSelect` 参照）、この索引が無くても
 * 意味は変わらない。
 *
 * 【実測】手元の PostgreSQL 17.11（20,000行、`content` にクエリ語を含む行が1行だけの
 * 表）で、この索引と同じ形（`USING gin (tenant_id, content gin_trgm_ops)`）を張り、
 * `SET pg_trgm.word_similarity_threshold = 0.3` の下で
 * `... WHERE tenant_id = $1 AND status IN ('active','contested') AND content %> $2` を
 * `EXPLAIN` すると、`Bitmap Index Scan` が選ばれることを確認した（`tenant_id`/`content`
 * の両方が `Index Cond` に入る）。**索引が無い場合との実行時間の比較（`EXPLAIN ANALYZE`）は
 * 測っていない**——プランがビットマップ索引スキャンに変わることまでは実測したが、
 * 秒単位の速度差は確かめていない（ADR 0319「確かめていないこと」）。
 *
 * `CONCURRENTLY` は付けない——`packages/postgres` の migration がトランザクション内で
 * 各ファイルを実行するのと同じ理由がここにも当たる可能性があるため、呼び出し側が
 * 自分のトランザクション管理に合わせて選べるよう、単純な `CREATE INDEX` にしてある。
 * 大きな `memories` に対して実行する場合は、呼び出し側が `CONCURRENTLY` 付きの索引を
 * 別途自分で組み立てることもできる——この関数はあくまで「動く最小形」を提供するだけで
 * あり、唯一の経路として使うことを強制しない。
 */
export async function createOptionalTrigramIndex(db: Db): Promise<void> {
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_memories_trigram
      ON memories USING gin (tenant_id, content gin_trgm_ops)
      WHERE status IN ('active', 'contested')
  `);
}

// ---------------------------------------------------------------------------
// search() の SELECT 組み立て
// ---------------------------------------------------------------------------

/** {@link PostgresTrigramLexicalStore} の既定の word_similarity 閾値。根拠はこのファイル冒頭の doc「⟹ 緩和策」を見ること。 */
export const DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD = 0.3;

/**
 * `PostgresTrigramLexicalStore.search` が打つ `SELECT` を組み立てる。
 * `PostgresLexicalStore`（`./lexical-store.ts`）の `buildLexicalSearchSelect` と
 * 同じ理由で本体から切り出してある（`EXPLAIN` の歯が同じ関数を使うため）。
 *
 * `WHERE` の各条件は `buildLexicalSearchSelect` と**同じ形・同じ意味**に揃えている
 * （`LexicalFilter` の doc「`VectorFilter` と同じ絞りを、同じ意味で持つ」の推移律）。
 * ただし、このファイル冒頭の doc「なぜフィルタ条件の組み立てを複製するか」の通り、
 * `lexical-store.ts` のコードは1行も import せず、独立に書いている。
 *
 * `threshold` は呼び出しの都度指定できる（`PostgresTrigramLexicalStore` のコンストラクタで
 * 固定した値を渡す）。同じ値を、日本語側の `WHERE` 述語（`content %> $ja`、
 * `pg_trgm.word_similarity_threshold` セッション変数に依存）と `coverage`/`rank` の計算
 * （明示引数）の両方に使う——`search()` がトランザクション内で
 * `SET LOCAL pg_trgm.word_similarity_threshold` を先に発行することが前提
 * （`PostgresTrigramLexicalStore.search` 参照）。
 */
export function buildTrigramLexicalSearchSelect(
  query: string,
  opts: { limit: number; filter: LexicalFilter; threshold: number },
): SQL {
  const conditions = [sql`tenant_id = ${opts.filter.tenantId}`];
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
  if (opts.filter.occurredAfter !== undefined) {
    conditions.push(sql`COALESCE(occurred_at, recorded_at) >= ${opts.filter.occurredAfter}`);
  }
  if (opts.filter.occurredBefore !== undefined) {
    conditions.push(sql`COALESCE(occurred_at, recorded_at) <= ${opts.filter.occurredBefore}`);
  }
  if (opts.filter.validAt !== undefined) {
    conditions.push(
      sql`(valid_from IS NULL OR valid_from <= ${opts.filter.validAt}) AND (valid_until IS NULL OR valid_until > ${opts.filter.validAt})`,
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

  const asciiTsQuery = sql`mnemora_lexical_query_or(${query})`;
  const jaTerm = sql`mnemora_trigram_strip_noise(mnemora_trigram_query_nonascii(${query}))`;

  // ASCII 側は既存経路と同じ述語（式索引 idx_memories_lexical がそのまま選ばれる）。
  // 日本語側は pg_trgm の演算子形（`content %> $ja`）——`createOptionalTrigramIndex` の
  // GIN 索引がプランナに選ばれるのはこの演算子形のときだけ（`word_similarity(...)` を
  // 関数として書くと索引は使われない。このファイル冒頭の doc「【実測】」参照）。
  conditions.push(sql`(
    to_tsvector('simple', mnemora_lexical_normalize(content)) @@ ${asciiTsQuery}
    OR (${jaTerm} IS NOT NULL AND content %> ${jaTerm})
  )`);
  const whereClause = sql.join(conditions, sql` AND `);

  return sql`
    SELECT
      id AS memory_id,
      mnemora_trigram_hybrid_coverage(content, ${query}, ${opts.threshold}) AS coverage,
      (
        ts_rank_cd(
          to_tsvector('simple', mnemora_lexical_normalize(content)),
          ${asciiTsQuery},
          33
        )
        + coalesce(
            CASE WHEN ${jaTerm} IS NOT NULL THEN word_similarity(${jaTerm}, content) ELSE 0 END,
            0
          )
      ) AS rank
    FROM memories
    WHERE ${whereClause}
    ORDER BY coverage DESC, rank DESC, recorded_at DESC, id
    LIMIT ${opts.limit}
  `;
}

// ---------------------------------------------------------------------------
// LexicalStore 実装
// ---------------------------------------------------------------------------

/**
 * `LexicalStore` の pg_trgm 版 opt-in 実装。`PostgresLexicalStore` を置き換えるものでは
 * なく、**導入側が明示的に選ぶ差し替え**である（`interfaces/lexical-store.ts` の doc
 * 「`LexicalStore` を差し替え可能にすることで逃げ道を開ける」、ADR 0084 §3.4）。
 *
 * 生成は必ず {@link PostgresTrigramLexicalStore.create} を経由すること——`new` を直接
 * 公開していないのは、静かな0件（このファイル冒頭の doc）を作れないようにするため。
 *
 * `search` の `ORDER BY` は `PostgresLexicalStore` と同じ4段
 * （`coverage DESC, rank DESC, recorded_at DESC, id`。
 * [ADR 0175](../../../docs/decisions/0175-lexical-search-tiebreak-nondeterminism.md) の
 * 決定的な全順序を保つ）。`rank` はこの adapter の内部でしか比較できない値である
 * （`LexicalHit.rank` の doc、ADR 0084 §5）——ASCII の `ts_rank_cd` と日本語の
 * `word_similarity` を単純に足しているだけであり、両者の尺度が本質的に同じという主張は
 * していない。
 */
export class PostgresTrigramLexicalStore implements LexicalStore {
  private constructor(
    private readonly db: Db,
    private readonly threshold: number,
  ) {}

  /**
   * `pg_trgm` の前提（拡張・ロケール）を確かめ、満たせなければ
   * {@link TrigramLexicalStoreUnavailableError} を投げる。満たせれば、この store が使う
   * SQL 関数（{@link ensureTrigramLexicalFunctions}）をインストールしてから返す。
   *
   * **索引（{@link createOptionalTrigramIndex}）はここでは作らない**——呼び出し側が
   * 別途、自分のタイミングで呼ぶ（このファイル冒頭の doc「なぜフィルタ条件の組み立てを
   * 複製するか」の下、`ensureTrigramLexicalFunctions` の doc参照）。
   */
  static async create(db: Db, opts?: { threshold?: number }): Promise<PostgresTrigramLexicalStore> {
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) {
      throw new TrigramLexicalStoreUnavailableError(probe.reason, probe.detail);
    }
    await ensureTrigramLexicalFunctions(db);
    const threshold = opts?.threshold ?? DEFAULT_TRIGRAM_WORD_SIMILARITY_THRESHOLD;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError(
        `PostgresTrigramLexicalStore.create: threshold は [0, 1] の有限数である必要がある（実際: ${threshold}）`,
      );
    }
    return new PostgresTrigramLexicalStore(db, threshold);
  }

  async search(
    _ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    const threshold = this.threshold;
    // `content %> $ja` は `pg_trgm.word_similarity_threshold`（セッション変数）を読む。
    // `SET`/`SET LOCAL` は PostgreSQL の文法上バインドパラメータ（$1）を取れない
    // （プレースホルダを渡すと 42601 構文エラーになる。この PR の作業者が実際に踏んだ）
    // ため、`create()` で [0, 1] の範囲へ検証済みの `threshold` をリテラルとして埋め込む。
    // `SET LOCAL` はトランザクション内でしか効かない（トランザクション外では
    // PostgreSQL が警告を出すだけで無視する）ため、同一トランザクション・同一接続で
    // `SET LOCAL` と本体の SELECT を発行する必要がある——`db.transaction` はコールバック
    // の間ずっと同じ接続を使うことを drizzle-orm が保証する（`memory-store.ts` の
    // 各 `db.transaction` 呼び出しと同じ前提）。
    return this.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL pg_trgm.word_similarity_threshold = ${threshold}`));
      const select = buildTrigramLexicalSearchSelect(query, { ...opts, threshold });
      const result = await tx.execute(select);
      return result.rows.map((row) => {
        const r = row as unknown as { memory_id: string; coverage: number; rank: number };
        return { memoryId: r.memory_id, coverage: r.coverage, rank: r.rank };
      });
    });
  }
}
