#!/usr/bin/env node
/**
 * ⛔ 作業ツリーの package.json を見るだけにせず、tarball の中身を見る。`dist/` が無くても `pnpm pack` は
 * exit 0・エラー出力なしで `package/package.json` だけの tarball を出し、`workspace:*` は `npm pack` では
 * そのまま残る（`pnpm pack` は実版へ置換する）。梱包は pnpm で、この門も `npm pack` を使わない。
 * ⚠ アップロード（`publish`）は npm（Trusted Publishing と provenance は npm CLI 側にある）。
 * この門が測るのは、その手前の tarball の中身まで。
 * ⛔ 対象は `./publish-targets.mjs` の固定リストで、動的に発見しない。publish 対象と非対象を分ける
 * 機械的な目印が無い（`private` の有無は目印として弱い）。新しい publish 対象が増えたら手で足す。
 * 見落としは機械的には検知できない。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";
import {
  findWorkspaceProtocolViolations,
  findMissingEntryPoints,
  findMissingReadme,
  findVersionViolations,
  findVersionSkewViolations,
  findPublishAccessViolations,
  findOrphanedSourceMaps,
  findLicenseViolations,
  findPrivateViolations,
  findExactPinnedDependencyViolations,
  EXACT_PINNED_DEPENDENCY_EXEMPTIONS,
  NEVER_PUBLISHED_TARGETS,
} from "./publish-pack-checks.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const BANNER = "─".repeat(72);

/** 判定関数の本体は `./publish-pack-checks.mjs` に置く。`pnpm pack` を走らせずに合成フィクスチャで直接呼べるようにするため。 */

function packOne(target, destDir) {
  const pkgDir = join(repoRoot, target.dir);
  const result = spawnSync("pnpm", ["pack", "--pack-destination", destDir], {
    cwd: pkgDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm pack が失敗しました（${target.name}, exit ${result.status}）:\n${result.stderr ?? result.stdout ?? ""}`,
    );
  }
  const tarballs = readdirSync(destDir).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(
      `${target.name} の pack 先に tarball が ${tarballs.length} 個ありました（1個のはず）: ${tarballs.join(", ")}`,
    );
  }
  return join(destDir, tarballs[0]);
}

function extractTarball(tarballPath, destDir) {
  const result = spawnSync("tar", ["xzf", tarballPath, "-C", destDir], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar xzf に失敗しました（${tarballPath}）:\n${result.stderr ?? ""}`);
  }
  return join(destDir, "package");
}

console.log(
  [
    "",
    BANNER,
    `publish 梱包の門: 対象${PUBLISH_TARGETS.length}パッケージを pnpm pack し、tarball の中身を検査します`,
    "",
    "  対象:",
    ...PUBLISH_TARGETS.map((t) => `    - ${t.name} (${t.dir})`),
    "",
    "  検査項目:",
    "    1. workspace: プロトコルが依存に残っていないこと",
    `    2. version が 0.0.0 でなく、NEVER_PUBLISHED_TARGETS を除く対象が同じ版であること`,
    "    3. main / types / bin / exports の指すファイルが tarball 内に実在すること",
    "    4. README.md が tarball に入っていること",
    '    5. publishConfig.access が "public" であること',
    "    6. 宙に浮いた source map（*.map の sources が tarball 内に無い）が無いこと",
    '    7. license が "MIT" であり、LICENSE ファイルが tarball に入っていること（ADR 0061）',
    "    8. private が立っていないこと（ADR 0066 で publish を始める判断が下った）",
    "    9. dependencies（実行時依存）が完全固定でなく範囲指定であること（除外分を除く。Issue #166 / ADR 0112）",
    BANNER,
    "",
  ].join("\n"),
);

/** ⛔ 「いま見た${N}パッケージ」は `PUBLISH_TARGETS` から動的に作る（数を直書きしない）。 */
const SCOPE_CAVEAT_MARKER = "⚠ この門が見ていない範囲:";

/** @param {{ name: string; dir: string }[]} targets */
function buildScopeCaveat(targets) {
  const names = targets.map((t) => t.name).join(" / ");
  return [
    "",
    SCOPE_CAVEAT_MARKER,
    "  対象は scripts/publish-targets.mjs の PUBLISH_TARGETS（固定リスト・手で保守）である。",
    `  いま見たのは ${targets.length} パッケージ（${names}）だけで、`,
    "  このリストに載っていない publish 対象が在っても、この門は気づけない",
    "  （publish 対象と非対象を分ける機械的な目印が無い。ADR 0066 / ADR 0255）。",
    "",
  ].join("\n");
}

/** @type {string[]} */
const violations = [];
/** @type {{ name: string; version: string }[]} */
const versions = [];
const cleanupDirs = [];

try {
  for (const target of PUBLISH_TARGETS) {
    const workDir = mkdtempSync(join(tmpdir(), "mnemora-pack-check-"));
    cleanupDirs.push(workDir);
    const packDestDir = join(workDir, "pack");
    const extractDestDir = join(workDir, "extract");
    mkdirSync(packDestDir, { recursive: true });
    mkdirSync(extractDestDir, { recursive: true });

    console.log(`  [${target.name}] pnpm pack ...`);

    let tarballPath;
    try {
      tarballPath = packOne(target, packDestDir);
    } catch (error) {
      violations.push(`[${target.name}] ${error.message}`);
      continue;
    }

    const packageDir = extractTarball(tarballPath, extractDestDir);
    const manifestPath = join(packageDir, "package.json");
    /** @type {Record<string, unknown>} */
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      violations.push(
        `[${target.name}] tarball 内の package/package.json が読めません: ${error.message}`,
      );
      continue;
    }

    const workspaceViolations = findWorkspaceProtocolViolations(manifest);
    for (const v of workspaceViolations) {
      violations.push(`[${target.name}] workspace: プロトコルが残っています: ${v}`);
    }

    if (NEVER_PUBLISHED_TARGETS.has(target.name)) {
      console.log(
        `  [${target.name}] version 検査を対象外にしました（git 上の version は 0.0.0 のままでよい。` +
          "NEVER_PUBLISHED_TARGETS）",
      );
    } else {
      const versionViolations = findVersionViolations(manifest);
      for (const v of versionViolations) {
        violations.push(`[${target.name}] ${v}`);
      }
      if (versionViolations.length === 0) {
        versions.push({ name: target.name, version: manifest.version });
      }
    }

    const missingEntryPoints = findMissingEntryPoints(manifest, packageDir);
    for (const m of missingEntryPoints) {
      violations.push(`[${target.name}] tarball 内に実在しないエントリポイント: ${m}`);
    }

    const missingReadme = findMissingReadme(packageDir);
    for (const r of missingReadme) {
      violations.push(`[${target.name}] ${r}`);
    }

    const publishAccessViolations = findPublishAccessViolations(manifest);
    for (const p of publishAccessViolations) {
      violations.push(`[${target.name}] ${p}`);
    }

    const orphanedMaps = findOrphanedSourceMaps(packageDir);
    for (const o of orphanedMaps) {
      violations.push(`[${target.name}] 宙に浮いた source map: ${o}`);
    }

    const licenseViolations = findLicenseViolations(manifest, packageDir);
    for (const l of licenseViolations) {
      violations.push(`[${target.name}] ${l}`);
    }

    const privateViolations = findPrivateViolations(manifest);
    for (const p of privateViolations) {
      violations.push(`[${target.name}] ${p}`);
    }

    const exactPinnedViolations = findExactPinnedDependencyViolations(
      manifest,
      EXACT_PINNED_DEPENDENCY_EXEMPTIONS[target.name] ?? [],
    );
    for (const e of exactPinnedViolations) {
      violations.push(`[${target.name}] ${e}`);
    }
  }

  // NEVER_PUBLISHED_TARGETS は対象数からも外す（揃っているかを問う対象ではない）。
  const publishedTargetCount = PUBLISH_TARGETS.filter(
    (t) => !NEVER_PUBLISHED_TARGETS.has(t.name),
  ).length;
  const versionSkewViolations = findVersionSkewViolations(versions, publishedTargetCount);
  violations.push(...versionSkewViolations);
} finally {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (violations.length > 0) {
  console.log(
    [
      "",
      BANNER,
      `✗ 違反が ${violations.length} 件見つかりました`,
      "",
      ...violations.map((v) => `  - ${v}`),
      "",
      BANNER,
      "",
    ].join("\n"),
  );
  console.log(buildScopeCaveat(PUBLISH_TARGETS));
  process.exit(1);
}

console.log(["", BANNER, "✔ publish 梱包の門を通りました。", BANNER, ""].join("\n"));
console.log(buildScopeCaveat(PUBLISH_TARGETS));
