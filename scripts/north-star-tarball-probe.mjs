#!/usr/bin/env node
/**
 * ⛔ 判定しない(ADR 0216 決定8)。差の有無・観測失敗という事実だけを書く。
 * ⛔ 門ではない。常に exit 0(手動起動専用で、required status check ではない)。
 * ⛔ `publish.yml` にも publish の経路にも触らない。ここで作る tarball は install して観測するためだけで、upload しない。
 * ⛔ 件数・一覧をハードコードしない。`PUBLISH_TARGETS` を都度 import する。
 * ⛔ 観測ロジックを複製しない。`north-star-probe-runtime.mjs` の `runAllNorthStarItems` を呼ぶだけ。
 *
 * ⚠ 段1より重い(pack を対象数だけ実行し、prepack が tsc を再実行し、npm install が registry から取得する)。
 * build ジョブに相乗りさせず、専用の手動起動ワークフローに置く(ADR 0216 決定7)。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  NORTH_STAR_ITEM_REGISTRY,
  buildFatalFallbackMarkdown,
  buildRegistryReport,
  buildSummaryMarkdown,
  countAdopterSuppliedMarks,
  extractGoalStatements,
} from "./north-star-default-probe-lib.mjs";
import { makeHashContent, notMeasuredItemResults } from "./north-star-probe-runtime.mjs";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const NORTH_STAR_PATH = join(REPO_ROOT, "docs", "north-star.md");
const PROBE_RUNTIME_PATH = join(SCRIPTS_DIR, "north-star-probe-runtime.mjs");
const PACK_SCRIPT_PATH = join(SCRIPTS_DIR, "pack-publish-targets.mjs");

const hashContent = makeHashContent(createHash);

const PROBE_IMPORT_SPECIFIERS = ["@mnemora/core", "@mnemora/testkit", "@mnemora/testkit/fixtures"];

function describeSpawnFailure(label, result) {
  if (result.error) {
    return `${label} の起動に失敗した: ${result.error.message}`;
  }
  const stderrTail = (result.stderr ?? "").slice(-4000);
  const stdoutTail = (result.stdout ?? "").slice(-2000);
  return (
    `${label} が exit ${result.status} で終わった。\n` +
    `--- stderr（末尾） ---\n${stderrTail}\n--- stdout（末尾） ---\n${stdoutTail}`
  );
}

/**
 * ⛔ pack のロジックを複製せず、`pack-publish-targets.mjs` をサブプロセスとして呼ぶ。
 *
 * @returns {{ ok: true, tarballPaths: string[] } | { ok: false, reason: string }}
 */
function packTarballs(packDestDir) {
  const result = spawnSync(process.execPath, [PACK_SCRIPT_PATH, packDestDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { ok: false, reason: describeSpawnFailure("scripts/pack-publish-targets.mjs", result) };
  }
  let orderText;
  try {
    orderText = readFileSync(join(packDestDir, "publish-order.txt"), "utf8");
  } catch (error) {
    return {
      ok: false,
      reason:
        "pack は exit 0 で終わったが publish-order.txt を読めなかった: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
  const tarballPaths = orderText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (tarballPaths.length === 0) {
    return {
      ok: false,
      reason: "publish-order.txt が空だった（tarball が1つも記録されていない）。",
    };
  }
  return { ok: true, tarballPaths };
}

/**
 * ⚠ `--omit=peer` は渡さない。`@mnemora/testkit` の主入口は適合テスト一式を無条件に re-export し、
 * それらが vitest を使うため、vitest(peer)が無いと主入口の import で `ERR_MODULE_NOT_FOUND` になる
 * (実測。ADR 0216 引き受けた負債5)。
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function installTarballs(installDir, tarballPaths) {
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify(
      {
        name: "mnemora-north-star-tarball-probe-consumer",
        private: true,
        version: "0.0.0",
      },
      null,
      2,
    ) + "\n",
  );
  const fileSpecs = tarballPaths.map((p) => `file:${p}`);
  const result = spawnSync("npm", ["install", "--no-audit", "--no-fund", ...fileSpecs], {
    cwd: installDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { ok: false, reason: describeSpawnFailure("npm install", result) };
  }
  return { ok: true };
}

/**
 * ⚠ サブプロセスを起こさない。ESM の bare specifier 解決は、呼び出し元ではなく入口ファイル自身の位置から
 * `node_modules` を探す。入口ファイルを install 先に書けば、install 先が解決される。
 *
 * @returns {Promise<{
 *   resolvedPaths: Record<string, string>,
 *   resolutionErrors: Record<string, string>,
 *   itemResults: object[] | null,
 *   importError: string | null,
 * }>}
 */
async function runProbeFromInstallDir(installDir) {
  const entryPath = join(installDir, "probe-entry.mjs");
  const runtimeUrl = pathToFileURL(PROBE_RUNTIME_PATH).href;
  const entrySource = `
import { runAllNorthStarItems } from ${JSON.stringify(runtimeUrl)};

export async function runTarballProbe(hashContent) {
  const resolvedPaths = {};
  const resolutionErrors = {};
  for (const spec of ${JSON.stringify(PROBE_IMPORT_SPECIFIERS)}) {
    try {
      resolvedPaths[spec] = import.meta.resolve(spec);
    } catch (error) {
      resolutionErrors[spec] = error instanceof Error ? error.message : String(error);
    }
  }

  let itemResults = null;
  let importError = null;
  try {
    const [core, testkit, fixtures] = await Promise.all([
      import("@mnemora/core"),
      import("@mnemora/testkit"),
      import("@mnemora/testkit/fixtures"),
    ]);
    const mods = {
      createRuntime: core.createRuntime,
      DeterministicLLMProvider: testkit.DeterministicLLMProvider,
      DeterministicEmbeddingProvider: testkit.DeterministicEmbeddingProvider,
      InMemoryMemoryStore: fixtures.InMemoryMemoryStore,
      InMemoryVectorStore: fixtures.InMemoryVectorStore,
      InMemoryEventStore: fixtures.InMemoryEventStore,
      InMemoryOutboxStore: fixtures.InMemoryOutboxStore,
      InMemoryTenantSettingsStore: fixtures.InMemoryTenantSettingsStore,
    };
    itemResults = await runAllNorthStarItems(mods, hashContent);
  } catch (error) {
    importError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }

  return { resolvedPaths, resolutionErrors, itemResults, importError };
}
`;
  writeFileSync(entryPath, entrySource);
  const entryModule = await import(pathToFileURL(entryPath).href);
  return entryModule.runTarballProbe(hashContent);
}

function allMeasuredItemsFailed(reason) {
  const [item3, item4] = notMeasuredItemResults();
  const failed = (item) => ({ item, mode: "print-failed", fact: `観測に失敗した: ${reason}` });
  return [failed(1), failed(2), item3, item4, failed(5), failed(6), failed(7)];
}

function buildTarballInstallSection({
  packResult,
  installDir,
  installDirReal,
  repoRootReal,
  installResult,
  probeOutcome,
}) {
  const lines = ["## tarball install の経路（段2、ADR 0216 決定5）", ""];

  lines.push(
    `対象（scripts/publish-targets.mjs の PUBLISH_TARGETS、${PUBLISH_TARGETS.length}件）: ` +
      PUBLISH_TARGETS.map((t) => t.name).join(" / "),
    "",
  );

  if (!packResult.ok) {
    lines.push(
      "🔴 **pnpm pack（scripts/pack-publish-targets.mjs）に失敗した:**",
      "",
      "```",
      packResult.reason,
      "```",
    );
    return lines.join("\n");
  }
  lines.push(
    `pack: ${packResult.tarballPaths.length}件の tarball を作った（publish 順）。`,
    ...packResult.tarballPaths.map((p) => `  - ${p}`),
    "",
  );

  lines.push(
    `install 先（os.tmpdir() 配下、repo の外）: \`${installDir}\``,
    `install 先の realpath: \`${installDirReal}\``,
    `repo root の realpath: \`${repoRootReal}\``,
    `⟹ install 先は repo root の配下${installDirReal.startsWith(repoRootReal) ? "**である**（🔴 想定外）" : "ではない（確認できた）"}。`,
    "",
    "install コマンド: `npm install --no-audit --no-fund <tarball×" +
      `${packResult.tarballPaths.length}>\`（peer も含めて install する。\`@mnemora/testkit\`` +
      " の主入口を import すると `peerDependencies.vitest` が実際に要る——理由は下の" +
      "「node_modules 解決の確認」の直後、probe 実行結果を見ること。ADR 0216 決定5・" +
      "引き受けた負債5）。",
    "",
  );

  if (!installResult.ok) {
    lines.push("🔴 **npm install に失敗した:**", "", "```", installResult.reason, "```");
    return lines.join("\n");
  }
  lines.push("install: exit 0。", "");

  lines.push("### node_modules 解決の確認（decision5「repo の外であることを確かめる」）", "");
  for (const spec of PROBE_IMPORT_SPECIFIERS) {
    const resolved = probeOutcome.resolvedPaths[spec];
    const error = probeOutcome.resolutionErrors[spec];
    if (error) {
      lines.push(`- \`${spec}\`: 🔴 解決に失敗した: ${error}`);
      continue;
    }
    const resolvedPath = fileURLToPath(resolved);
    const underInstallDir =
      resolvedPath.startsWith(installDirReal) || resolvedPath.startsWith(installDir);
    const underRepoRoot =
      resolvedPath.startsWith(repoRootReal) || resolvedPath.startsWith(REPO_ROOT);
    lines.push(
      `- \`${spec}\` → \`${resolved}\`` +
        `（install 先の配下: ${underInstallDir ? "はい" : "🔴 いいえ"} / repo 配下: ${underRepoRoot ? "🔴 はい" : "いいえ"}）`,
    );
  }
  lines.push("");

  if (probeOutcome.importError) {
    lines.push(
      "🔴 **probe 本体（@mnemora/core 等の import・Runtime の組み立て）が失敗した:**",
      "",
      "```",
      probeOutcome.importError,
      "```",
    );
  }

  return lines.join("\n");
}

async function main() {
  let markdown;
  let workDir = null;
  try {
    let canonError = null;
    let statements = [];
    try {
      const northStarText = readFileSync(NORTH_STAR_PATH, "utf8");
      const extracted = extractGoalStatements(northStarText);
      if (extracted.ok) {
        statements = extracted.statements;
      } else {
        canonError = extracted.error;
      }
    } catch (error) {
      canonError = `docs/north-star.md を読めなかった: ${error instanceof Error ? error.message : String(error)}`;
    }
    const registryReport = buildRegistryReport(statements, NORTH_STAR_ITEM_REGISTRY);

    workDir = mkdtempSync(join(tmpdir(), "mnemora-north-star-tarball-probe-"));
    const packDestDir = join(workDir, "pack");
    const installDir = join(workDir, "install");
    mkdirSync(packDestDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });

    const repoRootReal = realpathSync(REPO_ROOT);
    const installDirReal = realpathSync(installDir);

    let itemResults;
    let probeOutcome = {
      resolvedPaths: {},
      resolutionErrors: {},
      itemResults: null,
      importError: null,
    };
    const packResult = packTarballs(packDestDir);
    let installResult = { ok: false, reason: "pack が失敗したため install していない。" };

    if (!packResult.ok) {
      itemResults = allMeasuredItemsFailed(`pnpm pack に失敗した（詳細は下の節）。`);
    } else {
      installResult = installTarballs(installDir, packResult.tarballPaths);
      if (!installResult.ok) {
        itemResults = allMeasuredItemsFailed(`npm install に失敗した（詳細は下の節）。`);
      } else {
        probeOutcome = await runProbeFromInstallDir(installDir);
        if (probeOutcome.itemResults) {
          itemResults = probeOutcome.itemResults;
        } else {
          itemResults = allMeasuredItemsFailed(
            `probe 本体の import/実行に失敗した（詳細は下の節）。`,
          );
        }
      }
    }

    const runtimeSource = readFileSync(PROBE_RUNTIME_PATH, "utf8");
    const adopterSuppliedTally = countAdopterSuppliedMarks(runtimeSource);

    const tarballInstallSection = buildTarballInstallSection({
      packResult,
      installDir,
      installDirReal,
      repoRootReal,
      installResult,
      probeOutcome,
    });

    markdown = buildSummaryMarkdown({
      stage: {
        label: "段2（tarball を install して測った）",
        scopeNote:
          "⚠ **段2: `pnpm pack` で作った tarball を、workspace の外（`os.tmpdir()` 配下）に" +
          "作った空の package へ `npm install` した状態で測っている**（ADR 0216 決定7・" +
          "決定5）。段1（`scripts/north-star-default-probe.mjs`）と**同じ probe ロジック**" +
          "（`scripts/north-star-probe-runtime.mjs`）を、install 先に置いた入口ファイルから" +
          "`@mnemora/core` / `@mnemora/testkit` を import して走らせている——workspace 解決は" +
          "経由しない。下の「tarball install の経路」節に、install 先の絶対パスと、実際に" +
          "解決した import 先が repo の外であることの確認を書く。",
      },
      registryReport,
      canonError,
      itemResults,
      adopterSuppliedTally,
      generatedAt: new Date().toISOString(),
      extraSections: [tarballInstallSection],
      extraCaveats: [
        "vitest は `npm install` の通常の peer 解決（registry から取得）に任せている。" +
          "`--save-exact` 等でバージョンを固定していないため、`@mnemora/testkit` の" +
          "`peerDependencies.vitest`（`^5.0.0`）を満たす最新版が入る——段1（workspace の" +
          "`vitest 5.0.0` 固定）と厳密に同じ版とは限らない。",
        "`PUBLISH_TARGETS` 全件（`@mnemora/openai` / `@mnemora/anthropic` / " +
          "`@mnemora/postgres` / `@mnemora/local-embedding` を含む）を pack・install するが、" +
          "probe が実際に import するのは `@mnemora/core` / `@mnemora/testkit` だけである。" +
          "他4パッケージは「install できること」までしか確認しておらず、その中身（型・" +
          "エントリポイント）はこの段では動かしていない（`pnpm run pack:check` が別途見る）。",
        "この段が使う `PUBLISH_TARGETS` の版は作業ツリーの `package.json` にある版であり、" +
          "リリース時に `--expect-version` で検査される tag との一致は見ていない" +
          "（`scripts/apply-release-version.mjs` はこの段では走らない）。",
        "同じ tmpdir 配下でも、CI runner とローカル環境で `npm` の実際の解決結果（lockfile を" +
          "持たない `npm install` の非決定性）が完全に一致することまでは確かめていない。",
      ],
    });
  } catch (error) {
    markdown = buildFatalFallbackMarkdown(error);
  } finally {
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // 後片付けの失敗は無視する(門ではない)。
      }
    }
  }
  console.log(markdown);
}

await main();
// ⛔ 門ではない。個々の観測が失敗していても exit 0 を明示する(ADR 0216 決定7)。
process.exit(0);
