#!/usr/bin/env node
/**
 * ⛔ `test:db` を1本ずつ `pnpm --filter <name> run test:db` で直列に呼ぶ。`pnpm --recursive --if-present run test:db` の一発呼びに戻さない。
 * 一発呼びで直列になっていたのは、依存順(`--sort`)がたまたま直列にしていただけで、依存の無い `test:db` パッケージが増えると並行に走る。
 * `resetTestDatabase()` は同じ `DATABASE_URL` の同じテーブルに `TRUNCATE ... RESTART IDENTITY CASCADE` を撃ち、`tenant_id` の分離は `TRUNCATE` に効かない。
 * 並行すると非決定的に赤くなる(実測)。
 * `--workspace-concurrency=1` ではなく明示のループにした理由: 排他がこの門のコード自身に載る。pnpm の `--bail` は起動済みの兄弟プロセスを殺さない。どのパッケージで落ちたかをこの段自身が名指しできる。
 *
 * ⛔ 専用データベースは採らなかった(ADR 0016)。危険の実体は同一プロセス群が同一 DB を共有することで、この段の排他で足りる。
 *
 * ⛔ `DATABASE_URL` 未設定は exit 0 だが「実行していない」と明示する。「通った」と「走らせていない」を同じ緑にしない。
 * DB を持たない環境でもルートの門が通るよう、スクリプト名は `test` ではなく `test:db` に分けてある。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeDatabaseServer, formatServerLines } from "./db-server-description.mjs";

const DB_SCRIPT = "test:db";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const BANNER = "─".repeat(72);

/**
 * 名前を直書きせず pnpm に問い合わせる。あとから `test:db` を足したパッケージが黙って門から漏れるのを防ぐため。
 * 依存の無い組同士の順序は名前順に固定する。どちらが先でも安全でなければならず、安全でないなら各パッケージの `test:db` 側の独立性が壊れている。
 */
function findDbTestPackages() {
  const listed = spawnSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (listed.status !== 0) {
    throw new Error(
      `ワークスペースの一覧取得に失敗しました (pnpm list, exit ${listed.status}):\n${listed.stderr ?? ""}`,
    );
  }
  /** @type {{ name: string; path: string }[]} */
  const projects = JSON.parse(listed.stdout);
  const candidates = projects
    .filter((project) => project.path !== repoRoot.replace(/\/$/, ""))
    .map((project) => {
      try {
        const manifest = JSON.parse(readFileSync(`${project.path}/package.json`, "utf8"));
        return { name: project.name, manifest };
      } catch {
        return null;
      }
    })
    .filter((project) => project !== null && Boolean(project.manifest.scripts?.[DB_SCRIPT]));

  const names = new Set(candidates.map((c) => c.name));
  /** @type {Map<string, Set<string>>} 各パッケージ名 → 対象内で依存している名前の集合 */
  const dependsOn = new Map(candidates.map((c) => [c.name, new Set()]));
  for (const c of candidates) {
    const deps = { ...c.manifest.dependencies, ...c.manifest.devDependencies };
    for (const depName of Object.keys(deps ?? {})) {
      if (names.has(depName)) {
        dependsOn.get(c.name).add(depName);
      }
    }
  }

  const sorted = [];
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of dependsOn.get(name)) visit(dep);
    sorted.push(name);
  }
  for (const name of [...names].sort()) visit(name);
  return sorted;
}

const allPackages = findDbTestPackages();

// `MNEMORA_DB_TESTS_SKIP`(カンマ区切りのパッケージ名)に挙げたパッケージは、DB 在りでも走らせない。使うのは CI の `root-gate-db-stage` だけ(ADR 0015 の 2026-09-28 追記)。
// 黙って外さない: 外したものは名前を挙げて出し、知らない名前(綴りの誤り・改名の取り残し)が混ざっていたら赤にする。
const skipRequested = (process.env.MNEMORA_DB_TESTS_SKIP ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const unknownSkips = skipRequested.filter((name) => !allPackages.includes(name));
if (unknownSkips.length > 0) {
  console.error(
    `MNEMORA_DB_TESTS_SKIP に ${DB_SCRIPT} を持たないパッケージが在ります: ${unknownSkips.join(", ")}`,
  );
  process.exit(2);
}
const skipped = allPackages.filter((name) => skipRequested.includes(name));
const packages = allPackages.filter((name) => !skipRequested.includes(name));
if (allPackages.length > 0 && packages.length === 0) {
  // 全部外すと何も走らせずに「通りました」を出してしまう(ADR 0015)。
  console.error(`MNEMORA_DB_TESTS_SKIP が ${DB_SCRIPT} を持つパッケージを全部外しています`);
  process.exit(2);
}

if (allPackages.length === 0) {
  process.exit(0);
}

const listing = allPackages.map((name) => `    - ${name} (${DB_SCRIPT})`).join("\n");
const runListing = packages.map((name) => `    - ${name} (${DB_SCRIPT})`).join("\n");
const skipListing = skipped
  .map((name) => `    - ${name} (${DB_SCRIPT}、MNEMORA_DB_TESTS_SKIP で外した)`)
  .join("\n");

if (!process.env.DATABASE_URL) {
  console.log(
    [
      "",
      BANNER,
      "⚠ DB テストは実行していません（DATABASE_URL が未設定）",
      "",
      "  実行しなかったもの:",
      listing,
      "",
      "  この門が緑であることは、DB 側を見たことになりません。",
      "  DB 側も通すには、本物の Postgres + pgvector を指してから同じ門を実行すること:",
      "",
      "    DATABASE_URL=postgresql://... pnpm run test",
      "",
      BANNER,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// ⛔ 歯は1本も弱めない。接続先が何であるかを必ず1行出すだけ。
const serverLines = formatServerLines(
  describeDatabaseServer(process.env.DATABASE_URL, `${repoRoot}packages/postgres`),
);

console.log(
  [
    "",
    BANNER,
    "DATABASE_URL が設定されているため、DB テストを実行します",
    "",
    ...serverLines,
    "",
    "  対象:",
    runListing,
    ...(skipped.length > 0 ? ["", "  この段では実行しないもの:", skipListing] : []),
    "",
    BANNER,
    "",
  ].join("\n"),
);

// 一発の `pnpm --recursive ...` には戻さない(冒頭参照)。
// このスクリプトの引数は各 `test:db` へそのまま渡す。ルートの門は何も渡さないので、CI・手元の振る舞いは変わらない。
const forwardedArgs = process.argv.slice(2);

for (const name of packages) {
  const run = spawnSync("pnpm", ["--filter", name, "run", DB_SCRIPT, ...forwardedArgs], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (run.status !== 0) {
    console.log(["", BANNER, `✗ DB テストが落ちました（${name}）。`, BANNER, ""].join("\n"));
    process.exit(run.status === null ? 1 : run.status);
  }
}

console.log(
  [
    "",
    BANNER,
    "✔ DB テストも実行し、通りました。",
    ...(skipped.length > 0
      ? [`  ⚠ この段では実行していない: ${skipped.join(", ")}（MNEMORA_DB_TESTS_SKIP）`]
      : []),
    BANNER,
    "",
  ].join("\n"),
);
