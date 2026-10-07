import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import type { Ctx } from "@mnemora/core";
import { OpenAIEmbeddingProvider } from "@mnemora/openai";
import { embeddingCassetteKey } from "@mnemora/testkit";
import type { Cassette } from "@mnemora/testkit";
import {
  IDENTIFIER_OPENAI_CASSETTE_PATH,
  NUMERAL_TOKEN_OPENAI_CASSETTE_PATH,
  buildEmbeddingOnlyCassette,
  saveOpenAiArmCassette,
} from "../openai-arm-cassette.js";
import {
  OPENAI_ARM_GROUPS,
  buildArmLabel,
  collectAllTexts,
  identifierArmGroups,
  numeralArmGroups,
} from "../openai-arm-probe-groups.js";
import type { OpenAiArmGroupDescriptor } from "../openai-arm-probe-groups.js";
import {
  DEFAULT_MRR_DROP_THRESHOLD,
  clopperPearsonUpperBound,
  decideEmbeddingDriftVerdict,
} from "../openai-arm-verdict.js";
import type { DriftVerdict, ProxyGroupMetrics } from "../openai-arm-verdict.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { runIdentifierProbeArm } from "../identifier-arm.js";
import {
  armHeadline,
  buildArmTenantId,
  newRunToken,
  runRetrievalQualityArm,
} from "../retrieval-quality.js";
import { OPENAI_EMBEDDING_DIMENSIONS, OPENAI_EMBEDDING_MODEL } from "../providers.js";
import { createUsageMeter } from "../usage-meter.js";
import { tryGitRevParseHead } from "../git-info.js";
import { RETRIEVAL_CASSETTE_PATH, loadCassette } from "../cassette-io.js";
import {
  SHADOW_HIT1_MIN,
  SHADOW_MRR_THRESHOLD,
  decideRetrievalQualityShadowVerdict,
} from "../retrieval-quality-shadow-verdict.js";

/**
 * 手で回す再計測（CI からは呼ばない）。round 0 が公式の記録（CI が再生するカセット・基準値の出所）で、round 1..K は同じ設定・同じコードで録り直したもの。
 * `OPENAI_API_KEY` の値はログにも生成物にも出さない。
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHAT_ROOT = join(here, "..", "..");

const IDENTIFIER_OPENAI_BASELINE_PATH = join(CHAT_ROOT, "identifier-probe-baseline.openai.json");
const NUMERAL_TOKEN_OPENAI_BASELINE_PATH = join(
  CHAT_ROOT,
  "numeral-token-probe-baseline.openai.json",
);
const FP_CEILING_MEASUREMENT_PATH = join(CHAT_ROOT, "openai-embedding-fp-ceiling-measurement.json");

const CTX: Ctx = { tenantId: "openai-arm-fp-ceiling-embed" };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} が環境に無い（必須。既定値は無い）。`);
  }
  return value;
}

async function measureGroup(
  databaseUrl: string,
  cassette: Cassette,
  runToken: string,
  group: OpenAiArmGroupDescriptor,
): Promise<ProxyGroupMetrics & { label: string; embeddingModeLabel: string }> {
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
      tenantId: buildArmTenantId(`openai-fp-${group.key}`, runToken),
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackKind: group.haystackKind,
      probeSet: group.probeSet,
    });
    return {
      group: group.key,
      mrrOverall: report.mrrOverall,
      hit1Count: report.hit1Count,
      hit10Count: report.hit10Count,
      probeCount: report.probeCount,
      label: armLabel,
      embeddingModeLabel: handle.embeddingMode,
    };
  } finally {
    await handle.close();
  }
}

interface RoundResult {
  round: number;
  metrics: (ProxyGroupMetrics & { label: string; embeddingModeLabel: string })[];
}

async function runRound(
  databaseUrl: string,
  embeddingProvider: OpenAIEmbeddingProvider,
  allTexts: readonly string[],
  round: number,
): Promise<{ result: RoundResult; entries: Record<string, { text: string; vector: number[] }> }> {
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
  const cassette = buildEmbeddingOnlyCassette(
    embeddingProvider.space,
    entries,
    new Date().toISOString(),
  );
  const runToken = `${newRunToken()}-r${round}`;
  const metrics: (ProxyGroupMetrics & { label: string; embeddingModeLabel: string })[] = [];
  for (const group of OPENAI_ARM_GROUPS) {
    metrics.push(await measureGroup(databaseUrl, cassette, runToken, group));
  }
  return { result: { round, metrics }, entries };
}

/**
 * 1標本の乖離チェック（統計的主張ではない）。LLM 層は `retrieval.json` の記録をそのまま再生し、embedding 層だけ新しい値に差し替える。
 * 素朴な cosine 順位での近似は、既知の実測値（ADR 0276）を再現しなかったので使わない。
 */
async function runDriftOneSample(databaseUrl: string, embeddingProvider: OpenAIEmbeddingProvider) {
  const recorded = loadCassette(RETRIEVAL_CASSETTE_PATH);
  const texts = Object.values(recorded.embedding.entries).map((e) => e.text);
  const vectors = await embeddingProvider.embed(CTX, texts);
  if (vectors.length !== texts.length) {
    throw new Error(`drift-check: 入力件数と出力件数が違う(${texts.length} vs ${vectors.length})`);
  }
  const freshEntries: Record<string, { text: string; vector: number[] }> = {};
  texts.forEach((text, i) => {
    freshEntries[embeddingCassetteKey(text)] = { text, vector: vectors[i]! };
  });
  const freshCassette = {
    ...recorded,
    embedding: { space: embeddingProvider.space, entries: freshEntries },
  };

  const runArm = async (cassette: typeof recorded, label: string) => {
    const handle = await createExampleRuntime(
      databaseUrl,
      { ...process.env, MNEMORA_LLM: "recorded", MNEMORA_EMBEDDING: "recorded" },
      { cassette },
    );
    try {
      const report = await runRetrievalQualityArm({
        armLabel: label,
        tenantId: buildArmTenantId("openai-fp-drift", newRunToken()),
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
      });
      const headline = armHeadline(report);
      return {
        hit1Count: headline.hit1Count,
        mrrOverall: headline.mrrOverall,
        probeCount: headline.probeCount,
        goldRanks: report.probes.map((p) => ({ probeId: p.probeId, goldRank: p.goldRank })),
        shadowVerdict: decideRetrievalQualityShadowVerdict({
          mrrOverall: headline.mrrOverall,
          hit1Count: headline.hit1Count,
          probeCount: headline.probeCount,
        }),
      };
    } finally {
      await handle.close();
    }
  };

  const recordedArm = await runArm(
    recorded,
    "openai-fp-drift/recorded(llm=recorded, embedding=recorded, 既存retrieval.json)",
  );
  const freshArm = await runArm(
    freshCassette,
    "openai-fp-drift/fresh(llm=recorded=既存retrieval.json, embedding=recorded=いま録り直した値)",
  );

  return {
    note:
      "1標本の乖離チェック(既存 examples/chat/cassettes/retrieval.json の録画時点 vs " +
      "いま録り直した embedding。LLM 層は録り直さず既存の記録をそのまま再生する——" +
      "乖離の対象を embedding だけに絞るため)。⛔ 統計的主張はしない(ADR 0033 §3、標本7件)。" +
      "既存カセットは1バイトも書き換えていない(freshCassette は別のインメモリオブジェクト)。",
    shadowVerdictThresholds: { mrrThreshold: SHADOW_MRR_THRESHOLD, hit1Min: SHADOW_HIT1_MIN },
    cassetteRecordedAt: recorded.recordedAt,
    recorded: recordedArm,
    fresh: freshArm,
  };
}

function buildBaselineGroupsJson(
  metrics: readonly (ProxyGroupMetrics & { label: string; embeddingModeLabel: string })[],
  keys: readonly string[],
  space: { provider: string; model: string; dimensions: number },
) {
  return metrics
    .filter((m) => keys.includes(m.group))
    .map((m) => ({
      group: m.group,
      label: m.label,
      llmMode: "deterministic",
      embeddingMode: m.embeddingModeLabel,
      embeddingSpace: space,
      haystackKind: OPENAI_ARM_GROUPS.find((g) => g.key === m.group)!.haystackKind,
      mrrOverall: m.mrrOverall,
      hit1Count: m.hit1Count,
      hit10Count: m.hit10Count,
      probeCount: m.probeCount,
    }));
}

async function main(): Promise<void> {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const databaseUrl = requireEnv("DATABASE_URL");
  const rounds = Number(process.env.MNEMORA_OPENAI_FP_CEILING_ROUNDS ?? "59");
  const mrrDropThreshold = Number(
    process.env.MNEMORA_OPENAI_FP_CEILING_MRR_DROP_THRESHOLD ?? String(DEFAULT_MRR_DROP_THRESHOLD),
  );
  if (!Number.isInteger(rounds) || rounds <= 0) {
    throw new Error(`MNEMORA_OPENAI_FP_CEILING_ROUNDS は正の整数であること(実際: ${rounds})`);
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
    `[openai-embedding-fp-ceiling] 群6・唯一のテキスト数=${allTexts.length}件。` +
      `round 0(公式記録・基準値の出所)+ round 1..${rounds}(偽陽性率の実測)を行う。`,
  );

  console.log("\n[openai-embedding-fp-ceiling] round 0(公式記録)を実行中…");
  const { result: round0, entries: round0Entries } = await runRound(
    databaseUrl,
    embeddingProvider,
    allTexts,
    0,
  );
  const baselineMetrics: ProxyGroupMetrics[] = round0.metrics;
  console.log(
    round0.metrics
      .map(
        (m) => `  ${m.group}: MRR=${m.mrrOverall.toFixed(4)} hit@1=${m.hit1Count}/${m.probeCount}`,
      )
      .join("\n"),
  );

  const space = embeddingProvider.space;
  const identifierTexts = new Set(collectAllTexts(identifierArmGroups()));
  const numeralTexts = new Set(collectAllTexts(numeralArmGroups()));
  const identifierEntries = Object.fromEntries(
    Object.entries(round0Entries).filter(([, e]) => identifierTexts.has(e.text)),
  );
  const numeralEntries = Object.fromEntries(
    Object.entries(round0Entries).filter(([, e]) => numeralTexts.has(e.text)),
  );
  const recordedAt = new Date().toISOString();
  saveOpenAiArmCassette(
    buildEmbeddingOnlyCassette(space, identifierEntries, recordedAt),
    IDENTIFIER_OPENAI_CASSETTE_PATH,
  );
  saveOpenAiArmCassette(
    buildEmbeddingOnlyCassette(space, numeralEntries, recordedAt),
    NUMERAL_TOKEN_OPENAI_CASSETTE_PATH,
  );

  const commit = tryGitRevParseHead(process.cwd());
  const identifierBaselineJson = {
    _readme:
      "identifier-probes ベンチの4群(identifiersSparse/identifiersDense/" +
      "japaneseNamesSparse/japaneseNamesDense)を、実 OpenAI embedding(recorded provider で" +
      "再生)で測った基準値(Issue #109 後半)。examples/chat/identifier-probe-baseline.json" +
      "(local embedding版)とは別ファイルであり、そちらには1文字も触れていない。" +
      "生成し直す手段は examples/chat/src/scripts/openai-embedding-fp-ceiling.ts の再実行。",
    schemaVersion: 1,
    provenance: {
      commit,
      measuredAt: recordedAt,
      how:
        "OPENAI_API_KEY=... DATABASE_URL=... " +
        "pnpm --filter @mnemora/example-chat exec tsx src/scripts/openai-embedding-fp-ceiling.ts",
      embeddingSpace: space,
      note:
        "round 0(このファイルの出所)。round 1.." +
        `${rounds} は同じ設定で独立に録り直し、round 0 からの偽陽性率を測った` +
        "(openai-embedding-fp-ceiling-measurement.json)。",
    },
    groups: buildBaselineGroupsJson(
      round0.metrics,
      ["identifiersSparse", "identifiersDense", "japaneseNamesSparse", "japaneseNamesDense"],
      space,
    ),
  };
  const numeralBaselineJson = {
    _readme:
      "numeral-token-probes ベンチの2群(sparse/dense)を、実 OpenAI embedding(recorded " +
      "provider で再生)で測った基準値(Issue #109 後半)。" +
      "examples/chat/numeral-token-probe-baseline.json(local embedding版)とは別ファイルで" +
      "あり、そちらには1文字も触れていない。",
    schemaVersion: 1,
    provenance: {
      commit,
      measuredAt: recordedAt,
      how:
        "OPENAI_API_KEY=... DATABASE_URL=... " +
        "pnpm --filter @mnemora/example-chat exec tsx src/scripts/openai-embedding-fp-ceiling.ts",
      embeddingSpace: space,
      note: `round 0(このファイルの出所)。round 1..${rounds} は openai-embedding-fp-ceiling-measurement.json。`,
    },
    groups: buildBaselineGroupsJson(round0.metrics, ["numeralSparse", "numeralDense"], space),
  };
  writeFileSync(
    IDENTIFIER_OPENAI_BASELINE_PATH,
    `${JSON.stringify(identifierBaselineJson, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(
    NUMERAL_TOKEN_OPENAI_BASELINE_PATH,
    `${JSON.stringify(numeralBaselineJson, null, 2)}\n`,
    "utf-8",
  );
  console.log(
    `\n[openai-embedding-fp-ceiling] カセット・基準値ファイルを書き出した:\n` +
      `  ${IDENTIFIER_OPENAI_CASSETTE_PATH}\n  ${NUMERAL_TOKEN_OPENAI_CASSETTE_PATH}\n` +
      `  ${IDENTIFIER_OPENAI_BASELINE_PATH}\n  ${NUMERAL_TOKEN_OPENAI_BASELINE_PATH}`,
  );

  const perRound: { round: number; verdict: DriftVerdict; metrics: ProxyGroupMetrics[] }[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    console.log(`\n[openai-embedding-fp-ceiling] round ${round}/${rounds} を実行中…`);
    const { result } = await runRound(databaseUrl, embeddingProvider, allTexts, round);
    const verdict = decideEmbeddingDriftVerdict(result.metrics, baselineMetrics, {
      mrrDropThreshold,
    });
    console.log(`  red=${verdict.red}`);
    perRound.push({ round, verdict, metrics: result.metrics });
  }

  const numRed = perRound.filter((r) => r.verdict.red).length;
  const upperBound95 = clopperPearsonUpperBound(numRed, rounds, 0.05);

  // 群ごとの red 件数・上限も出す（「いずれかが red」の集計だけでは、どの群が偽陽性率を持ち上げているか読めない）。
  const perGroupFalsePositiveCeiling: Record<
    string,
    { redCount: number; trials: number; redRate: number; clopperPearsonUpperBound95: number }
  > = {};
  for (const group of OPENAI_ARM_GROUPS) {
    const redCount = perRound.filter((r) =>
      r.verdict.groups.some((g) => g.group === group.key && g.red),
    ).length;
    perGroupFalsePositiveCeiling[group.key] = {
      redCount,
      trials: rounds,
      redRate: redCount / rounds,
      clopperPearsonUpperBound95: clopperPearsonUpperBound(redCount, rounds, 0.05),
    };
  }

  console.log(
    `\n[openai-embedding-fp-ceiling] red(いずれかの群)=${numRed}/${rounds}件。` +
      `Clopper–Pearson 片側95%上限=${(upperBound95 * 100).toFixed(3)}%`,
  );
  console.log(
    Object.entries(perGroupFalsePositiveCeiling)
      .map(
        ([key, v]) =>
          `  ${key}: red=${v.redCount}/${v.trials} 上限=${(v.clopperPearsonUpperBound95 * 100).toFixed(3)}%`,
      )
      .join("\n"),
  );

  console.log(
    "\n[openai-embedding-fp-ceiling] 副産物: retrieval.json との1標本の乖離チェックを実行中…",
  );
  const driftOneSample = await runDriftOneSample(databaseUrl, embeddingProvider);

  const measurement = {
    _readme:
      "Issue #109 後半——ADR 0094「これが覆るとしたら」第1項の実測記録。" +
      "門ではない(この JSON を読んで CI を落とす歯は無い)。⛔ 実測値であり、" +
      "main が動くと変わる——この JSON は「測った記録そのもの」であり(AGENTS.md " +
      "「⛔ 対象外——実測して repo にコミットした基準値」)、再計測は下の how の " +
      "手順を再実行すること。",
    measuredAt: new Date().toISOString(),
    commit,
    rounds,
    alpha: 0.05,
    mrrDropThreshold,
    verdictRule:
      "群ごとに、hit1Count が baseline(round 0)未満、または mrrOverall が baseline から " +
      "mrrDropThreshold 以上落ちたら red。6群のいずれかが red ならその round は red " +
      "(decideEmbeddingDriftVerdict、測定前に固定)。",
    baseline: { round: 0, metrics: baselineMetrics },
    perRound: perRound.map((r) => ({
      round: r.round,
      red: r.verdict.red,
      groups: r.verdict.groups,
      metrics: r.metrics,
    })),
    falsePositiveCeiling: {
      redCount: numRed,
      trials: rounds,
      redRate: numRed / rounds,
      clopperPearsonUpperBound95: upperBound95,
      note: "6群のいずれかが red だった round の割合(束ねた集計)。群ごとの内訳は perGroupFalsePositiveCeiling。",
    },
    perGroupFalsePositiveCeiling,
    driftOneSample,
    usage: usageMeter.totals(),
    cost: usageMeter.cost(),
    limits: [
      "K回の録り直しはすべて同日(数時間)以内に行っている——日〜週単位で起きるカセットの" +
        "経年変化(記録から19日で完全一致率3.4%だったマネージャーの予備測定)はこの実測の" +
        "対象外である。上のdriftOneSampleはその代わりの1標本であり、統計的主張ではない。",
      "この上限は「同じモデル・同じコードでの独立な録り直し」に対するものであり、" +
        "モデルの交代や大幅な経年には及ばない(下のADRを見ること)。",
      "6群は互いに一部のテキスト(sparse haystack 60件)を共有するため、round間で" +
        "完全に独立な標本ではない——ただし各groupのverdictはbaselineとの比較で" +
        "決まるため、この共有は個々のgroupの判定を歪めない(sparse haystackの埋め込みは" +
        "全groupで同一round内では同じ値)。",
    ],
  };
  writeFileSync(FP_CEILING_MEASUREMENT_PATH, `${JSON.stringify(measurement, null, 2)}\n`, "utf-8");
  console.log(
    `\n[openai-embedding-fp-ceiling] 測定記録を書き出した: ${FP_CEILING_MEASUREMENT_PATH}`,
  );
  console.log(`\n${usageMeter.formatReport()}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
