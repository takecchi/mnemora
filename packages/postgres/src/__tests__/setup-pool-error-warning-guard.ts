import { POOL_ERROR_WARNING_PREFIX } from "../pool-error-warning.js";

/**
 * ADR 0020 が塞いだ穴（「テストは全部通ったが unhandled error が1件出ただけ」が緑のまま通り抜ける）が、
 * 形を変えて戻ってこないための守り（Issue #1213）。
 *
 * `createPostgresClient` は既定で、pool の待機中の接続が失われると
 * {@link POOL_ERROR_WARNING_PREFIX} で始まる `console.warn` を出して続行する（README「pool の
 * `error`」）。**この package の DB テストの中でこの既定の警告が実際に出たら、それは「本来
 * `onPoolError`/`pool.on("error", …)` を自分で持つべきテストが持っていない」ことの徴候であり、
 * 見えない形で通り過ぎさせない。**
 *
 * `console.warn` をここで上書きし、この接頭辞で始まるメッセージが来たら、そのまま `throw` する。
 * この呼び出しは pool の `'error'` イベントリスナー（`pool.on("error", …)`）の中、つまり同期の
 * イベント発火の最中で起きるため、投げた例外はどの `try`/`catch` にも拾われず、Node の
 * `uncaughtException` になる——vitest はこれを「unhandled error」として報告し、テストが全部
 * passed でも exit code を非0にする（ADR 0020 の動的な歯と同じ仕組み）。
 *
 * 意図して接続を切るテスト（`readme-unbound-promises.postgres.test.ts` の A〜C・
 * `pool-idle-connection-loss.test.ts`・`pool-error-warning-guard.postgres.test.ts` 自身の
 * フィクスチャなど）は、`onPoolError` か `pool.on("error", …)` を自分で持つので、既定の警告
 * そのものが出ない——当たらない。`readme-unbound-promises.postgres.test.ts` の A（既定の警告が
 * 出ることを確かめる歯）と `pool-error-warning-guard.postgres.test.ts` のフィクスチャ（子プロセスの
 * vitest）は、どちらもこの守りが効かない場所（子プロセス／別プロセス）でわざと既定の警告を
 * 起こしている——この setupFile が効くのはこの1プロセス（`@mnemora/postgres` の通常の
 * DB テスト群）だけである。
 */
const originalConsoleWarn = console.warn.bind(console);

console.warn = (...args: unknown[]): void => {
  const [first] = args;
  if (typeof first === "string" && first.startsWith(POOL_ERROR_WARNING_PREFIX)) {
    throw new Error(
      `[pool-error-warning-guard] onPoolError も pool.on("error", …) も付けずに ` +
        `createPostgresClient を使っているテストがある（既定の pool error 警告が出た）: ${first}`,
    );
  }
  originalConsoleWarn(...args);
};
