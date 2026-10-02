/**
 * ADR 0504: store が投げる例外（drizzle の `DrizzleQueryError`。`message` が
 * `Failed query: <SQL>\nparams: <値>`）から、`params:` より後ろ（SQL に渡した値。`searchMany` では最大
 * 16384 件のベクトル）を落とす。`Runtime` を通れば `omitParamsFromError`（core、ADR 0423）が落とすが、
 * store を直接呼ぶ呼び出しでは落ちない。
 *
 * **core の `omitParamsFromError` / `omitDrizzleParams`（`failure-description.ts`）と同じ作法・同じ印**
 * （`params: (omitted by mnemora, N chars)`）。core のそれは `index.ts` から出ていない内部関数で、
 * postgres パッケージからは import できない。公開の export を足さないため、同じ形の小さな複製をここに置く
 * （複製は負債。ADR 0504）。印が同じなので、あとから `Runtime` が掛けても、すでに落とした印はそのまま残る。
 *
 * - 例外そのものを返す（新しい例外を作らない。`code`・`name`・`cause` はそのまま）。落とすのは `message` の
 *   `params:` より後ろと、その文字列を含む `stack` の行だけ。SQL の文は残す。`cause` の連鎖にも掛ける。
 * - 目印が無い例外は何も変えない。書き換えられない（凍結された）例外はそのまま返す。
 * - ⚠ `DrizzleQueryError` の `params` プロパティ（値の配列）と、`cause` の pg エラーの `message`・`detail` は
 *   変えない（core と同じ。ADR 0423「塞がらない経路」）。
 */
const PARAMS_MARKER = "\nparams: ";
const OMITTED_MARK = /^\(omitted by mnemora, \d+ chars\)$/;

function omitFromMessage(message: string): string {
  const markerIndex = message.indexOf(PARAMS_MARKER);
  if (markerIndex === -1) {
    return message;
  }
  const paramsStart = markerIndex + PARAMS_MARKER.length;
  if (OMITTED_MARK.test(message.slice(paramsStart))) {
    return message;
  }
  return `${message.slice(0, paramsStart)}(omitted by mnemora, ${message.length - paramsStart} chars)`;
}

export function omitParamsFromError(error: unknown): unknown {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const target = current as { message?: unknown; stack?: unknown; cause?: unknown };
    if (typeof target.message === "string") {
      const omitted = omitFromMessage(target.message);
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

/** `run` が投げた例外に {@link omitParamsFromError} を掛けて投げ直す。 */
export async function omittingParams<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw omitParamsFromError(error);
  }
}
