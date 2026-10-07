import { sliceAtGraphemeBoundary } from "./text-truncation.js";

/** 失敗（例外）を、利用者に返す・outbox に残す文字列へ整形する共有の関数群（内部。公開 API ではない）。 */

/**
 * `tick()` が `outboxStore.fail()` に渡す `lastError` の文字列を作る（ADR 0363）。
 *
 * `err.message` だけでは足りない。drizzle の `db.execute()` は pg のエラーを
 * `Failed query: <SQL> params: …` で包むので、DB 由来の失敗では理由（pg のエラー文・SQLSTATE）が
 * `cause` にしか無い。そこで `cause` の連鎖を辿り、各段の `message` と、文字列の `code`
 * （pg なら SQLSTATE、Node なら `ECONNRESET` 等）だけを連結する。
 *
 * **各段の `message` と `code` 以外は載せない。**pg エラーの `detail`（制約違反のキー値など）には
 * 利用者のデータが入りうる。各段の `message` からは {@link omitDrizzleParams} で `params:` 以降を落とす。
 * 循環した `cause` は、一度見た段で打ち切る。
 *
 * 戻り値全体には長さの上限を掛ける。`params:` を持たない経路（`@mnemora/openai` の拒否の文面、
 * pg の型変換失敗のメッセージなど）にも利用者データが載りうるため（ADR 0363「塞がらない経路」）。
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
 * drizzle のエラー文の `params:` 以降を検出するときの目印。
 *
 * drizzle-orm の `DrizzleQueryError` は `` `Failed query: ${query}\nparams: ${params}` `` という
 * 固定の組み立て方でメッセージを作る。この文字列は drizzle の実装詳細で、形が変わったら追随が要る。
 * 見つからなければ {@link omitDrizzleParams} は何もしない（「削らない」方向にしか倒れず、
 * 誤って SQL の途中を削ることは無い）。
 */
const DESCRIBE_JOB_FAILURE_PARAMS_MARKER = "\nparams: ";

/**
 * drizzle が包んだエラー文（`message`）から、最初に現れた {@link DESCRIBE_JOB_FAILURE_PARAMS_MARKER}
 * より後ろ（失敗したクエリに渡した値そのもの）を落とし、代わりに「落としたことが読める印」と
 * 落とした文字数を残す（ADR 0363）。SQL の文そのもの（`params:` の直前まで）は変えない。
 *
 * **最初の出現で切る理由**: drizzle は SQL 全体を書いた後に `\nparams: ` を1回だけ足すので、
 * 最初の出現は実際の params の開始位置と一致するか、それより手前（より多く削る側）にしか倒れない。
 */
export function omitDrizzleParams(message: string): string {
  const markerIndex = message.indexOf(DESCRIBE_JOB_FAILURE_PARAMS_MARKER);
  if (markerIndex === -1) {
    return message;
  }
  const paramsStart = markerIndex + DESCRIBE_JOB_FAILURE_PARAMS_MARKER.length;
  // ADR 0430: 既に落とした印なら、そのまま返す（べき等）。独立関数と `Runtime` の両方が掛かっても、
  // 落とした文字数の数字が「印の長さ」に書き換わらない。
  if (/^\(omitted by mnemora, \d+ chars\)$/.test(message.slice(paramsStart))) {
    return message;
  }
  const omittedChars = message.length - paramsStart;
  return `${message.slice(0, paramsStart)}(omitted by mnemora, ${omittedChars} chars)`;
}

/**
 * {@link describeFailure} が返す文字列全体の長さの上限。
 *
 * params を落とした後に残るのは SQL の文（`packages/postgres` の書き込みクエリで最大約2000文字）と
 * cause の連鎖だけなので、その2倍近い余裕を持たせて 4096 とした。
 *
 * **{@link DROPPED_CANDIDATE_MESSAGE_MAX_CHARS}（500）とは揃えない。** 500 では SQL の文そのものが
 * 途中で切れ、SQL の形と cause の連鎖を保つという狙いが壊れる。
 */
const DESCRIBE_JOB_FAILURE_MAX_CHARS = 4096;

/**
 * {@link describeFailure} の戻り値全体に {@link DESCRIBE_JOB_FAILURE_MAX_CHARS} の上限を掛ける。
 * 超えたら `sliceAtGraphemeBoundary`（書記素の内側で切らない。ADR 0470）で切り、末尾に
 * 「切ったこと」と「元の長さ」が読める印を付ける。
 */
function capDescribeJobFailureLength(message: string): string {
  if (message.length <= DESCRIBE_JOB_FAILURE_MAX_CHARS) {
    return message;
  }
  const originalLength = message.length;
  const sliced = sliceAtGraphemeBoundary(message, DESCRIBE_JOB_FAILURE_MAX_CHARS);
  return `${sliced}… (truncated by mnemora, original length ${originalLength} chars)`;
}

/**
 * 利用者へ投げ直す例外から、SQL に付けた値（params）を落とす（ADR 0423）。
 *
 * `Runtime` の各メソッドは、store が投げた例外をこの関数に通してから投げ直す。
 *
 * - **例外そのものを返す**（新しい例外を作らない）。`kind`・`name`・`cause`・独自の欄はそのまま残る。
 *   落とすのは `message` の `params:` より後ろと、その文字列を含む `stack` の先頭の行だけ。
 *   SQL の文は残す。`cause` の連鎖も同じ処理を掛ける（一度見た段で打ち切る）。
 * - `params:` の目印が無い例外は何も変えない。
 * - `message` が書き換えられない例外（凍結されたもの）は、そのまま返す（落とせないときは落とさない側に倒れる）。
 *
 * ⚠ **`DrizzleQueryError` の `params` プロパティ（値の配列）と、`cause`（pg のエラー）の `message`・`detail` は
 * 変えない**（ADR 0423「塞がらない経路」）。
 */
export function omitParamsFromError(error: unknown): unknown {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const target = current as { message?: unknown; stack?: unknown; cause?: unknown };
    if (typeof target.message === "string") {
      const omitted = omitDrizzleParams(target.message);
      if (omitted !== target.message) {
        const original = target.message;
        try {
          target.message = omitted;
          if (typeof target.stack === "string") {
            target.stack = target.stack.replace(original, () => omitted);
          }
        } catch {
          // 書き換えられない例外は、そのまま返す。
        }
      }
    }
    current = target.cause;
  }
  return error;
}
