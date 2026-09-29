/**
 * `packages/postgres/src/__tests__/setup-pool-error-warning-guard.ts` と同じ守り（Issue #1213）。
 * ADR 0020 が塞いだ穴（unhandled error が1件出ただけで、テストは全部 passed のまま緑になる）が、
 * `createPostgresClient` の既定の pool error 警告という形で戻ってこないようにする。
 *
 * `createPostgresClient` は既定で、pool の待機中の接続が失われると、固定の接頭辞で始まる
 * `console.warn` を出して続行する（`packages/postgres/README.md`「pool の `error`」）。
 * examples/chat の DB テストでこの既定の警告が実際に出たら、`onPoolError`/`pool.on("error", …)`
 * を自分で持つべきテストが持っていない徴候であり、見えない形で通り過ぎさせない。
 *
 * ⚠ **接頭辞のリテラルはここで複製している。** 正本は
 * `packages/postgres/src/pool-error-warning.ts` の `POOL_ERROR_WARNING_PREFIX`——意図して
 * export していない内部定数なので（`@mnemora/postgres` の入口・`src/index.ts` からは
 * import できない）、examples/chat は `@mnemora/postgres` の入口以外を import しない作法
 * （他のどのファイルも `@mnemora/postgres` の入口からしか import していない）に従い、
 * パッケージの境界を跨いで参照する代わりに、値をここへ複製した。
 * **正本の文字列を変えたら、ここも直すこと**（自動では追随しない）。
 */
const POOL_ERROR_WARNING_PREFIX_MIRROR = "[@mnemora/postgres]";

const originalConsoleWarn = console.warn.bind(console);

console.warn = (...args: unknown[]): void => {
  const [first] = args;
  if (typeof first === "string" && first.startsWith(POOL_ERROR_WARNING_PREFIX_MIRROR)) {
    throw new Error(
      `[pool-error-warning-guard] onPoolError も pool.on("error", …) も付けずに ` +
        `createPostgresClient を使っているテストがある（既定の pool error 警告が出た）: ${first}`,
    );
  }
  originalConsoleWarn(...args);
};
