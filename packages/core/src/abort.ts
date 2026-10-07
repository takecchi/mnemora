/**
 * LLM・埋め込みの呼び出しを中断するための共通の型と補助関数
 * （[ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）。
 *
 * **既定の時間の上限は持たない。**`signal` を渡さなければ、provider が返るまで待ち続ける。
 */

/**
 * provider を呼ぶ口（`LLMProvider.complete`/`completeStructured`・`EmbeddingProvider.embed`）に
 * 渡す、任意の中断口。**渡さなければ中断できない。**
 *
 * 3つの口で別々の型を置くと、片方だけ直したときに黙ってずれるため、共通の1つの型にしてある。
 */
export interface AbortOptions {
  /**
   * 中断の合図。渡した `signal` が abort された時点で、その呼び出しは reject する
   * （reject する値は {@link abortReason} を参照）。
   *
   * **渡すことは、provider がそれを尊重することを保証しない。** signal を無視する adapter でも、
   * runtime 自身が provider の Promise と abort を競わせるので、呼んだ Runtime の口は返る
   * （`runAbortable` 参照）。
   */
  signal?: AbortSignal | undefined;
}

/**
 * `signal` が abort されたときに reject する値。
 *
 * `signal.reason` があればそれをそのまま使う。無ければ（`reason` 無しの `abort()`）、
 * `DOMException("...", "AbortError")` 相当を作る（`fetch` が中断時に投げる例外と同じ形）。
 */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason !== undefined
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");
}

/**
 * `signal` が定義されていて、かつ既に abort 済みかどうか。
 *
 * catch 節で、例外が abort によるものか provider の失敗かを見分けるために使う。
 * `runAbortable` は abort が起きた時点で同期的に reject するので、catch した時点で
 * `signal.aborted` が真なら、その例外はふつう {@link abortReason} である。
 *
 * **「必ず」ではない。**`run` の Promise が abort より先に provider 自身のエラーで reject し、
 * その reject が catch 節に届くまでの間に abort されると、`signal.aborted` は真なのに
 * 例外は provider のエラーのままになる（`runAbortable` は先に決着した側を返す）。
 */
export function isAbort(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * provider 呼び出し（またはそれに準じる非同期処理）を、`signal` の abort と競わせる。
 *
 * - `signal` が `undefined` なら素通しする（`run(undefined)` を呼ぶだけ）。
 * - `signal` が既に abort 済みなら、**`run` を呼ばずに** {@link abortReason} で reject する。
 * - それ以外は `run(signal)` の Promise と abort を競わせる。abort が先に起きたら、`run` の
 *   Promise が後から解決・拒否されても**その結果は捨てる**。`run` の Promise には常にハンドラが
 *   付くので、後から reject されても unhandled rejection にならない。
 *
 * **中断が効くのは、`run` を待っている間と呼ぶ前だけである。** `run` が abort より前に解決して
 * いれば、その結果がそのまま返る（書き込みを始めた後は途中で止めない）。
 */
export async function runAbortable<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (signal === undefined) {
    return run(undefined);
  }
  if (signal.aborted) {
    throw abortReason(signal);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    run(signal).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(err);
      },
    );
  });
}
