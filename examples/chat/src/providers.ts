import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EmbeddingProvider, LLMProvider } from "@mnemora/core";
import { LocalEmbeddingProvider } from "@mnemora/local-embedding";
import { OpenAIEmbeddingProvider, OpenAILLMProvider } from "@mnemora/openai";
import type { Cassette, CassetteRecorder } from "@mnemora/testkit";
import {
  DeterministicEmbeddingProvider,
  DeterministicLLMProvider,
  RecordedEmbeddingProvider,
  RecordedLLMProvider,
  RecordingEmbeddingProvider,
  RecordingLLMProvider,
  SeededEmbeddingProvider,
  SeededLLMProvider,
} from "@mnemora/testkit";
import type { SeedUsageCounts } from "@mnemora/testkit";
import type { UsageMeter } from "./usage-meter.js";
import { createUsageMeter } from "./usage-meter.js";

/**
 * provider の切り替え。黙って擬似物へフォールバックしない——`mode` を呼び出し側（cli.ts）に返し、画面に必ず表示させる。
 * LLM と Embedding は `MNEMORA_LLM`/`MNEMORA_EMBEDDING` で別々に選べる（順位の変化が埋め込みと抽出のどちらのせいかを切り分けるため）。
 * 未指定なら `OPENAI_API_KEY` の有無だけで両方が決まる。
 */
/** `"recorded"` は記録した実 API の応答を再生する。記録に無い入力は例外にする（黙って stub へ倒れない）。 */
/** `"local"` は embedding 専用。`@mnemora/local-embedding` は `EmbeddingProvider` しか実装していないので、`MNEMORA_LLM=local` は他の未知の値と同じく例外になる。 */
/**
 * `anthropic` が無いのは書き忘れではない。`packages/anthropic` は `LLMProvider` を実装しているが、`examples/chat` には配線していない。
 * 理由は ADR 0072「引き受けた負債」3・4: 北極星の物差し（`retrieval`/`compare`）は Anthropic で一度も走っておらずカセットも無いので、
 * 想起の質について何も言えない。足すとしても5層目ではなく、`openai` と同じ「実 API」層の別ベンダーになる。
 * `MNEMORA_LLM=anthropic` は未知の値として例外になる。
 */
export type ProviderMode = "openai" | "deterministic" | "recorded" | "local";

export interface Providers {
  /** 後方互換のために残す単一ラベル。新しいコードは `llmMode`/`embeddingMode` を見ること（個別に上書きするとどちらの実体を指すか曖昧になる）。 */
  mode: ProviderMode;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  llmProvider: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  usageMeter?: UsageMeter;
  /**
   * 渡されたカセットがこの実行で一度も使われなかったか。例外にしない: `retrieval` の arm A は全 arm にカセットを渡す配線の下で、
   * 対照群として意図的に擬似 provider のままなので、例外にするとその対照 arm が落ちる。出力に焼く候補として扱い、
   * `printProviderMode` が警告行として開示する。
   */
  cassetteIgnored: boolean;
  /**
   * 「種カセット」を使ったときだけ存在する。呼ぶたびに実測を読み直す（構築時のスナップショットではない）。
   * `usage-meter` とは別の実測なので混ぜて出さない。種を与えなければ関数自体が存在しないことで、既存の呼び出し側の挙動を変えない。
   */
  readSeedUsage?: () => SeedUsageSummary;
}

export interface SeedUsageSummary {
  llm: SeedUsageCounts;
  embedding: SeedUsageCounts;
}

export const OPENAI_LLM_MODEL = "gpt-4o-mini";
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const OPENAI_EMBEDDING_DIMENSIONS = 256;

export const DETERMINISTIC_EMBEDDING_SPACE = {
  provider: "testkit",
  model: "deterministic",
  dimensions: 8,
};

export type EnvLike = Partial<Record<string, string | undefined>>;

/**
 * 切り替えの単一の分岐点。副作用無しに分岐の単体テストを書けるよう、`createProviders` から切り出してある。
 * シグネチャ・振る舞いは `providers.test.ts` が直接呼んでいるため変えない。
 */
export function selectProviderMode(env: EnvLike): ProviderMode {
  return env.OPENAI_API_KEY ? "openai" : "deterministic";
}

/** `"local"` を含まない（LLM 側に local 実装は無い）。 */
const LLM_MODES = ["openai", "deterministic", "recorded"] as const;

const EMBEDDING_MODES = ["openai", "deterministic", "recorded", "local"] as const;

/** 許可する値の集合を呼び出し側から渡す（LLM と embedding で受け付ける集合が違うため）。未知の値は例外。空文字は「未指定」。 */
function parseModeOverride(
  varName: "MNEMORA_LLM" | "MNEMORA_EMBEDDING",
  value: string | undefined,
  allowed: readonly ProviderMode[],
): ProviderMode | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as ProviderMode;
  }
  throw new Error(
    `${varName} には ${allowed.map((m) => `"${m}"`).join(" / ")} のいずれかを指定すること` +
      `（実際: "${value}"）。`,
  );
}

export function selectLLMMode(env: EnvLike): ProviderMode {
  return parseModeOverride("MNEMORA_LLM", env.MNEMORA_LLM, LLM_MODES) ?? selectProviderMode(env);
}

export function selectEmbeddingMode(env: EnvLike): ProviderMode {
  return (
    parseModeOverride("MNEMORA_EMBEDDING", env.MNEMORA_EMBEDDING, EMBEDDING_MODES) ??
    selectProviderMode(env)
  );
}

/**
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` だけを持ち出す。リテラルの env オブジェクトを渡す呼び出しは `process.env` を丸ごと展開しないので、
 * CI の `actions/cache` が job-level env で設定していても、運ばなければ `LocalEmbeddingProvider` まで届かずキャッシュが空回りする。
 * `...process.env` を丸ごと展開する代わりにこれを使うこと（DB 歯が周囲の環境変数すべてに左右されるようになる）。
 */
export function localEmbeddingCacheDirEnv(source: EnvLike = process.env): EnvLike {
  const value = source.MNEMORA_LOCAL_EMBEDDING_CACHE_DIR;
  return value === undefined || value === "" ? {} : { MNEMORA_LOCAL_EMBEDDING_CACHE_DIR: value };
}

/**
 * `LocalEmbeddingProvider` へ渡す固定した Hugging Face revision。CI が使う側（ここと `scripts/print-local-embedding-cache-key.mjs`）だけを固定し、
 * 指紋門 `scripts/check-local-embedding-fingerprint.mjs` は固定しない（`main` を照合し続ける番犬で、赤くなったらこの固定値の更新の合図）。
 * 唯一の宣言は `scripts/local-embedding-pinned-revision.json`。公開 API には足さない。
 * 読めなければ投げる: 黙って既定の `main` へ戻すと、固定したはずの CI が実は固定されていない、という気づきにくい壊れ方になる。
 */
export function localEmbeddingPinnedRevision(
  declarationPath: string = fileURLToPath(
    new URL("../../../scripts/local-embedding-pinned-revision.json", import.meta.url),
  ),
): string {
  let source: string;
  try {
    source = readFileSync(declarationPath, "utf8");
  } catch (error) {
    throw new Error(
      `localEmbeddingPinnedRevision: 固定した revision の宣言（${declarationPath}）を` +
        `読めなかった（Issue #597 案(a)）。原因: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `localEmbeddingPinnedRevision: ${declarationPath} の JSON が壊れている。` +
        `原因: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const sha = (parsed as { sha?: unknown } | null)?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new Error(`localEmbeddingPinnedRevision: ${declarationPath} に sha（文字列）が無い。`);
  }
  return sha;
}

// `MNEMORA_PROVIDER_SOURCE` で明示したときだけ、キーの有無を上書きできる。既定（「キーが在れば実 API」）は変えない——誰かが選んだ意図かもしれないため。

/** どちらを使うかと、なぜそう決まったか。理由を捨てない: `reason` が無いと、たまたま recorded になったのか明示したのかを画面から区別できない。 */
export type ProviderSourceDecision =
  | { source: "openai"; reason: "key-present" }
  | { source: "recorded"; reason: "no-key" }
  | { source: "recorded"; reason: "forced" }
  | { source: "openai"; reason: "forced" };

/**
 * `MNEMORA_PROVIDER_SOURCE` が指定されていれば最優先する。未知の値は例外（黙って既定へ倒れない）。
 * `"openai"` をキー無しで強制された場合も例外。
 */
export function decideProviderSource(env: EnvLike): ProviderSourceDecision {
  const forced = env.MNEMORA_PROVIDER_SOURCE;
  if (forced === "recorded") {
    return { source: "recorded", reason: "forced" };
  }
  if (forced === "openai") {
    // キーが無いのに `openai` を強制されたら落とす。そのまま返すと、`runCompare` はカセットを読まず `process.env` を `createProviders` へ渡すので、
    // 画面には実 API と出しながら擬似 provider で走り、数字の表を出して EXIT=0 で終わる。
    // 明示した source と実際に使われる provider が食い違う経路を作らない。
    if (!env.OPENAI_API_KEY) {
      throw new Error(
        'MNEMORA_PROVIDER_SOURCE="openai" を指定したが、OPENAI_API_KEY が無い（ADR 0068）。' +
          "キーを設定するか、指定を外すこと（未指定なら記録の再生になる）。" +
          "黙って擬似 provider へは倒れない。",
      );
    }
    return { source: "openai", reason: "forced" };
  }
  if (forced !== undefined && forced !== "") {
    throw new Error(
      `MNEMORA_PROVIDER_SOURCE には "openai" / "recorded" のいずれかを指定すること` +
        `（実際: "${forced}"）。`,
    );
  }
  return env.OPENAI_API_KEY
    ? { source: "openai", reason: "key-present" }
    : { source: "recorded", reason: "no-key" };
}

export function describeProviderSourceReason(decision: ProviderSourceDecision): string {
  switch (decision.reason) {
    case "key-present":
      return "OPENAI_API_KEY が在るため実 API";
    case "no-key":
      return "OPENAI_API_KEY が無いため記録を再生";
    case "forced":
      return decision.source === "recorded"
        ? "MNEMORA_PROVIDER_SOURCE=recorded の明示指定（OPENAI_API_KEY の有無に関わらず再生する）"
        : "MNEMORA_PROVIDER_SOURCE=openai の明示指定（実 API を叩く）";
    default: {
      const exhaustive: never = decision;
      throw new Error(`describeProviderSourceReason: 未知の reason: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * 「予定」を名乗った経路だけが持つ値。名乗っていない経路は `null` を渡す（省略できない）。省略可能にしないのは、
 * 予定を名乗ったのに食い違いを開示しないまま provider バナーを出す経路を書けなくするため。
 * `null` は「食い違っていない」ではなく「予定を名乗っていない」。
 */
export type PlannedProviderSource = ProviderSourceDecision["source"] | null;

export interface PlanActualMismatch {
  plannedSource: ProviderSourceDecision["source"];
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  llmDiffers: boolean;
  embeddingDiffers: boolean;
}

/**
 * 予定（構築の前）と実測（構築の後）の2行が食い違っているかを判定する。`Providers.cassetteIgnored` では足りない:
 * `openai` 経路ではカセットを読まないので、あちらは原理的にこの食い違いを見ない。
 * 判定ではなく開示で、例外にはできない。`retrieval` の arm A/B は意図して予定と食い違わせる対照群で、
 * 正当な食い違いと事故の食い違いを区別できない。
 */
export function detectPlanActualMismatch(
  plannedSource: PlannedProviderSource,
  modes: { llmMode: ProviderMode; embeddingMode: ProviderMode },
): PlanActualMismatch | undefined {
  if (plannedSource === null) {
    return undefined;
  }
  const llmDiffers = modes.llmMode !== plannedSource;
  const embeddingDiffers = modes.embeddingMode !== plannedSource;
  if (!llmDiffers && !embeddingDiffers) {
    return undefined;
  }
  return {
    plannedSource,
    llmMode: modes.llmMode,
    embeddingMode: modes.embeddingMode,
    llmDiffers,
    embeddingDiffers,
  };
}

/**
 * 予定の値と実測の値を、どちらも逐語で出す（読み手に2行を突き合わせさせない）。どちらが正しいかは名乗らない。
 * `describeMode` の長い説明文ではなく `ProviderMode` の値そのものを出す（突き合わせる相手は `MNEMORA_LLM`/`MNEMORA_EMBEDDING` に書く値だから）。
 */
export function describePlanActualMismatch(mismatch: PlanActualMismatch): string {
  const differing = [
    ...(mismatch.llmDiffers ? [`LLM=${mismatch.llmMode}`] : []),
    ...(mismatch.embeddingDiffers ? [`Embedding=${mismatch.embeddingMode}`] : []),
  ].join(", ");
  return (
    `  ⚠ 上の [cassette] 行が名乗った予定（source=${mismatch.plannedSource}）と、` +
    `この実測が食い違っている（${differing}）。\n` +
    "    これは開示であって判定ではない——retrieval の arm A / arm B のように、" +
    "意図して食い違わせる正当な経路がある（Issue #594）。"
  );
}

export interface CreateProvidersOptions {
  /** `"recorded"` を選んだのにこれが無ければ構築時に落ちる（カセット未指定を「じゃあ擬似物で」と読み替えない）。 */
  cassette?: Cassette;
  recorder?: CassetteRecorder;
  /** 省略時は渡さない（`llmMode === "openai"` の既存の呼び出しの挙動を変えない）。 */
  llmTemperature?: number;
  /**
   * 「種カセット」。`openai` の側だけに効き、種にある入力には実 API を呼ばずその値を返す。`recorder` と組み合わせると、
   * 種由来も実 API 由来も新しいカセットへ記録され、種への参照は残らない。抽出は非決定的で録り直すたびに記憶集合が変わりうるため、
   * 旧カセットを種として渡して揃えやすくする。省略時は包まず real をそのまま使う。
   */
  seedCassette?: Cassette;
}

export function createProviders(
  env: EnvLike = process.env,
  options: CreateProvidersOptions = {},
): Providers {
  const mode = selectProviderMode(env);
  const llmMode = selectLLMMode(env);
  const embeddingMode = selectEmbeddingMode(env);
  const { cassette, recorder, llmTemperature, seedCassette } = options;

  let seededLLM: SeededLLMProvider | undefined;
  let seededEmbedding: SeededEmbeddingProvider | undefined;

  const requireCassette = (which: string): Cassette => {
    if (cassette === undefined) {
      throw new Error(
        `${which} に "recorded" を指定したが、カセットが渡されていない（ADR 0051）。` +
          "先に `record` サブコマンドで記録すること。",
      );
    }
    return cassette;
  };

  // 1つの usage-meter を両方で共有する——呼び出し回数・トークン・費用をこのプロセス全体で一箇所に集計するため。
  const usageMeter =
    llmMode === "openai" || embeddingMode === "openai"
      ? createUsageMeter({
          apiKey: env.OPENAI_API_KEY,
          llmModel: OPENAI_LLM_MODEL,
          embeddingModel: OPENAI_EMBEDDING_MODEL,
        })
      : undefined;

  const buildLLM = (): LLMProvider => {
    if (llmMode === "recorded") {
      return new RecordedLLMProvider({
        section: requireCassette("MNEMORA_LLM").llm,
        expectedModel: OPENAI_LLM_MODEL,
      });
    }
    if (llmMode !== "openai") {
      return new DeterministicLLMProvider();
    }
    const real = new OpenAILLMProvider({
      apiKey: env.OPENAI_API_KEY,
      model: OPENAI_LLM_MODEL,
      client: usageMeter?.client,
      ...(llmTemperature !== undefined ? { temperature: llmTemperature } : {}),
    });
    // 組み立て順は real → `SeededLLMProvider` → `RecordingLLMProvider`。逆にすると、種から返した値が recorder を通らず、新しいカセットに記録されない。
    const withSeed: LLMProvider = seedCassette
      ? (seededLLM = new SeededLLMProvider(real, {
          seed: seedCassette.llm,
          expectedModel: OPENAI_LLM_MODEL,
        }))
      : real;
    return recorder ? new RecordingLLMProvider(withSeed, recorder, OPENAI_LLM_MODEL) : withSeed;
  };

  const buildEmbedding = (): EmbeddingProvider => {
    if (embeddingMode === "recorded") {
      return new RecordedEmbeddingProvider({
        section: requireCassette("MNEMORA_EMBEDDING").embedding,
        expectedSpace: {
          provider: "openai",
          model: OPENAI_EMBEDDING_MODEL,
          dimensions: OPENAI_EMBEDDING_DIMENSIONS,
        },
      });
    }
    // `!== "openai"` の擬似物 fallback より先に見ないと、`local` が誤って `DeterministicEmbeddingProvider` に落ちる。
    if (embeddingMode === "local") {
      // `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` を `cacheDir` として渡す。transformers.js の既定の場所は環境によって変わりうるので、
      // 明示したパスのほうが次の実行でも同じ場所を見ることを保証しやすい。`revision` も渡し、CI が使う側だけを固定する
      // （`@mnemora/local-embedding` 自体の既定は変えない）。
      const cacheDir = env.MNEMORA_LOCAL_EMBEDDING_CACHE_DIR;
      return new LocalEmbeddingProvider({
        ...(cacheDir ? { cacheDir } : {}),
        revision: localEmbeddingPinnedRevision(),
      });
    }
    if (embeddingMode !== "openai") {
      return new DeterministicEmbeddingProvider(DETERMINISTIC_EMBEDDING_SPACE);
    }
    const real = new OpenAIEmbeddingProvider({
      apiKey: env.OPENAI_API_KEY,
      model: OPENAI_EMBEDDING_MODEL,
      dimensions: OPENAI_EMBEDDING_DIMENSIONS,
      client: usageMeter?.client,
    });
    // `buildLLM` と同じ組み立て順（real → Seeded → Recording）。
    const withSeed: EmbeddingProvider = seedCassette
      ? (seededEmbedding = new SeededEmbeddingProvider(real, {
          seed: seedCassette.embedding,
          expectedSpace: {
            provider: "openai",
            model: OPENAI_EMBEDDING_MODEL,
            dimensions: OPENAI_EMBEDDING_DIMENSIONS,
          },
        }))
      : real;
    return recorder ? new RecordingEmbeddingProvider(withSeed, recorder) : withSeed;
  };

  const llmProvider = buildLLM();
  const embeddingProvider = buildEmbedding();

  // `requireCassette` の鏡像。例外にはできない（`Providers.cassetteIgnored` の docstring 参照）。
  const cassetteIgnored =
    cassette !== undefined && llmMode !== "recorded" && embeddingMode !== "recorded";

  const zeroCounts: SeedUsageCounts = { seeded: 0, real: 0 };
  const readSeedUsage: (() => SeedUsageSummary) | undefined =
    seedCassette !== undefined
      ? () => ({
          llm: seededLLM ? seededLLM.usage : zeroCounts,
          embedding: seededEmbedding ? seededEmbedding.usage : zeroCounts,
        })
      : undefined;

  return {
    mode,
    llmMode,
    embeddingMode,
    llmProvider,
    embeddingProvider,
    cassetteIgnored,
    ...(usageMeter !== undefined ? { usageMeter } : {}),
    ...(readSeedUsage !== undefined ? { readSeedUsage } : {}),
  };
}
