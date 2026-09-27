/**
 * Issue #1080: SDK が送るヘッダの値を、構築時に `Headers` へ通して確かめる。
 *
 * API キーの途中に CR・LF・NUL（あるいは U+0100 以上の文字）が入っていると、Node の
 * `fetch` はヘッダを組む段階で例外を投げる。そのうち CR・LF・NUL の例外文
 * （`Headers.append: "<キー全体>" is an invalid header value.`）にはキー全体が入り、
 * adapter がそのまま伝播すると、core の `extractionFailure.message` や outbox の
 * `lastError`（Postgres では DB に保存される）に残っていた。
 *
 * ここでは同じ値を `Headers` に通し、通らなければ**キーを含まない**例外を投げる。
 * 元の例外は `cause` にも付けない（その文面にキーが入っているため）。判定は `Headers`
 * そのものに任せるので、`fetch` が受け付ける値（末尾の空白・改行、途中の TAB など）は
 * これまでどおり受け付ける。もともと一度も送れない値を、送る前に拒むだけである。
 */
export function assertApiKeyFitsInHeader(
  owner: string,
  field: "apiKey" | "authToken",
  headerName: string,
  headerValue: string,
): void {
  try {
    new Headers().append(headerName, headerValue);
  } catch {
    throw new Error(
      `${owner}: ${field} contains a character that cannot be sent in an HTTP header ` +
        "(such as CR, LF, or NUL in the middle of it). Check how it was read " +
        "(e.g. a line break copied into it). The value itself is not included in this message.",
    );
  }
}
