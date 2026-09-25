#!/usr/bin/env node
/**
 * 北極星「目指す姿」7項目の既定差分を、**tarball を `npm install` した先**から観測する
 * （Issue #387 / ADR 0216 決定7「段2」）。
 *
 * ## これは何をする道具か（ADR 0216 決定5 の経路をそのまま実装する）
 *
 * ```
 * scripts/publish-targets.mjs の PUBLISH_TARGETS を import する
 *   → 既存の pack の段（scripts/pack-publish-targets.mjs、内部は check-publish-pack.mjs と
 *     同じ pnpm pack）で tarball を作る
 *   → ⭐ ワークスペースの外（os.tmpdir() 配下）に空の package を作り、tarball を npm install する
 *   → その中に置いた入口ファイルが @mnemora/core / @mnemora/testkit からだけ import して、
 *     段1（scripts/north-star-default-probe.mjs）と同じ probe ロジック
 *     （scripts/north-star-probe-runtime.mjs）を走らせる
 * ```
 *
 * **観測ロジックそのものは複製しない**——段1・段2ともに `./north-star-probe-runtime.mjs`
 * の `runAllNorthStarItems` を呼ぶだけであり、違うのは `mods`（`createRuntime` 等）を
 * どこから import したかだけである。
 *
 * ### node_modules 解決が repo へ登らないことの確認（ADR 0216 決定5）
 *
 * ESM の bare specifier 解決（`import "@mnemora/core"`）は、**呼び出し元のモジュール自身の
 * ファイル位置**を起点に `node_modules` を遡る（Node の仕様。プロセスの cwd には依らない）。
 * この段では、`@mnemora/*` を import する入口ファイル自体を install 先ディレクトリ
 * （`os.tmpdir()` 配下）に書き出し、そこから `import()` する——だから
 * **サブプロセスを起こさなくても**、その入口ファイルの `import.meta.resolve` は
 * install 先の `node_modules` を見る。install 先が repo の外（`os.tmpdir()` 配下）にある限り、
 * 遡りが repo の `node_modules` に届くことは（ディレクトリ階層上）ありえない——それでも
 * 「実際にどこを解決したか」を `import.meta.resolve` で読み、install 先の配下であること・
 * repo 配下でないことを、この段の出力に明記する（「言葉ではなく確認」）。
 *
 * ## これは何をしない道具か
 *
 * - ⛔ **判定しない**（ADR 0216 決定8）。「差が出た/出なかった/観測に失敗した」という
 *   事実だけを書く。pack・install・resolve の失敗も「観測に失敗した」として書く。
 * - ⛔ **門ではない。常に exit 0。** このワークフローは required status check ではない
 *   （手動起動専用、`workflow_dispatch` のみ）。
 * - ⛔ **`publish.yml` にも publish の経路にも触らない**（ADR 0216 決定7）。ここで作る
 *   tarball は install して観測するためだけのものであり、どこにも upload しない。
 * - ⛔ **件数・一覧をハードコードしない**（ADR 0216 決定5）。`PUBLISH_TARGETS` を都度 import
 *   し、対象パッケージ数を直書きしない。
 *
 * 使い方: `node scripts/north-star-tarball-probe.mjs`（標準出力へ Markdown を吐く）。
 * CI では `>> "$GITHUB_STEP_SUMMARY"` で Job Summary に流し込む。
 *
 * ⚠ **段1より重い。** `pnpm pack` を `PUBLISH_TARGETS` の数だけ実行し（各パッケージの
 * `prepack` が `tsc` を再度走らせる）、`npm install` で zod 等の実行時依存を registry から
 * 取得する。だから段1（`build` ジョブに相乗り）ではなく、この専用の手動起動ワークフロー
 * に置く（ADR 0216 決定7「(イ) 毎 PR で tarball を作って install するのは費用が合わない」）。
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

/** import される bare specifier だけを、node_modules 解決の確認対象にする。 */
const PROBE_IMPORT_SPECIFIERS = ["@mnemora/core", "@mnemora/testkit", "@mnemora/testkit/fixtures"];

/** `spawnSync` の結果を、観測した事実として文字列化する。 */
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
 * `scripts/pack-publish-targets.mjs`（既存の pack の段、内部は `pnpm pack`）をそのまま
 * サブプロセスとして呼び、`PUBLISH_TARGETS` 全件の tarball を作る。**pack のロジックは
 * ここに複製しない**（ADR 0216 決定5「既存の pack の段」の再利用）。
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
 * `os.tmpdir()` 配下（repo の外）に空の package を作り、tarball を `npm install` する
 * （ADR 0216 決定5「⭐ ワークスペースの外に空の package を作り、tarball を npm install する」）。
 *
 * ⚠ **`--omit=peer` は渡さない（実測して撤回した）。** 最初は「probe が import する
 * `@mnemora/testkit/fixtures` は vitest を import しない（ADR 0216「確かめたこと」の
 * 逐語）ので要らない」と考えて `--omit=peer` を渡していたが、実際に走らせると
 * `@mnemora/testkit` の**主入口**（`index.ts`）が `memory-store-conformance.js` 等の
 * 適合テスト一式を無条件に re-export しており、それらが vitest の `describe`/`it` を
 * 使うため、**主入口を import した時点で** vitest が無いと `ERR_MODULE_NOT_FOUND` で
 * 落ちる（`./fixtures` サブパスだけを import する分には要らないが、この probe は
 * `DeterministicLLMProvider`/`DeterministicEmbeddingProvider` を主入口からも import する
 * ——段1と同じ組み立て）。**実際の adopter が主入口を使うにも vitest（peer）が要る**
 * という、ADR 0216「引き受けた負債5」がまさに名指しした依存を、この段はここで
 * 踏み抜いて確かめた。だから peer もそのまま install する。
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
 * install 先に probe の入口ファイルを書き出し、その場から `import()` する。
 *
 * ⚠ **サブプロセスを起こさない。** ESM の bare specifier 解決は「呼び出し元モジュール自身の
 * ファイル位置」を起点にする——`import()` した側（このスクリプト）の位置ではなく、
 * **入口ファイル自身が置かれた場所**（install 先）を起点に `node_modules` を探す。
 * だから、入口ファイルを install 先ディレクトリに書いた時点で、そこから行う
 * `import("@mnemora/core")` は install 先の node_modules を解決する。
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

/** 全項目（甲・乙）を、共通の理由で「観測に失敗した」として埋める。 */
function allMeasuredItemsFailed(reason) {
  const [item3, item4] = notMeasuredItemResults();
  const failed = (item) => ({ item, mode: "print-failed", fact: `観測に失敗した: ${reason}` });
  return [failed(1), failed(2), item3, item4, failed(5), failed(6), failed(7)];
}

/** tarball install の経路（pack・install・resolve）を、事実だけで報告する Markdown 断片。 */
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
    // install 先自体はまだ何も無いので realpath できるのは mkdirSync 済みの workDir/installDir。
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
        // 後片付けの失敗はこの段の門ではない——無視する。
      }
    }
  }
  console.log(markdown);
}

await main();
// **明示的に 0 を宣言する**——個々の観測が失敗していても、ここまで来たら
// トップレベルの制御は壊れていない。このスクリプトは門ではない（ADR 0216 決定7）。
process.exit(0);
