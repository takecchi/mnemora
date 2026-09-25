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
} from "@mnemora/testkit";
import type { UsageMeter } from "./usage-meter.js";
import { createUsageMeter } from "./usage-meter.js";

/**
 * サンプルアプリが実際に使う provider の切り替え（PR 本文「LLM/Embedding は実 API キーが
 * 無くても動く」）。
 *
 * **黙って擬似物へフォールバックしない**——`mode` を呼び出し側（cli.ts）に返し、
 * 画面に必ず表示させる。どちらで動いているかを隠さない、という原則の姿3の適用。
 *
 * **LLM と Embedding を別々に選べる（本 PR の拡張）。** 理由: retrieval-quality の
 * ベンチで「順位が変わったのは埋め込みのせいか抽出のせいか」を切り分けたい場合、
 * 一方だけを本物に入れ替えられる必要がある。`MNEMORA_LLM` / `MNEMORA_EMBEDDING`
 * （`"openai" | "deterministic"`）で個別に上書きできる——**未指定なら、いままで通り
 * `OPENAI_API_KEY` の有無だけで両方が決まる**（`selectProviderMode` の契約は変えない。
 * 既存テストはこの2つの環境変数を設定しないため、そのまま通る）。
 */
/**
 * `"recorded"` は ADR 0051 で足した第3のモード——**記録した実 API の応答を再生する**。
 *
 * `"deterministic"`（意味を持たない stub）とも `"openai"`（実 API を叩く）とも違う。
 * 記録済みの入力に対しては `"openai"` と同じベクトル・同じ抽出結果を返し、
 * 記録に無い入力に対しては例外を投げる（黙って stub へ倒れない）。
 */
/**
 * `"local"` は Issue #109 で足した第4のモード——**`@mnemora/local-embedding`
 *（外部サービスへ繋がない、プロセス内 ONNX 推論、ADR 0085）を使う**。
 *
 * ⚠ **embedding 専用である。LLM 側に `"local"` は無い。** `@mnemora/local-embedding` は
 * `EmbeddingProvider` しか実装していない——LLM の代替は無い。`MNEMORA_LLM=local` は
 * 他の未知の値と同じく例外になる（`parseModeOverride` 参照）。`MNEMORA_EMBEDDING=local`
 * だけが有効。
 */
/**
 * ⚠ **`anthropic` が無いのは書き忘れではない。** `packages/anthropic` は
 * `LLMProvider` を実装しているが（ADR 0072）、**`examples/chat` には一度も配線されて
 * いない**——`examples/chat/package.json` の依存に `@mnemora/anthropic` は無く、
 * このファイルもそれを一度も import していない。`git log -S 'anthropic' --
 * examples/chat/` は1件もヒットしない（配線してから外したのではなく、そもそも
 * 触られたことが無い）。
 *
 * **理由は ADR 0072「引き受けた負債」3・4 に逐語で書かれている**
 * （`docs/decisions/0072-anthropic-llm-provider.md`）:
 *
 * > 3. `packages/anthropic` は Phase 1 の完了条件に入っていない。
 * >    `docs/roadmap.md` 段階6 は4パッケージを名指ししており、本 PR ではそこを
 * >    直していない。Phase 1 の定義を動かすかはオーナーの判断である。
 * > 4. 北極星の物差し（`examples/chat` の `retrieval` / `compare`）は、
 * >    Anthropic では一度も走っていない。カセットも無い。
 * >    ⟹ この PR は「Anthropic で想起の質がどうなるか」について何も言っていない。
 * >    言えるのは「契約が揃っている」ことだけである。
 *
 * ⚠ **ADR 0072 決定1（`@mnemora/anthropic` が `EmbeddingProvider` を実装しない。理由は同 ADR「設計としては既に決まっていた」の節）
 * と混同しないこと。**あちらは「Anthropic に埋め込み API が無い」というパッケージ内部
 * の話であり、こちらは「`examples/chat` へまだ配線していない」という別の理由の
 * スコープ外である。
 *
 * ⚠ **層が1つ足りない、という話でもない。**この repo の provider は4層
 * （`deterministic`/`recorded`/`openai`/`local`。AGENTS.md）に分かれているが、
 * その軸は実装の性質（意味を持たない stub／記録の再生／実 API／プロセス内 ONNX 推論）
 * であってベンダーではない。`anthropic` を足すとしても5層目にはならない——`openai`
 * と同じ「実 API」層の別ベンダーである。
 *
 * `MNEMORA_LLM=anthropic` / `MNEMORA_EMBEDDING=anthropic` は他の未知の値と同じく
 * 例外になる（`parseModeOverride` 参照。`LLM_MODES`/`EMBEDDING_MODES` のどちらにも
 * `"anthropic"` は無い）。
 */
export type ProviderMode = "openai" | "deterministic" | "recorded" | "local";

export interface Providers {
  /**
   * 後方互換のために残す単一ラベル。`MNEMORA_LLM`/`MNEMORA_EMBEDDING` を使わない
   * 呼び出し（既存の `chat`/`compare`）では `llmMode`/`embeddingMode` と必ず一致する。
   * 個別に上書きした場合にどちらの実体を指すかは曖昧になるため、**新しいコードは
   * `llmMode`/`embeddingMode` を見ること**。
   */
  mode: ProviderMode;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  llmProvider: LLMProvider;
  embeddingProvider: EmbeddingProvider;
  /** `llmMode`/`embeddingMode` のどちらかが `"openai"` のときだけ存在する。 */
  usageMeter?: UsageMeter;
  /**
   * 渡されたカセット（`CreateProvidersOptions.cassette`）が、この実行では
   * 一度も使われなかったかどうか。
   *
   * ⭐ **`requireCassette` の鏡像である。**`requireCassette` は「`recorded` を
   * 指定したのにカセットが無い」を例外にする——**その逆（カセットを渡したのに
   * `llmMode`/`embeddingMode` のどちらも `"recorded"` を選ばなかった）は例外にできない。**
   *
   * 理由: `cli.ts` の `runRetrieval` の arm A（`llmOverride`/`embeddingOverride` とも
   * `"deterministic"`）は、`resolveRecordedRun` が返したカセットを**全 arm に**渡す
   * 配線の下で走る——これは現物を読んで確かめた既存の正当な経路であり（⛔ 走らせて
   * 確かめてはいない）、arm A がカセットを使わないのは壊れているからではない
   * （対照群として意図的に擬似 provider のままにしている）。⟹ ここを例外にすると、
   * いま緑の対照 arm がそのまま落ちる。
   *
   * ⟹ 判定（例外）ではなく、出力に焼く候補の一覧として扱う
   * （ADR 0255 / ADR 0223 決定5「取りこぼしがゼロにならないと分かっている道具に
   * 『これが全部です』と名乗らせない」の適用——ここでの取りこぼしは「例外にできない
   * 正当な無視のケースがある」こと自体を指す）。`cli.ts` の `printProviderMode` が
   * これを画面の警告行として開示する。
   */
  cassetteIgnored: boolean;
}

/** 本物の OpenAI を使う場合のモデル選定。サンプルアプリの裁量値であり、強い根拠は無い。 */
export const OPENAI_LLM_MODEL = "gpt-4o-mini";
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
/** 次元を絞って埋め込みテーブル・HNSW 索引を軽くする（サンプルアプリの裁量値）。 */
export const OPENAI_EMBEDDING_DIMENSIONS = 256;

/** 擬似 provider が使う埋め込み空間。`DeterministicEmbeddingProvider` の既定と揃える。 */
export const DETERMINISTIC_EMBEDDING_SPACE = {
  provider: "testkit",
  model: "deterministic",
  dimensions: 8,
};

export type EnvLike = Partial<Record<string, string | undefined>>;

/**
 * `OPENAI_API_KEY` が空でない値として存在するかどうかだけを見る、切り替えの単一の分岐点。
 * `createProviders` から切り出してあるのは、副作用（provider の構築）無しに分岐の単体テストを
 * 書けるようにするため。
 *
 * **この関数のシグネチャ・振る舞いは変えていない**（既存テスト `providers.test.ts` が
 * 直接呼んでいるため）。`MNEMORA_LLM`/`MNEMORA_EMBEDDING` による個別上書きは
 * `selectLLMMode`/`selectEmbeddingMode` という別関数に足す。
 */
export function selectProviderMode(env: EnvLike): ProviderMode {
  return env.OPENAI_API_KEY ? "openai" : "deterministic";
}

/**
 * `MNEMORA_LLM` が受け付ける値。**`"local"` を含まない**——LLM 側に local 実装は無い
 * （`ProviderMode` の docstring 参照）。
 */
const LLM_MODES = ["openai", "deterministic", "recorded"] as const;

/**
 * `MNEMORA_EMBEDDING` が受け付ける値。`LLM_MODES` に `"local"` を足した形
 * （Issue #109、`@mnemora/local-embedding`）。
 */
const EMBEDDING_MODES = ["openai", "deterministic", "recorded", "local"] as const;

/**
 * `MNEMORA_LLM`/`MNEMORA_EMBEDDING` の値を検証する。空文字は「未指定」として扱う。
 *
 * **許可する値の集合を呼び出し側から渡す**（`LLM_MODES`/`EMBEDDING_MODES`）——
 * LLM と embedding で受け付ける `ProviderMode` の集合が違う（`"local"` は embedding だけ）
 * ため、1つの固定リストでは表現できない。**未知の値は例外**という既存の作法は変えない。
 */
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

/** `MNEMORA_LLM` が指定されていればそれを、無ければ `selectProviderMode` の結果を使う。 */
export function selectLLMMode(env: EnvLike): ProviderMode {
  return parseModeOverride("MNEMORA_LLM", env.MNEMORA_LLM, LLM_MODES) ?? selectProviderMode(env);
}

/** `MNEMORA_EMBEDDING` が指定されていればそれを、無ければ `selectProviderMode` の結果を使う。 */
export function selectEmbeddingMode(env: EnvLike): ProviderMode {
  return (
    parseModeOverride("MNEMORA_EMBEDDING", env.MNEMORA_EMBEDDING, EMBEDDING_MODES) ??
    selectProviderMode(env)
  );
}

/**
 * `source`（既定 `process.env`）から `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` だけを
 * 持ち出す。設定されていなければ（未設定 or 空文字。`parseModeOverride` と同じ
 * 「空文字は未指定」という作法）`{}` を返す。
 *
 * **なぜ要るか（Issue #164 の続き）**: `createExampleRuntime(databaseUrl, { MNEMORA_LLM: …,
 * MNEMORA_EMBEDDING: "local", … })` のようにリテラルの env オブジェクトを渡す呼び出しは
 * `process.env` を丸ごと展開しない——CI の `actions/cache` が job-level env で
 * `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` を設定していても、リテラルの側がそれを運ばなければ
 * `LocalEmbeddingProvider` まで届かず、キャッシュが（保存も復元もされないまま）空回りする。
 * `consolidation-cost.postgres.test.ts` の1本がこれで実際に 429 を踏んだ
 * （`cacheDir=未指定（既定の場所）` が transformers.js の既定パスに落ち、
 * `actions/cache` の `path:` の外へ書き込んでいた。CI run 34704804772）。
 *
 * ⛔ **`...process.env` を丸ごと展開する代わりにこれを使うこと。** `cli.ts` の
 * `identifier-probes`/`consolidation-cost` サブコマンドは `...process.env` を展開して
 * いるが、DB 歯の側は環境変数を意図して固定している（同じファイルの deterministic 版は
 * 素のリテラルのまま）——`...process.env` に戻すと、歯が周囲の環境変数すべてに
 * 左右されるようになる。必要なのはこの1変数だけである。
 */
export function localEmbeddingCacheDirEnv(source: EnvLike = process.env): EnvLike {
  const value = source.MNEMORA_LOCAL_EMBEDDING_CACHE_DIR;
  return value === undefined || value === "" ? {} : { MNEMORA_LOCAL_EMBEDDING_CACHE_DIR: value };
}

/**
 * `LocalEmbeddingProvider` へ渡す固定した Hugging Face revision（Issue #597 案(a)）。
 *
 * 🔴 **クローン（miku）の決定**: 上流の repo 消失・ミラー汚染を予防するため、CI が
 * **使う側**（ここと `scripts/print-local-embedding-cache-key.mjs` のキャッシュ鍵）だけを
 * 採用時の sha に固定する。⛔ **`scripts/check-local-embedding-fingerprint.mjs`（指紋門）は
 * 固定しない**——`main` を照合し続ける番犬として残り、上流の `main` が動いて門が赤くなったら、
 * それがこの固定値を更新せよという合図になる（ADR 0253 追記）。
 *
 * 唯一の宣言は `scripts/local-embedding-pinned-revision.json`（scripts 側。
 * `@mnemora/local-embedding` の公開 API には足していない——`DEFAULT_LOCAL_EMBEDDING_REVISION`
 * のような公開 export は作らない、という決定である）。`print-local-embedding-cache-key.mjs`
 * が同じファイルを読んでおり、**同じ宣言を見ていることが、両者が食い違わない根拠である。**
 *
 * ⛔ **読めなければ投げる。** 黙って `revision: undefined`（transformers.js の既定 `"main"`）
 * へ戻すと、固定したはずの CI が実は固定されていない、という一番気づきにくい壊れ方になる
 * ——`parseModeOverride`/`decideProviderSource` が未知の値で例外にするのと同じ作法。
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

// ---------------------------------------------------------------------------
// カセット再生か実 API かを決める(ADR 0068 ③)
//
// **現物の欠陥**: `cli.ts` の `resolveCassetteForRun` は「`OPENAI_API_KEY` が在れば
// 無条件に実 API」だった。カセット(`examples/chat/cassettes/*.json`)が在っても、
// キーが環境にあるだけで再生のつもりが実 API に倒れる——「明示すればカセットを
// 使える口」がどこにも無かった。
//
// **既定の振る舞いは変えない**（「キーが在れば実 API」は誰かが選んだ意図かもしれない）。
// `MNEMORA_PROVIDER_SOURCE` で**明示したときだけ**、キーの有無を上書きできる能力を足す。
// ---------------------------------------------------------------------------

/**
 * どちらを使うか と、なぜそう決まったか。**理由を捨てない**——`reason` が無いと
 * 「たまたま recorded になった」のか「明示して recorded にした」のかを画面から
 * 区別できず、ADR 0051 の「どちらで走ったかを隠さない」規律が骨抜きになる。
 */
export type ProviderSourceDecision =
  | { source: "openai"; reason: "key-present" }
  | { source: "recorded"; reason: "no-key" }
  | { source: "recorded"; reason: "forced" }
  | { source: "openai"; reason: "forced" };

/**
 * `MNEMORA_PROVIDER_SOURCE` が指定されていればそれを最優先する(カセット側はキーの有無に
 * 関わらず強制できる)。未指定(未設定または空文字)なら、いままで通り `OPENAI_API_KEY` の
 * 有無だけで決まる。
 *
 * **未知の値は例外**(`parseModeOverride` と同じ作法)——黙って既定へ倒れない。
 * **`"openai"` をキー無しで強制された場合も例外**(下のコメント参照)。
 */
export function decideProviderSource(env: EnvLike): ProviderSourceDecision {
  const forced = env.MNEMORA_PROVIDER_SOURCE;
  if (forced === "recorded") {
    return { source: "recorded", reason: "forced" };
  }
  if (forced === "openai") {
    // **キーが無いのに `openai` を強制されたら落とす。**
    //
    // ⚠ ここを「そのまま返す」だけにすると、この ADR が塞ごうとしている欠陥が
    // **新しい形で復活する**——呼び出し側(`cli.ts` の `runCompare`)は
    // `source === "openai"` のときカセットを読まずに `process.env` をそのまま
    // `createProviders` へ渡すので、`selectProviderMode` が「キーが無い ⟹
    // deterministic」と判定する。結果、**画面には「実 API を叩く」と出しながら
    // 意味を持たない擬似 provider で走り、数字の表を出して EXIT=0 で終わる**
    // (実装の途中で実際にこの状態を踏み、走らせて確認した。ADR 0068 参照)。
    //
    // **⟹「明示した source と、実際に使われる provider が食い違う」経路を作らない。**
    // これは ADR 0051 が `requireCassette` で引いたのと同じ線であり、
    // 反対側(`recorded` を強制したのにカセットが無い)は既にそこで落ちている。
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

/** `decideProviderSource` の結果を、画面に出すための一文にする。 */
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
 * 「予定」を名乗った経路だけが持つ値。**名乗っていない経路は `null` を渡す**
 * （省略できない・既定値を持たない）。
 *
 * ⭐ **省略可能にしない理由は `Providers.cassetteIgnored` と同じである**——
 * 「予定を名乗ったのに、食い違いを開示しないまま provider バナーを出す」経路を
 * 書けなくするため（AGENTS.md「形で塞ぐ」）。`cli.ts` の `printProviderMode` は
 * これを必須の引数で受け取る。
 *
 * ⛔ **`null` は「食い違っていない」ではない。「予定を名乗っていない」である。**
 * `chat` / `scope` / `backfill` などは `[cassette]` 行を1行も出さない——
 * 名乗っていない予定と食い違うことはできない。
 */
export type PlannedProviderSource = ProviderSourceDecision["source"] | null;

/**
 * `decideProviderSource` が名乗った「予定」と、`createProviders` が実際に組んだ
 * 「実測」の食い違い（Issue #594）。
 */
export interface PlanActualMismatch {
  plannedSource: ProviderSourceDecision["source"];
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  llmDiffers: boolean;
  embeddingDiffers: boolean;
}

/**
 * 画面に並ぶ2行——`[cassette] provider source の予定`（構築の**前**、
 * `decideProviderSource`）と `[provider] LLM / Embedding`（構築の**後**、
 * `createProviders`）——が食い違っているかを判定する（Issue #594）。
 *
 * 🔴 **なぜ `Providers.cassetteIgnored` では足りないか。** あちらは
 * `cassette !== undefined` を前提に持つ——**`cli.ts` の `resolveRecordedRun` は
 * `decision.source === "openai"` の枝でカセットを読まずに即 return する**ので、
 * `openai` 経路では `cassetteIgnored` を `true` にできる枝が1つも無い。
 * ⟹ **この経路の食い違いを、あの検出器は原理的に見ない。**
 * 【実測】`plan-actual-mismatch.test.ts` の陽性対照が、この盲点そのものを固定している。
 *
 * ⭐⭐ **これは判定ではなく開示である。⛔ 例外にはできない。**
 * `cli.ts` の `buildArmSpecs` が組む `retrieval` の arm A（擬似LLM+擬似埋め込み）と
 * arm B（擬似LLM+本物の埋め込み）は、**意図して**予定と食い違わせる対照群である。
 * ⟹ 食い違いそのものは欠陥とは限らず、**正当な食い違いと事故の食い違いを、
 * この関数は区別しない（区別できない）。** `Providers.cassetteIgnored` が
 * 例外になれないのと同じ理由であり、ADR 0255 / ADR 0223 決定5 の適用である。
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
 * `detectPlanActualMismatch` の結果を、画面に焼く行にする。
 *
 * ⭐ **予定の値と実測の値を、どちらも逐語で出す**——読み手に2行を突き合わせさせない、
 * というのが Issue #594 の芯である。⛔ **どちらが正しいかは名乗らない**
 * （上の「判定ではなく開示である」を参照）。
 *
 * ⚠ **`describeMode`（`cli.ts`）の長い説明文ではなく `ProviderMode` の値そのものを出す。**
 * この行の役目は2行の**突き合わせ**であり、突き合わせる相手は
 * `MNEMORA_LLM` / `MNEMORA_EMBEDDING` に書く値だからである。
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
  /**
   * `"recorded"` モードで再生に使うカセット（ADR 0051）。`"recorded"` を選んだのに
   * これが無ければ**構築時に落ちる**——カセット未指定を「じゃあ擬似物で」と読み替えない。
   */
  cassette?: Cassette;
  /**
   * 実 API の入出力を記録する（ADR 0051）。`"openai"` を選んだ側だけが記録の対象になる
   * ——叩いていない API は記録しようがない。
   */
  recorder?: CassetteRecorder;
  /**
   * `OpenAILLMProvider` へ渡す `temperature`（省略可能な純追加、Issue #690 段3a）。
   *
   * **省略時（既定）は渡さない**——`llmMode === "openai"` の既存の呼び出し（`compare`/
   * `retrieval`/`answer` 等）はこの欄を渡していないため、挙動は1バイトも変わらない。
   * `answer-time-weighting` ベンチが、非決定性を切り分けるために temperature を固定
   * したいときだけ明示的に渡す。
   */
  llmTemperature?: number;
}

export function createProviders(
  env: EnvLike = process.env,
  options: CreateProvidersOptions = {},
): Providers {
  const mode = selectProviderMode(env);
  const llmMode = selectLLMMode(env);
  const embeddingMode = selectEmbeddingMode(env);
  const { cassette, recorder, llmTemperature } = options;

  const requireCassette = (which: string): Cassette => {
    if (cassette === undefined) {
      throw new Error(
        `${which} に "recorded" を指定したが、カセットが渡されていない（ADR 0051）。` +
          "先に `record` サブコマンドで記録すること。",
      );
    }
    return cassette;
  };

  // LLM・Embedding のどちらか一方でも本物を使うなら、1つの usage-meter（1つの実
  // OpenAI クライアント）を両方で共有する——呼び出し回数・トークン・費用をこのプロセスの
  // 実行全体で一箇所に集計するため（PR 本文 (A)）。
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
    return recorder ? new RecordingLLMProvider(real, recorder, OPENAI_LLM_MODEL) : real;
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
    // Issue #109: 外部サービスへ繋がない埋め込み（ADR 0085）。鍵もカセットも要らない
    // ——`recorded`/`openai` より先に見る必要は無いが、`!== "openai"` の擬似物 fallback
    // より先に見ないと `local` が誤って `DeterministicEmbeddingProvider` に落ちてしまう。
    if (embeddingMode === "local") {
      // `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` が指定されていれば `cacheDir` として渡す
      // （`LocalEmbeddingProvider` のコンストラクタが元から持つオプション——**使うだけで
      // このパッケージ自体は変更していない**）。CI の `identifier-probes` ジョブが
      // `actions/cache` でモデル重みをキャッシュする場所を固定するために使う——
      // transformers.js の既定（`~/.cache/huggingface`）は環境によって場所が変わりうる
      // ため、明示したパスのほうが「次の実行でも同じ場所を見る」ことを保証しやすい。
      //
      // `revision` も渡す（Issue #597 案(a)）。CI が使う側（ここと
      // `scripts/print-local-embedding-cache-key.mjs` のキャッシュ鍵）だけを、採用時の
      // sha に固定する——`scripts/local-embedding-pinned-revision.json` が唯一の宣言。
      // ⛔ `@mnemora/local-embedding` 自体の既定は変えていない（`revision` を渡さなければ
      // transformers.js の既定 `"main"` のまま）。ここは「examples/chat が渡す値」を
      // 固定するだけである。
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
    return recorder ? new RecordingEmbeddingProvider(real, recorder) : real;
  };

  const llmProvider = buildLLM();
  const embeddingProvider = buildEmbedding();

  // `requireCassette` の鏡像（`Providers.cassetteIgnored` の docstring参照）。
  // 例外にはできない——`Providers.cassetteIgnored` の docstring の arm A を見ること。
  const cassetteIgnored =
    cassette !== undefined && llmMode !== "recorded" && embeddingMode !== "recorded";

  return {
    mode,
    llmMode,
    embeddingMode,
    llmProvider,
    embeddingProvider,
    cassetteIgnored,
    ...(usageMeter !== undefined ? { usageMeter } : {}),
  };
}
