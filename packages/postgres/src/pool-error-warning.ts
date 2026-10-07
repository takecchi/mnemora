/**
 * `createPostgresClient` が既定で出す pool error 警告の接頭辞。
 *
 * 意図して公開 API に含めない: `client.ts` が re-export しないので `export *` の入口に出ない。
 */
export const POOL_ERROR_WARNING_PREFIX = "[@mnemora/postgres]";

/**
/**
 * pool error 警告の頭の部分（接頭辞 + 固定の文言）。`client.ts` がこれに `: <error.message>` を続ける。
 * 接頭辞は `runMigrations` の台帳ずれの警告も共有するので、警告の判別は接頭辞でなくこの頭で行う。
 */
export const POOL_ERROR_WARNING_HEAD = `${POOL_ERROR_WARNING_PREFIX} pool の待機中の接続が失われた。捨てて続行する`;
