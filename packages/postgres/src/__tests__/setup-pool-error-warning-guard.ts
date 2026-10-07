import { POOL_ERROR_WARNING_HEAD } from "../pool-error-warning.js";

/**
 * 「テストは全部通ったが unhandled error が1件出ただけ」が緑のまま通り抜けないための守り。
 *
 * `createPostgresClient` は既定で、pool の待機中の接続が失われると `POOL_ERROR_WARNING_PREFIX` で始まる `console.warn` を出して続行する（README「pool の `error`」）。
 * この package の DB テストの中でこの既定の警告が実際に出たら、それは「本来 `onPoolError`/`pool.on("error", …)` を自分で持つべきテストが持っていない」ことの徴候であり、見えない形で通り過ぎさせない。
 *
 * `console.warn` をここで上書きし、{@link POOL_ERROR_WARNING_HEAD}（接頭辞 + pool error 警告の固定の文言）で始まるメッセージが来たら、そのまま `throw` する。
 *
 * ⚠ 接頭辞だけでは掛けない。同じ接頭辞 `POOL_ERROR_WARNING_PREFIX` は `runMigrations` の台帳ずれの警告（部分的な `migrationsDir` を使うテストでは正当に出る）も使う。接頭辞で掛けると、そちらでも落ちる。
 * pool error の警告の文言は `client.ts` と共有の定数 {@link POOL_ERROR_WARNING_HEAD} で1か所にしてあり、文言だけが変わって守りが空振りすることはない
 * （`readme-unbound-promises.postgres.test.ts` の A が既定の警告が実際に出ることを見ている）。
 * この呼び出しは pool の `'error'` イベントリスナー（`pool.on("error", …)`）の中、つまり同期のイベント発火の最中で起きるため、投げた例外はどの `try`/`catch` にも拾われず、Node の `uncaughtException` になる。
 * vitest はこれを「unhandled error」として報告し、テストが全部 passed でも exit code を非0にする。
 *
 * 意図して接続を切るテスト（`readme-unbound-promises.postgres.test.ts` の A〜C・`pool-idle-connection-loss.test.ts`・`pool-error-warning-guard.postgres.test.ts` 自身のフィクスチャなど）は、
 * `onPoolError` か `pool.on("error", …)` を自分で持つので、既定の警告そのものが出ず、当たらない。
 * `readme-unbound-promises.postgres.test.ts` の A（既定の警告が出ることを確かめる歯）と `pool-error-warning-guard.postgres.test.ts` のフィクスチャ（子プロセスの vitest）は、
 * どちらもこの守りが効かない場所（子プロセス／別プロセス）でわざと既定の警告を起こしている。この setupFile が効くのはこの1プロセス（`@mnemora/postgres` の通常の DB テスト群）だけである。
 */
const originalConsoleWarn = console.warn.bind(console);

console.warn = (...args: unknown[]): void => {
  const [first] = args;
  if (typeof first === "string" && first.startsWith(POOL_ERROR_WARNING_HEAD)) {
    throw new Error(
      `[pool-error-warning-guard] onPoolError も pool.on("error", …) も付けずに ` +
        `createPostgresClient を使っているテストがある（既定の pool error 警告が出た）: ${first}`,
    );
  }
  originalConsoleWarn(...args);
};
