#!/usr/bin/env node
/**
 * ⛔ 「変わった」ことだけを検出する。「壊れているか」(semver 的に安全か)は判定しない(ADR 0178)。
 * union のメンバー並び替えのような意味的に無変化の変更も赤くする。
 * ⛔ `bin` エントリは対象外。`exports.*.types` だけを起点にする(ADR 0178)。
 * ⛔ 型として書かれていない破壊(実行時の意味変更)は拾わない。
 *
 * `--write` を打つ前に、差分が破壊的変更かどうかを判断し、根拠 ADR にその破壊性を明記すること。
 * この歯の狙いは破壊性の申告を人間に強制することで、`--write` はその申告の後に打つもの。
 *
 * 対象パッケージのリストをここへ複製しない(ADR 0066)。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";
import { buildPublicApiSnapshotText } from "./public-api-surface-lib.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * CI の「Test」段は「Build」段より前にあり、実物の `dist` がまだ無いことがある。
 * そのためテストは実物に対して走らせず、この env var で一時ディレクトリのフィクスチャへ差し替える。
 */
const packagesRoot = process.env.MNEMORA_API_CHECK_PACKAGES_ROOT
  ? resolve(process.env.MNEMORA_API_CHECK_PACKAGES_ROOT)
  : join(repoRoot, "packages");

const snapshotDir = process.env.MNEMORA_API_CHECK_SNAPSHOT_DIR
  ? resolve(process.env.MNEMORA_API_CHECK_SNAPSHOT_DIR)
  : join(repoRoot, "scripts", "__snapshots__", "public-api");

const BANNER = "─".repeat(72);

const write = process.argv.slice(2).includes("--write");

console.log(
  [
    "",
    BANNER,
    `公開 API 表面の門: 対象${PUBLISH_TARGETS.length}パッケージの .d.ts を snapshot と突き合わせます` +
      (write ? "（--write: snapshot を更新します）" : ""),
    "",
    "  対象:",
    ...PUBLISH_TARGETS.map((t) => `    - ${t.name} (${t.dir})`),
    BANNER,
    "",
  ].join("\n"),
);

/** @type {string[]} */
const violations = [];

for (const target of PUBLISH_TARGETS) {
  const packageDir = join(packagesRoot, basename(target.dir));
  const packageJsonPath = join(packageDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const snapshotName = `${basename(target.dir)}.d.ts`;
  const snapshotPath = join(snapshotDir, snapshotName);
  const snapshotRelForMessage = `scripts/__snapshots__/public-api/${snapshotName}`;

  let actual;
  try {
    actual = buildPublicApiSnapshotText(packageDir, packageJson);
  } catch (error) {
    violations.push(`[${target.name}] ${error.message}`);
    continue;
  }

  if (write) {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(snapshotPath, actual, "utf8");
    console.log(`  [${target.name}] snapshot を書きました: ${snapshotRelForMessage}`);
    continue;
  }

  if (!existsSync(snapshotPath)) {
    violations.push(
      `[${target.name}] snapshot が存在しません: ${snapshotRelForMessage}\n` +
        `    新規パッケージか、まだ一度も snapshot を作っていません。中身を読んで破壊的変更が` +
        `無いことを確認してから、\`node scripts/check-public-api-surface.mjs --write\` で作成してください。`,
    );
    continue;
  }

  const expected = readFileSync(snapshotPath, "utf8");
  if (expected === actual) {
    console.log(`  [${target.name}] 差分なし`);
    continue;
  }

  const workDir = mkdtempSync(join(tmpdir(), "mnemora-api-check-"));
  try {
    const actualPath = join(workDir, "actual.d.ts");
    writeFileSync(actualPath, actual, "utf8");
    const diff = spawnSync(
      "diff",
      [
        "-u",
        "--label",
        snapshotRelForMessage,
        "--label",
        `${target.name} (実測)`,
        snapshotPath,
        actualPath,
      ],
      { encoding: "utf8" },
    );
    violations.push(
      `[${target.name}] 公開型シグネチャが snapshot と一致しません。\n\n` +
        `${diff.stdout}\n` +
        `    次にすること（Issue #342 / ADR 0178）:\n` +
        `    1. この差分が破壊的変更かどうかを判断する。\n` +
        `    2. 破壊的変更なら、根拠 ADR にその破壊性を明記する（ADR 0156 は ADR を書くことを免除していない）。\n` +
        `    3. ⚠ 先に \`pnpm run build\` で dist を作り直す——この歯は packages/<name>/dist の .d.ts を読むので、\n` +
        `       dist が古いと「他人が入れた変更が消えた」差分に見え、そのまま --write すると\n` +
        `       その変更を snapshot から消してしまう（歯を無効化する）。\n` +
        `    4. \`node scripts/check-public-api-surface.mjs --write\` で snapshot を更新し、コミットする。\n` +
        `    ⚠ この歯は「変わったこと」だけを見ている。「壊れているか」はここでは判定しない——判断は上の手順のとおり人が行う。`,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (write) {
  console.log(["", BANNER, "✔ snapshot を更新しました。", BANNER, ""].join("\n"));
  process.exit(0);
}

if (violations.length > 0) {
  console.log(
    [
      "",
      BANNER,
      `✗ 違反が ${violations.length} 件見つかりました`,
      "",
      ...violations,
      BANNER,
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(["", BANNER, "✔ 公開 API 表面の門を通りました。", BANNER, ""].join("\n"));
