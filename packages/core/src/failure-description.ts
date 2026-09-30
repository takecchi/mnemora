import { sliceWithoutSplittingSurrogatePair } from "./text-truncation.js";

/**
 * 失敗（例外）を、利用者に返す・outbox に残す文字列へ整形する共有の関数群（内部。公開 API ではない）。
 *
 * もとは `runtime.ts` の `createRuntime` のクロージャ内にあった `describeJobFailure`
 * （Issue #969 / #1064、ADR 0363）。`Runtime.forget` / `purge` / `restoreArchived` などの
 * outcome の `error` も同じ整形にするため、クロージャの外へ切り出した（ADR 0363 の 2026-09-30 追記）。
 * 出力は切り出し前と1文字も変えていない。doc 中の `describeJobFailure` は、いまの
 * {@link describeFailure} を指す。
 */

/**
 * Issue #969: `tick()` が `outboxStore.fail()` に渡す `lastError` の文字列を作る。
 *
 * `err.message` だけでは足りない——drizzle の `db.execute()` は pg のエラーを
 * `Failed query: <SQL> params: …` で包むので、DB 由来の失敗では理由（pg のエラー文・
 * SQLSTATE）が `cause` にしか無い（`packages/postgres/src/advisory-lock.ts` の doc と同じ形）。
 * そこで `cause` の連鎖を辿り、各段の `message` と、文字列の `code`（pg なら SQLSTATE、
 * Node なら `ECONNRESET` 等）だけを連結する。
 *
 * 🔴 **各段の `message` と `code` 以外は載せない。**pg エラーの `detail`（制約違反のキー値
 * など）には利用者のデータが入りうる。先頭の `message` は今までどおりそのまま使う
 * （drizzle が既に含めている params は、増やしも減らしもしない）。
 * 循環した `cause` は、一度見た段で打ち切る。
 *
 * ⚠ **2026-09-29 追記（Issue #1064、ADR 0363）**: 直前の段落「先頭の `message` は今までどおり
 * そのまま使う（drizzle が既に含めている params は、増やしも減らしもしない）」は、もう成り立たない。
 * `params:` に付いていた drizzle の値（失敗したクエリに渡した params——Memory の本文などの
 * 利用者データそのもの。実測で1.49MBに達した例が Issue #1064 に在る）は、[ADR 0363](../../../docs/decisions/0363-outbox-last-error-omit-params-and-cap-length.md)
 * の決定により、各段の `message` から {@link omitDrizzleParams} で落とす。SQL の文そのもの
 * （テーブル名・列名・クエリの形）と cause の連鎖・SQLSTATE は今までどおり残す。
 * さらに、戻り値全体に {@link capDescribeJobFailureLength} で長さの上限を掛ける——
 * openai の拒否の文面（`@mnemora/openai` の `OpenAILLMProviderError`、ADR 0075）や
 * pg の生エラーの型変換失敗のメッセージ（`invalid input syntax for type ... : "<値>"`）など、
 * `params:` を持たない経路にも利用者データが載りうるため（ADR 0363「塞がらない経路」）。
 */
export function describeFailure(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const code = (current as { code?: unknown }).code;
    const message = omitDrizzleParams(current.message);
    parts.push(typeof code === "string" ? `${message} (code: ${code})` : message);
    current = current.cause;
  }
  return capDescribeJobFailureLength(parts.join(" <- caused by: "));
}

/**
 * `describeJobFailure` が drizzle のエラー文の `params:` 以降を検出するときの目印。
 *
 * drizzle-orm の `DrizzleQueryError`（`node_modules/drizzle-orm/errors.js`）は
 * `` `Failed query: ${query}\nparams: ${params}` `` という固定の組み立て方でメッセージを
 * 作る。⚠ この文字列は drizzle の実装詳細であり、drizzle 側が形を変えたら
 * ここも追随が要る——見つからなければ {@link omitDrizzleParams} は何もしない
 * （安全側。見落としても「削らない」方向にしか倒れず、誤って SQL の途中を削ることは無い）。
 */
const DESCRIBE_JOB_FAILURE_PARAMS_MARKER = "\nparams: ";

/**
 * Issue #1064（2026-09-29、ADR 0363）: drizzle が包んだエラー文（`message`）から、
 * 最初に現れた {@link DESCRIBE_JOB_FAILURE_PARAMS_MARKER}（`"\nparams: "`）より後ろ
 * （失敗したクエリに渡した値そのもの）を落とし、代わりに「落としたことが読める印」と
 * 落とした文字数を残す。SQL の文そのもの（`params:` の**直前まで**）は変えない。
 *
 * **最初の出現で切る理由**: SQL の文の中に `params:` という文字列が偶然含まれることは
 * まず無いが、万一含まれていても、それは実際の params（値そのもの）より**前**には
 * 現れない——drizzle は常に SQL 全体を書いた後に `\nparams: ` を1回だけ足す。
 * ⟹ 最初の出現で切る判断は、実際の params の開始位置と一致するか、それより手前
 * （＝より多く削る側）にしか倒れない。SQL の後半を誤って残してしまう向きのずれは無い。
 */
function omitDrizzleParams(message: string): string {
  const markerIndex = message.indexOf(DESCRIBE_JOB_FAILURE_PARAMS_MARKER);
  if (markerIndex === -1) {
    return message;
  }
  const paramsStart = markerIndex + DESCRIBE_JOB_FAILURE_PARAMS_MARKER.length;
  const omittedChars = message.length - paramsStart;
  return `${message.slice(0, paramsStart)}(omitted by mnemora, ${omittedChars} chars)`;
}

/**
 * Issue #1064（2026-09-29、ADR 0363）: `describeJobFailure` が返す文字列全体の長さの上限。
 *
 * 【実測 2026-09-29】`packages/postgres` の `sql\`...\`` ブロック（ソース上のテキスト、
 * プレースホルダの式を評価する前の長さ）を全部数えると、書き込み系（INSERT/UPDATE）で
 * 最大のものは `memory-store.ts` の `INSERT INTO memories (...)` で1938文字。
 * リポジトリ全体（読み取り専用の SELECT を含む）で最大のものは4339文字。
 * 実行時の `Failed query:` の文はプレースホルダが `$1`/`$2` 等に短縮されるので、
 * 実測のソース長よりさらに短くなる。
 *
 * `omitDrizzleParams` で params を落とした後は、残るのは SQL の文（既知の最大の
 * 書き込みクエリでも2000文字強）と、cause の連鎖（pg の生エラー・SQLSTATE、
 * 数十〜百文字程度）・`" <- caused by: "` の連結・下の切り詰めの印だけである。
 * ⟹ 既知の最大のクエリを2倍近い余裕で収め、かつ暴走を防ぐ上限として **4096** とした。
 *
 * ⛔ **{@link DROPPED_CANDIDATE_MESSAGE_MAX_CHARS}（500）とは揃えていない。**
 * 500 では SQL の文そのものが本体の途中で切れてしまい、`describeJobFailure` の狙い
 * （SQL の形と cause の連鎖を保つ——直前の doc コメント参照）が壊れる。
 */
const DESCRIBE_JOB_FAILURE_MAX_CHARS = 4096;

/**
 * Issue #1064（2026-09-29、ADR 0363）: `describeJobFailure` の戻り値全体に
 * {@link DESCRIBE_JOB_FAILURE_MAX_CHARS} の上限を掛ける。上限を超えたら
 * `sliceWithoutSplittingSurrogatePair`（サロゲートペアの内側で切らない、`text-truncation.ts`）
 * で切り、末尾に「切ったこと」と「元の長さ」が読める印を付ける。
 *
 * `omitDrizzleParams` だけでは塞がらない経路（ADR 0363「塞がらない経路」）——
 * openai の拒否の文面（上限なし）や pg の型変換エラーのメッセージ（`invalid input syntax
 * for type ... : "<値>"`、値がそのまま `message` に載る）——を、この長さの上限だけで抑える。
 */
function capDescribeJobFailureLength(message: string): string {
  if (message.length <= DESCRIBE_JOB_FAILURE_MAX_CHARS) {
    return message;
  }
  const originalLength = message.length;
  const sliced = sliceWithoutSplittingSurrogatePair(message, DESCRIBE_JOB_FAILURE_MAX_CHARS);
  return `${sliced}… (truncated by mnemora, original length ${originalLength} chars)`;
}
