#!/usr/bin/env node
import { createMigrateCliPool } from "./cli-pool.js";
import { runAnalyzeMemories, runMigrations } from "../migrate.js";
import { formatMigrateCliUsage, parseMigrateCliOptions } from "./cli-options.js";

/**
 * CLI エントリポイント。`DATABASE_URL` を読み、保留中のマイグレーションを適用する。
 * マイグレーションの実行は、他パッケージやルートから直接 drizzle-kit を叩かせないこの1つの口からのみ行う（ADR 0001）。
 *
 * 引数・環境変数の解釈は `./cli-options.ts` の `parseMigrateCliOptions` に切り出してあり、このファイルは
 * 解釈結果を `runMigrations` にそのまま渡す。未指定は options 省略時と同じに扱われる。
 *
 * `--analyze-memories` のときだけ、`runMigrations` の後に `runAnalyzeMemories` を呼ぶ。
 * `ANALYZE memories;` を `runMigrations` の中に混ぜない理由は `../migrate.ts` の `runAnalyzeMemories` を見ること。
 *
 * この CLI は `statement_timeout` を設定しない（ADR 0552）。接続・ロール・DB 側の `statement_timeout` などは
 * migration の本体の DDL にそのまま効く（CLI が扱うのは `lock_timeout` だけで、取った直後に `RESET` する）。
 * 短い `statement_timeout` が掛かった環境では、`DATABASE_URL` の `options` でこの接続だけ無効にする:
 * `?options=-c%20statement_timeout%3D0`（`PGOPTIONS="-c statement_timeout=0"` でも同じ）。
 * 手順は `packages/postgres/README.md` の「接続・ロール・DB の `statement_timeout` などは、migration の本体にも効く」節。
 */
async function main(): Promise<void> {
  const parsed = parseMigrateCliOptions(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(parsed.error.message);
    process.exitCode = 1;
    return;
  }
  if (parsed.options.help) {
    console.log(formatMigrateCliUsage());
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL が設定されていません。");
    process.exitCode = 1;
    return;
  }

  const { schema, extensionSchema, extensionMode, analyzeMemories } = parsed.options;
  const pool = createMigrateCliPool(connectionString);
  try {
    const { applied } = await runMigrations(pool, undefined, {
      schema,
      extensionSchema,
      extensionMode,
    });
    if (applied.length === 0) {
      console.log("適用対象のマイグレーションはありません（すべて適用済み）。");
    } else {
      console.log(`適用したマイグレーション: ${applied.join(", ")}`);
    }
    if (analyzeMemories) {
      const { table } = await runAnalyzeMemories(pool, { schema });
      console.log(`ANALYZE を実行しました: ${table}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
