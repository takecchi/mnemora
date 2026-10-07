/**
 * `Headers` に通して送れない値を構築時に拒む。例外文にキーを入れず、元の例外も `cause` に付けない
 * （元の例外文にキー全体が入っており、core の `lastError` 等に残るため）。
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
