#!/usr/bin/env node
/**
 * 北極星「目指す姿」7項目の既定差分を、ワークスペース内から組んだ `Runtime` に対して
 * 観測し、Job Summary 向けの一覧を印字する（Issue #387 / ADR 0216 決定7「段1」）。
 *
 * ## これは何をする道具か
 *
 * `@mnemora/core` と `@mnemora/testkit`（`./fixtures` 入口を含む）の**公開入口だけ**を
 * import し、in-memory ストア + `DeterministicLLMProvider`/`DeterministicEmbeddingProvider` +
 * 注入した `Clock` + `node:crypto` の `hashContent` で `Runtime` を組む（ADR 0216 測定4）。
 * DB・API キー・ネットワークは一切使わない。
 *
 * 実際に何を観測するか（7項目それぞれの甲/乙/丙の分類、観測のやり方）は
 * `./north-star-probe-runtime.mjs` に集約してある——**段2（`./north-star-tarball-probe.mjs`、
 * `pnpm pack` した tarball を `npm install` した先から組む）と、このロジックを共有する**。
 * 段1・段2で違うのはここ（`mods` をどこから import するか）だけであり、観測ロジック自体は
 * 複製しない。
 *
 * ## これは何をしない道具か
 *
 * - ⛔ **判定しない。** 7項目の充足判定は `docs/roadmap.md` が正であり続ける
 *   （ADR 0216 決定8）。「差が出た/出なかった/観測に失敗した」という事実だけを書く。
 * - ⛔ **門ではない。常に exit 0。** 個々の観測を try/catch で包み、失敗は
 *   「印字に失敗した: <理由>」として一覧に出す。トップレベルの import 失敗も
 *   動的 import + 最上位の try/catch で握る。
 * - ⛔ **段1はワークスペース解決であり、出荷物（tarball）ではない。**`pnpm pack` で
 *   作った tarball を `/tmp` へ install して測る段2（ADR 0216 決定7・決定5）は、
 *   `./north-star-tarball-probe.mjs`（手動起動専用ワークフロー）の仕事であり、
 *   このスクリプトの範囲外。
 * - ⛔ **`packages/postgres` を1バイトも測らない**（ADR 0216 決定6）。
 *
 * ## 決定性のための細工（ADOPTER-SUPPLIED の対象外）
 *
 * 項目2・5・7 の一部は `VectorStore.upsert` で直接ベクトルを上書きし、
 * `DeterministicEmbeddingProvider` 自身のハッシュ挙動（文字コード和、意味を持たない）
 * には依存しない形でシナリオを組み立てている。これは probe が決定的な再現性を作るための
 * 試験用の配線であり、ADR 0216 決定4-2 の ADOPTER-SUPPLIED（採用者が実際に供給する
 * もの）の集計対象ではない——該当箇所（`./north-star-probe-runtime.mjs`）にその旨を
 * コメントで明記してある。
 *
 * 組み立ては `./north-star-default-probe-lib.mjs` の純関数（登録簿・正典との突き合わせ・
 * ADOPTER-SUPPLIED 集計・Markdown 組み立て）に委ねる（`association-summary.mjs` と
 * 同じ分担）。
 *
 * 使い方: `node scripts/north-star-default-probe.mjs`（標準出力へ Markdown を吐く）。
 * CI では `>> "$GITHUB_STEP_SUMMARY"` で Job Summary に流し込む。
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

    // 公開入口だけを動的 import する——ここで失敗しても（例: ワークスペースを
    // build していない）、トップレベルの catch が拾って exit 0 のまま Markdown を出す。
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

    // ADOPTER-SUPPLIED の印は観測ロジック本体（north-star-probe-runtime.mjs）に書いてある
    // ——段1・段2 で同じ probe ロジックを使う以上、印の件数もこの1ファイルを数えれば足りる。
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
// **明示的に 0 を宣言する**——個々の観測が失敗していても、ここまで来たら
// トップレベルの制御は壊れていない。このスクリプトは門ではない（ADR 0216 決定7）。
process.exit(0);
