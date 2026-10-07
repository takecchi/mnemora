#!/usr/bin/env node
/**
 * ⛔ 判定しない。差が出た/出なかった/観測に失敗した、という事実だけを書く。
 * 7項目の充足判定は `docs/north-star-paths.md` が持つ(ADR 0216 決定8)。
 * ⛔ 門ではない。常に exit 0。個々の観測も、トップレベルの import 失敗も握って一覧に出す。
 * ⛔ 段1はワークスペース解決であり、出荷物(tarball)ではない。tarball の観測は段2の `north-star-tarball-probe.mjs` の仕事。
 * ⛔ `packages/postgres` を測らない(ADR 0216 決定6)。
 * ⛔ 観測ロジックは `north-star-probe-runtime.mjs` に集約し、段2と共有する。複製しない。
 *
 * 項目2・5・7 は `VectorStore.upsert` で直接ベクトルを上書きしてシナリオを決定的にしている。
 * これは試験用の配線で、ADR 0216 決定4-2 の ADOPTER-SUPPLIED の集計対象ではない。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NORTH_STAR_ITEM_REGISTRY,
  buildFatalFallbackMarkdown,
  buildRegistryReport,
  buildSummaryMarkdown,
  countAdopterSuppliedMarks,
  extractGoalStatements,
} from "./north-star-default-probe-lib.mjs";
import { makeHashContent, runAllNorthStarItems } from "./north-star-probe-runtime.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = join(SCRIPTS_DIR, "..");
const NORTH_STAR_PATH = join(REPO_ROOT, "docs", "north-star.md");
const PROBE_RUNTIME_PATH = join(SCRIPTS_DIR, "north-star-probe-runtime.mjs");

const hashContent = makeHashContent(createHash);

async function main() {
  let markdown;
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

    // 公開入口だけを動的 import する。失敗(例: ワークスペースが未 build)してもトップレベルの catch が拾い、exit 0 のまま Markdown を出す。
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

    const itemResults = await runAllNorthStarItems(mods, hashContent);

    // ADOPTER-SUPPLIED の印は観測ロジック本体(north-star-probe-runtime.mjs)に在り、段1・段2で共有するので、この1ファイルを数えれば足りる。
    const runtimeSource = readFileSync(PROBE_RUNTIME_PATH, "utf8");
    const adopterSuppliedTally = countAdopterSuppliedMarks(runtimeSource);

    markdown = buildSummaryMarkdown({
      stage: {
        label: "段1",
        scopeNote:
          "⚠ **段1: ワークスペース解決で測っている。出荷物（tarball）で測ったとは名乗らない**" +
          "（ADR 0216 決定7）。ワークスペース内から `@mnemora/core` / `@mnemora/testkit` の" +
          "公開入口だけを import して組んだ `Runtime` に対する観測であり、`pnpm pack` で作った" +
          "tarball を install した状態（段2、`.github/workflows/north-star-tarball-probe.yml` の" +
          "手動起動。`scripts/north-star-tarball-probe.mjs`）ではない。段1が通っても段2が" +
          "落ちることはありうる。",
      },
      registryReport,
      canonError,
      itemResults,
      adopterSuppliedTally,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    markdown = buildFatalFallbackMarkdown(error);
  }
  console.log(markdown);
}

await main();
// ⛔ 門ではない。個々の観測が失敗していても exit 0 を明示する(ADR 0216 決定7)。
process.exit(0);
