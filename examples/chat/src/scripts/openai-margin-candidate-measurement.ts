import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import type { Ctx } from "@mnemora/core";
import { OpenAIEmbeddingProvider } from "@mnemora/openai";
import { embeddingCassetteKey } from "@mnemora/testkit";
import type { Cassette } from "@mnemora/testkit";
import { buildEmbeddingOnlyCassette } from "../openai-arm-cassette.js";
import { OPENAI_ARM_GROUPS, buildArmLabel, collectAllTexts } from "../openai-arm-probe-groups.js";
import type { OpenAiArmGroupDescriptor } from "../openai-arm-probe-groups.js";
import { clopperPearsonUpperBound, decideEmbeddingDriftVerdict } from "../openai-arm-verdict.js";
import type { ProxyGroupMetrics } from "../openai-arm-verdict.js";
import {
  DEFAULT_MARGIN_DROP_OPTIONS,
  decideEmbeddingDriftVerdictByMargin,
} from "../verdict-candidate-margin.js";
import { binomialAtLeastK, empiricalKOfNRedRate } from "../verdict-candidate-kofn.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { runIdentifierProbeArm } from "../identifier-arm.js";
import { buildArmTenantId, newRunToken } from "../retrieval-quality.js";
import { OPENAI_EMBEDDING_DIMENSIONS, OPENAI_EMBEDDING_MODEL } from "../providers.js";
import { createUsageMeter } from "../usage-meter.js";
import { tryGitRevParseHead } from "../git-info.js";

/**
 * Issue #109 残件「A」——マネージャーからの実測依頼: ADR 0316 の判定
 * （`decideEmbeddingDriftVerdict`）に対する候補案（margin基準・k-of-n）を、
 * **実 API・同じデータ上**で比べるための、per-probe margin 付きの新規測定。
 *
 * ⛔ **既存の判定コード・CI ジョブ・`ci.yml` は1文字も変えていない。**
 * `examples/chat/src/scripts/openai-embedding-fp-ceiling.ts`（ADR 0316 の測定手順）と
 * ほぼ同じ手順を踏むが、次の3点が違う:
 *
 * 1. **`report.probes`（probe ごとの `margin`）を捨てずに保存する。**
 *    既存スクリプトの `measureGroup` は `ProxyGroupMetrics`（群レベルの集約）だけを
 *    返し、`report.probes` を捨てる——このスクリプトはそれを保存する。
 * 2. **カセット・基準値ファイルを一切書き換えない。**`saveOpenAiArmCassette` を
 *    呼ばない——round ごとのカセットはメモリ上だけで使い、ディスクには残さない
 *    （マネージャー指示「カセットは新規ファイルのみ」を、そもそも書かないことで満たす）。
 * 3. **出力は既存の `openai-embedding-fp-ceiling-measurement.json` とは別ファイル**
 *    （`openai-margin-candidate-measurement.json`）。
 *
 * ## 使い方
 *
 * ```
 * OPENAI_API_KEY=... DATABASE_URL=postgresql://worker@127.0.0.1:<port>/mnemora_test \
 *   tsx examples/chat/src/scripts/openai-margin-candidate-measurement.ts
 * ```
 *
 * 環境変数: `MNEMORA_MARGIN_CANDIDATE_ROUNDS`(既定20)。
 *
 * ⛔ `OPENAI_API_KEY` の値はどこにも出力しない。呼び出し回数・トークン・概算費用は
 * `usage-meter.ts` の集計をそのまま出す。
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = join(here, "..", "..");
const OUTPUT_PATH = join(CHAT_ROOT, "openai-margin-candidate-measurement.json");

const CTX: Ctx = { tenantId: "openai-margin-candidate-embed" };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} が環境に無い。使い方はこのスクリプトの doc コメントを見ること。`);
  }
  return value;
}

interface ProbeCapture {
  probeId: string;
  goldRank: number | null;
  hit1: boolean;
  margin: number | null;
}

interface GroupCapture {
  group: string;
  label: string;
  mrrOverall: number;
  hit1Count: number;
  hit10Count: number;
  probeCount: number;
  probes: ProbeCapture[];
}

interface RoundCapture {
  round: number;
  groups: GroupCapture[];
}

async function measureGroup(
  databaseUrl: string,
  cassette: Cassette,
  runToken: string,
  group: OpenAiArmGroupDescriptor,
): Promise<GroupCapture> {
  const handle = await createExampleRuntime(
    databaseUrl,
    { ...process.env, MNEMORA_LLM: "deterministic", MNEMORA_EMBEDDING: "recorded" },
    { cassette },
  );
  try {
    const space = handle.embeddingProvider.space;
    const armLabel = buildArmLabel(group, {
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      model: space.model,
      dimensions: space.dimensions,
    });
    const report = await runIdentifierProbeArm({
      armLabel,
      tenantId: buildArmTenantId(`openai-margin-${group.key}`, runToken),
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackKind: group.haystackKind,
      probeSet: group.probeSet,
    });
    return {
      group: group.key,
      label: armLabel,
      mrrOverall: report.mrrOverall,
      hit1Count: report.hit1Count,
      hit10Count: report.hit10Count,
      probeCount: report.probeCount,
      probes: report.probes.map((p) => ({
        probeId: p.probeId,
        goldRank: p.goldRank,
        hit1: p.hit1,
        margin: p.margin,
      })),
    };
  } finally {
    await handle.close();
  }
}

async function runRound(
  databaseUrl: string,
  embeddingProvider: OpenAIEmbeddingProvider,
  allTexts: readonly string[],
  round: number,
): Promise<RoundCapture> {
  const vectors = await embeddingProvider.embed(CTX, [...allTexts]);
  if (vectors.length !== allTexts.length) {
    throw new Error(
      `round ${round}: 入力件数と出力件数が違う(${allTexts.length} vs ${vectors.length})`,
    );
  }
  const entries: Record<string, { text: string; vector: number[] }> = {};
  allTexts.forEach((text, i) => {
    entries[embeddingCassetteKey(text)] = { text, vector: vectors[i]! };
  });
  // ⛔ ディスクには書かない(メモリ上のカセットとして、この round の6群だけに使う)。
  const cassette = buildEmbeddingOnlyCassette(
    embeddingProvider.space,
    entries,
    new Date().toISOString(),
  );
  const runToken = `${newRunToken()}-mc-r${round}`;
  const groups: GroupCapture[] = [];
  for (const group of OPENAI_ARM_GROUPS) {
    groups.push(await measureGroup(databaseUrl, cassette, runToken, group));
  }
  return { round, groups };
}

function toProxyMetrics(g: GroupCapture): ProxyGroupMetrics {
  return {
    group: g.group,
    mrrOverall: g.mrrOverall,
    hit1Count: g.hit1Count,
    hit10Count: g.hit10Count,
    probeCount: g.probeCount,
  };
}

function marginsOf(g: GroupCapture): (number | null)[] {
  return g.probes.map((p) => p.margin);
}

async function main(): Promise<void> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const databaseUrl = requireEnv("DATABASE_URL");
  const rounds = Number(process.env.MNEMORA_MARGIN_CANDIDATE_ROUNDS ?? "20");
  if (!Number.isInteger(rounds) || rounds <= 0) {
    throw new Error(`MNEMORA_MARGIN_CANDIDATE_ROUNDS は正の整数であること(実際: ${rounds})`);
  }

  const usageMeter = createUsageMeter({
    apiKey,
    llmModel: "gpt-4o-mini", // このスクリプトは LLM を1回も叩かない。usage-meter の必須引数を満たすためだけの値。
    embeddingModel: OPENAI_EMBEDDING_MODEL,
  });
  const embeddingProvider = new OpenAIEmbeddingProvider({
    apiKey,
    model: OPENAI_EMBEDDING_MODEL,
    dimensions: OPENAI_EMBEDDING_DIMENSIONS,
    client: usageMeter.client,
  });

  const allTexts = collectAllTexts(OPENAI_ARM_GROUPS);
  console.log(
    `[openai-margin-candidate] 群6・唯一のテキスト数=${allTexts.length}件。` +
      `round 0(基準値)+ round 1..${rounds}(候補案の比較用)を行う。`,
  );

  console.log("\n[openai-margin-candidate] round 0(基準値)を実行中…");
  const round0 = await runRound(databaseUrl, embeddingProvider, allTexts, 0);
  console.log(
    round0.groups
      .map(
        (g) => `  ${g.group}: MRR=${g.mrrOverall.toFixed(4)} hit@1=${g.hit1Count}/${g.probeCount}`,
      )
      .join("\n"),
  );
  const baselineByGroup = new Map(round0.groups.map((g) => [g.group, g]));

  const perRound: RoundCapture[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    console.log(`\n[openai-margin-candidate] round ${round}/${rounds} を実行中…`);
    const result = await runRound(databaseUrl, embeddingProvider, allTexts, round);
    perRound.push(result);
    console.log(`  完了(${result.groups.length}群)`);
  }

  // --- 案0(現行、decideEmbeddingDriftVerdict をそのまま呼ぶ。変更していない) ---
  const baselineMetrics: ProxyGroupMetrics[] = round0.groups.map(toProxyMetrics);
  const candidate0PerRound = perRound.map((r) => {
    const measured = r.groups.map(toProxyMetrics);
    const verdict = decideEmbeddingDriftVerdict(measured, baselineMetrics);
    return { round: r.round, red: verdict.red, groups: verdict.groups };
  });

  // --- 案1(margin基準、decideEmbeddingDriftVerdictByMargin。新設・このリポジトリで新規) ---
  const candidate1PerRound = perRound.map((r) => {
    const inputs = r.groups.map((g) => ({
      group: g.group,
      measuredMargins: marginsOf(g),
      baselineMargins: marginsOf(baselineByGroup.get(g.group)!),
    }));
    const verdict = decideEmbeddingDriftVerdictByMargin(inputs);
    return { round: r.round, red: verdict.red, groups: verdict.groups };
  });

  // --- 案2(k-of-n。ここでは候補0の red flags 列に対して適用する) ---
  function kOfNForGroup(groupKey: string) {
    const flags = candidate0PerRound.map((r) => r.groups.find((g) => g.group === groupKey)!.red);
    const redCount = flags.filter(Boolean).length;
    const p = redCount / flags.length;
    const cpUpper = clopperPearsonUpperBound(redCount, flags.length, 0.05);
    return {
      group: groupKey,
      singleRedCount: redCount,
      trials: flags.length,
      redRate: p,
      clopperPearsonUpperBound95: cpUpper,
      twoOfTwoEmpirical: empiricalKOfNRedRate(flags, 2, 2),
      threeOfThreeEmpirical: empiricalKOfNRedRate(flags, 3, 3),
      twoOfThreeEmpirical: empiricalKOfNRedRate(flags, 3, 2),
      twoOfTwoTheoretical: binomialAtLeastK(2, 2, p),
      twoOfTwoTheoreticalUsingCpUpper: binomialAtLeastK(2, 2, cpUpper),
      threeOfThreeTheoretical: binomialAtLeastK(3, 3, p),
      twoOfThreeTheoretical: binomialAtLeastK(2, 3, p),
    };
  }
  const candidate2ByGroup = OPENAI_ARM_GROUPS.map((g) => kOfNForGroup(g.key));

  // --- sparse/dense 一致(候補2の一種、追加録画なしでCI実装可能)の実測 ---
  function sparseDenseAgreement(sparseKey: string, denseKey: string) {
    const sparseFlags = candidate0PerRound.map(
      (r) => r.groups.find((g) => g.group === sparseKey)!.red,
    );
    const denseFlags = candidate0PerRound.map(
      (r) => r.groups.find((g) => g.group === denseKey)!.red,
    );
    let bothRed = 0;
    let eitherRed = 0;
    let exactlyOneRed = 0;
    for (let i = 0; i < sparseFlags.length; i += 1) {
      const s = sparseFlags[i]!;
      const d = denseFlags[i]!;
      if (s && d) bothRed += 1;
      if (s || d) eitherRed += 1;
      if (s !== d) exactlyOneRed += 1;
    }
    return {
      pair: `${sparseKey}/${denseKey}`,
      trials: sparseFlags.length,
      bothRed,
      eitherRed,
      exactlyOneRed,
      note:
        exactlyOneRed === 0
          ? "sparse/denseの red 集合は完全に一致した——一致条件は偽陽性率を1件も下げない"
          : `sparse/denseが食い違ったroundが${exactlyOneRed}件あった——一致条件は偽陽性率を下げる`,
    };
  }
  const sparseDenseAgreements = [
    sparseDenseAgreement("identifiersSparse", "identifiersDense"),
    sparseDenseAgreement("japaneseNamesSparse", "japaneseNamesDense"),
    sparseDenseAgreement("numeralSparse", "numeralDense"),
  ];

  const commit = tryGitRevParseHead(process.cwd());
  const output = {
    _readme:
      "Issue #109 残件「A」——マネージャーからの実測依頼。ADR 0316/0322 とは別の、" +
      "候補案(margin基準・k-of-n)を比べるための新規測定。⛔ 門ではない。⛔ 既存の " +
      "openai-embedding-fp-ceiling-measurement.json・ADR 0316のカセット・基準値ファイルは " +
      "一切書き換えていない(このスクリプトは round ごとのカセットをディスクに保存しない)。" +
      "この測定は ADR 0316 の測定A/Bとは独立な、別の実 API 呼び出し(round0+" +
      `${rounds}巡)である——ADR 0316 の「33/118」を再現する試みではない。`,
    measuredAt: new Date().toISOString(),
    commit,
    rounds,
    marginDropOptions: DEFAULT_MARGIN_DROP_OPTIONS,
    baseline: round0,
    perRound,
    candidate0PerRound,
    candidate1PerRound,
    candidate2ByGroup,
    sparseDenseAgreements,
    usage: usageMeter.totals(),
    cost: usageMeter.cost(),
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
  console.log(`\n[openai-margin-candidate] 測定記録を書き出した: ${OUTPUT_PATH}`);
  console.log(`\n${usageMeter.formatReport()}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
