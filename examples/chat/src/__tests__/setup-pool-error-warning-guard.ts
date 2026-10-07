// 接頭辞のリテラルは複製している。正本 packages/postgres/src/pool-error-warning.ts の POOL_ERROR_WARNING_PREFIX は export されない内部定数で、
// examples/chat は @mnemora/postgres の入口以外を import しない。正本を変えたらここも直す（自動では追随しない）。
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
