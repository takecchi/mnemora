/**
 * ⛔ 歯を1本も弱めない。skip も入れない。出力に接続先を1行足すだけ。
 * ⚠ 取れなかったときも必ず何かを出す（出さないと、何も無かったように見える）。
 */
import { spawnSync } from "node:child_process";

/**
 * ⚠ この一覧は「他の版では動かない」という主張ではない。「ここに無い版は、誰も確かめていない」という主張である。
 */
export const VERIFIED_MAJOR_VERSIONS = Object.freeze([17, 18]);

/**
 * ⛔ `pg` はルートの依存に無い。ルートへ依存を足さず、`packages/postgres` を `cwd` にした子プロセスから問い合わせる。
 *
 * @param {string} databaseUrl
 * @param {string} postgresPackageDir `packages/postgres` の絶対パス
 * @returns {{ ok: true, serverVersion: string, vectorVersion: string | null }
 *          | { ok: false, reason: string }}
 */
export function describeDatabaseServer(databaseUrl, postgresPackageDir) {
  const probe = [
    "import('pg').then(async (pg) => {",
    "  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });",
    "  await client.connect();",
    "  try {",
    "    const version = await client.query(\"select current_setting('server_version') as sv\");",
    "    const vector = await client.query(\"select extversion from pg_extension where extname = 'vector'\");",
    "    console.log(JSON.stringify({",
    "      serverVersion: version.rows[0].sv,",
    "      vectorVersion: vector.rows[0] ? vector.rows[0].extversion : null,",
    "    }));",
    "  } finally { await client.end(); }",
    "}).catch((err) => {",
    "  console.error(String(err && err.message ? err.message : err));",
    "  process.exit(1);",
    "});",
  ].join("\n");

  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd: postgresPackageDir,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 15_000,
  });

  if (result.status !== 0) {
    const reason = (result.stderr || "").trim() || `exit ${result.status ?? "signal"}`;
    return { ok: false, reason: reason.split("\n")[0] };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      ok: true,
      serverVersion: String(parsed.serverVersion),
      vectorVersion: parsed.vectorVersion === null ? null : String(parsed.vectorVersion),
    };
  } catch (error) {
    return { ok: false, reason: `応答を読めませんでした: ${String(error.message ?? error)}` };
  }
}

/**
 * @param {string} serverVersion 例: `"16.15 (Debian 16.15-1.pgdg12+2)"`
 * @returns {number | null}
 */
export function majorVersionOf(serverVersion) {
  const matched = /^\s*(\d+)/.exec(serverVersion);
  return matched ? Number(matched[1]) : null;
}

/**
 * @param {{ ok: true, serverVersion: string, vectorVersion: string | null }
 *        | { ok: false, reason: string }} description
 * @returns {string[]}
 */
export function formatServerLines(description) {
  if (!description.ok) {
    return [
      `  接続先: （版を取得できませんでした: ${description.reason}）`,
      "  ⚠ 接続先が何であるかを、この門は言えていません。",
    ];
  }

  const vector =
    description.vectorVersion === null
      ? "pgvector（拡張が入っていません）"
      : `pgvector ${description.vectorVersion}`;
  const lines = [`  接続先: PostgreSQL ${description.serverVersion} / ${vector}`];

  const major = majorVersionOf(description.serverVersion);
  if (major === null) {
    lines.push("  ⚠ メジャー版を読み取れませんでした（版の検証済み一覧と突き合わせていません）。");
    return lines;
  }
  if (VERIFIED_MAJOR_VERSIONS.includes(major)) {
    return lines;
  }

  return lines.concat([
    `  ⚠ PostgreSQL ${major} は、この repo で検証されていない版です`,
    `    （検証済み: ${VERIFIED_MAJOR_VERSIONS.join(" / ")}。CI は 17、ADR 0011 の実測は 18.6）。`,
    "    この repo の歯には、プランナがどちらの経路を選ぶかを assert しているものが在ります。",
    "    ⟹ 赤くなったら、まず origin/main で対照を取ること（自分の変更のせいとは限りません）:",
    "",
    "      git worktree add ../main-control origin/main",
    "      cd ../main-control && pnpm install",
    "      DATABASE_URL=... pnpm --filter @mnemora/postgres exec vitest run <落ちたファイル>",
    "",
    "    ⟹ main でも同じ壊れ方をするなら、それは版であって、あなたの変更ではありません。",
  ]);
}
