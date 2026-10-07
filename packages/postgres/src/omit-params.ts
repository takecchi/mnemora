/**
 * ADR 0504: store が投げる例外（drizzle の `DrizzleQueryError`。`message` は `Failed query: <SQL>\nparams: <値>`）から、
 * `params:` より後ろ（SQL に渡した値。`searchMany` では最大 16384 件のベクトル）を落とす。
 * `Runtime` を通れば core の `omitParamsFromError` が落とすが、store を直接呼ぶ場合は落ちない。
 *
 * core の `omitParamsFromError` と同じ印（`params: (omitted by mnemora, N chars)`）。
 * core のそれは `index.ts` から出ていない内部関数で import できず、公開 export を足さないために小さな複製をここに置く。
 *
 * - 例外そのものを返す。落とすのは `message` の `params:` より後ろと、それを含む `stack` の行だけ（`cause` の連鎖にも掛ける）。
 * - 目印が無い例外、書き換えられない（凍結された）例外は、そのまま返す。
 * - `DrizzleQueryError` の `params` プロパティと、`cause` の pg エラーの `message`・`detail` は変えない（ADR 0423）。
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
