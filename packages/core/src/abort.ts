/**
 * [Issue #1200](https://github.com/takecchi/mnemora/issues/1200): LLM・埋め込みの呼び出しを
 * 中断するための共通の型と補助関数。
 *
 * ⚠ **この判定はクローン miku の判断であり、オーナーの判断ではない。**方向の詳細は
 * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md) を参照。
 *
 * 🔴 **既定の時間の上限は持たない。**`signal` を渡さなければ、今までどおり provider が
 * 返るまで待ち続ける（このファイルが在ること自体が挙動を1バイトも変えない）。
 */

/**
 * provider を呼ぶ口（`LLMProvider.complete`/`completeStructured`・`EmbeddingProvider.embed`）に
 * 渡す、任意の中断口。**渡さなければ、今までどおり中断できない。**
 *
 * 1つの共通の型にしてある——`complete`/`completeStructured`/`embed` のどれも、いま欲しい
 * 選択肢は「中断の合図」だけであり、別々の型を3つ置くと、片方だけ直したときに黙ってずれる
 * （`AGENTS.md` の反重複規律）。
 */
export interface AbortOptions {
  /**
   * 中断の合図。渡した `signal` が abort された時点で、その呼び出しは reject する
   * （reject する値は {@link abortReason} を参照）。
   *
   * ⚠ **渡すことは、provider がそれを尊重することを保証しない。** `@mnemora/openai`・
   * `@mnemora/anthropic` は SDK の呼び出しへ渡す（ADR 0359）が、それ以外の実装（signal を
   * 無視する adapter）でも、呼んだ Runtime の口は返る——runtime 自身が provider の Promise と
   * abort を競わせるため（`runAbortable` 参照）。
   */
  signal?: AbortSignal | undefined;
}

/**
 * `signal` が abort されたときに reject する値。
 *
 * `signal.reason` があればそれをそのまま使う（`AbortController.abort(reason)` で呼び出し側が
 * 明示した値）。無ければ（`reason` 無しの `abort()`）、`DOMException("...", "AbortError")` 相当を
 * 作る——Node/ブラウザの `fetch` が `AbortSignal` で中断したときに投げる例外と同じ形。
 */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason !== undefined
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");
}

/**
 * `signal` が定義されていて、かつ既に abort 済みかどうか。
 *
 * catch 節で「この例外は abort によるものか、それとも provider が本当に失敗したのか」を
 * 見分けるために使う——`runAbortable` は abort が起きた時点で**同期的に** reject するため
 * （`AbortController.abort()` は `abort` イベントを同期的に発火する）、catch した時点で
 * `signal.aborted` が真なら、その例外はふつう {@link abortReason} である
 * （`runAbortable` の doc コメント参照）。
 *
 * ⚠ **「必ず」ではない。**`run` の Promise が abort より先に（provider 自身のエラーで）reject し、
 * その reject が catch 節に届くまでの間に abort されると、`signal.aborted` は真なのに、
 * 例外は provider のエラーのままになる（`runAbortable` は先に決着した側を返す）。
 */
export function isAbort(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * provider 呼び出し（またはそれに準じる非同期処理）を、`signal` の abort と競わせる。
 *
 * - `signal` が `undefined` なら、素通しする（`run(undefined)` を呼ぶだけ。今までどおり
 *   中断できない——このファイルが在ることが既定の挙動を変えないことの土台）。
 * - `signal` が既に abort 済みなら、**`run` を呼ばずに** {@link abortReason} で reject する
 *   （「呼ぶ前に既に abort 済みなら、provider を呼ばずに reject する」——ADR 0359 決定4）。
 * - それ以外は `run(signal)` を呼び、その Promise と「`signal` が abort されること」を競わせる。
 *   abort が先に起きたら、`run` の Promise が後から解決・拒否されても**その結果は捨てる**
 *   （resolve/reject のどちらでも無視する）。`run` の Promise には常に `.then`/`.catch` の
 *   ハンドラが付いているため、後から reject されても unhandled rejection にはならない
 *   （ADR 0359 決定4「遅れて reject されても unhandled rejection にならない」）。
 *
 * 🔴 **中断が効くのは、`run` を待っている間と呼ぶ前だけである。** `run` が abort より前に
 * 解決していれば、その結果がそのまま返る（呼び出し側が結果を使って書き込みを始めた後は、
 * 途中で止めない——ADR 0359「これが覆るとしたら」参照）。
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
