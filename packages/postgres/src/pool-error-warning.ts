/**
 * `createPostgresClient`（`./client.ts`）が既定で出す pool error 警告の接頭辞（Issue #1213）。
 *
 * ⚠ **意図してこの package の公開 API に含めない。** `src/index.ts` は `export * from "./client.js"`
 * だけで入口を作っており、この定数は `client.ts` から import されるだけで `client.ts` 自身は
 * これを re-export しない——`export *` は re-export していない名前までは拾わないので、
 * `scripts/__snapshots__/public-api/postgres.d.ts`（公開 API のスナップショット）には現れない。
 *
 * 一方で、この package 自身のテスト（`src/__tests__/*.ts`）は同じ package の中なので、
 * `../pool-error-warning.js` を相対 import すれば普通に参照できる——「意図して export しない」は
 * 「テストの守りから参照できない」を意味しない。実際に参照しているのは:
 *
 * - `src/__tests__/setup-pool-error-warning-guard.ts`（この警告が出たら vitest の中で例外に変える）
 * - `src/__tests__/readme-unbound-promises.postgres.test.ts`（既定の警告が出た/出ないことを確かめる歯）
 *
 * `examples/chat` はこの package の外なので、`@mnemora/postgres` の入口（`src/index.ts`）以外を
 * import しない作法に従い、`examples/chat/src/__tests__/setup-pool-error-warning-guard.ts` はこの
 * 値をリテラルとして複製している（複製先のコメントに、ここが正本である旨を書いてある）。
 */
export const POOL_ERROR_WARNING_PREFIX = "[@mnemora/postgres]";

/**
 * pool error 警告の**頭の部分**（接頭辞 + 固定の文言）。`client.ts` がこれに続けて `: <error.message>` を付ける。
 *
 * `src/__tests__/setup-pool-error-warning-guard.ts` はこの頭で**だけ**落ちる。接頭辞 {@link POOL_ERROR_WARNING_PREFIX} は
 * `runMigrations` の台帳ずれの警告（ADR 0425）も共有するため、接頭辞だけで守りを掛けると、そちらでも落ちてしまう。
 */
export const POOL_ERROR_WARNING_HEAD = `${POOL_ERROR_WARNING_PREFIX} pool の待機中の接続が失われた。捨てて続行する`;
