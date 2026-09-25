// ADR 0051 の「引き受けた負債1」を、測れる形にした歯。
//
// カセットは probe set に強く結び付いている。probe を1件足して録り直しを忘れると、
// **再生は「記録に無い」で落ちる**——設計としてはそれで正しいが、落ちる場所が
// `retrieval` の実行中（DB を用意して数分走らせた後）になる。
//
// ここでは、その食い違いを**検査の時点で**捕まえる。DB も API キーも要らない。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { embeddingCassetteKey, llmCassetteKey } from "@mnemora/testkit";
import { describe, expect, it } from "vitest";
import {
  ANSWER_CASSETTE_PATH,
  ANSWER_ORDER_LEGEND_CASSETTE_PATH,
  ANSWER_TIME_WEIGHTING_CASSETTE_PATH,
  ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH,
  COMPARE_CASSETTE_PATH,
  cassetteExists,
  loadCassette,
} from "../cassette-io.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import { buildNaiveAnswerPromptSpec } from "../answer-bench.js";
import { OPENAI_LLM_MODEL } from "../providers.js";
import { DEFAULT_HAYSTACK_SIZE, PROBES, buildProbeSetConversation } from "../probe-set.js";
import { DEFAULT_COMPARE_SEQUENCE } from "../compare.js";
import { buildConversation } from "../scenario.js";
import { TIME_WEIGHTING_CASE_SET_DEV } from "../time-weighting-case-set.dev.js";
import { TIME_WEIGHTING_CASE_SET_EVAL } from "../time-weighting-case-set.eval.js";
import { TIME_WEIGHTING_CASE_SET_EVAL_UNDATED } from "../time-weighting-case-set.eval-undated.js";

/**
 * `buildMnemoraPrompt` の描画が変わっても、旧形式カセットは1バイトも変えない
 * （ADR 0309、Issue #691 続き）。**ここで固定する sha256 は「正本の写し」ではなく、
 * それ自体が実測した記録**である——`answer-trials-material.ts` が ADR 0301 の
 * 対照の基準として読み続ける2ファイルが、意図せず書き換わっていないことを
 * このファイル（カセットの対応を検査する場所）自身で捕まえる。
 */
function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex");
}

describe("記録した応答のカセットと probe set の対応（ADR 0051）", () => {
  it("カセットがリポジトリに存在する", () => {
    expect(cassetteExists()).toBe(true);
  });

  it("形式検査に通る", () => {
    expect(() => loadCassette()).not.toThrow();
  });

  it("記録元は、いま使っている埋め込み空間と同じである", () => {
    // 空間が違えば再生時に構築段階で落ちるが、その理由をここで名指ししておく。
    expect(loadCassette().embedding.space).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 256,
    });
  });

  it("すべての probe の質問文が記録されている（probe を足したら録り直す）", () => {
    const { entries } = loadCassette().embedding;
    const missing = PROBES.filter((p) => entries[embeddingCassetteKey(p.query)] === undefined).map(
      (p) => p.id,
    );
    expect(missing).toEqual([]);
  });

  it("LLM の記録件数が、probe set の発話数と一致する（発話を足したら録り直す）", () => {
    // 発話1件につき `observe()` が抽出を1回呼ぶ（既定 `extract: 'sync'`）。
    // 件数がずれていたら、probe set か haystack の大きさが記録以降に変わっている。
    const utterances = buildProbeSetConversation(DEFAULT_HAYSTACK_SIZE);
    expect(Object.keys(loadCassette().llm.entries)).toHaveLength(utterances.length);
  });
});

// ---------------------------------------------------------------------------
// compare のカセット（ADR 0052 / ADR 0299）
//
// `retrieval` と同じ理由で、probe set ならぬ**会話生成関数**とカセットがずれたら
// 検査の時点で捕まえる。**以前**は `scenario.ts` の filler が12文の固定配列を巡回する
// だけだったため、compare の入力は filler 12種 + 事実表明1種の13種しかなく、657回の
// LLM 呼び出しがこの13種に畳まれていた（ADR 0052 の「代償」）。**ADR 0299（Issue #340）
// で filler を話題×述語の直積による一意な生成へ直した後**は、compare の入力は
// 「最長会話（`fillerPairs=320`）の user 発話320種 + 事実表明1種」の321種になる
// ——依然として657回の呼び出しがこの321種に畳まれる（同じ理由・同じ鍵の設計。
// 畳まれる先の種類数が13から321へ増えただけで、鍵がプロンプトのハッシュである
// という設計自体は変えていない）。
// ---------------------------------------------------------------------------

describe("compare のカセットと会話生成の対応（ADR 0052）", () => {
  it("カセットがリポジトリに存在し、形式検査に通る", () => {
    expect(cassetteExists(COMPARE_CASSETTE_PATH)).toBe(true);
    expect(() => loadCassette(COMPARE_CASSETTE_PATH)).not.toThrow();
  });

  it("記録元は、いま使っている埋め込み空間と同じである", () => {
    expect(loadCassette(COMPARE_CASSETTE_PATH).embedding.space).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 256,
    });
  });

  it("会話に現れる user 発話の種類がすべて記録されている（filler を足したら録り直す）", () => {
    // 最長の会話に現れる user 発話の集合が、あらゆる会話長の入力の上位集合になる。
    const longest = Math.max(...DEFAULT_COMPARE_SEQUENCE);
    const texts = new Set(buildConversation(longest).userUtterances.map((t) => t.text));
    const entries = loadCassette(COMPARE_CASSETTE_PATH).llm.entries;
    // 鍵はプロンプト全体のハッシュなので、ここでは「種類の数」が一致することで代替する
    // ——プロンプトの組み立ては `packages/core` の抽出器側の責務であり、
    // examples/chat から再現すると二重定義になる。
    expect(Object.keys(entries)).toHaveLength(texts.size);
  });

  it("🔴 記録は入力の種類ぶんしか無い——実行時の呼び出し回数とは一致しない（ADR 0052 の代償）", () => {
    // この歯は「少ないのは壊れているからではない」ことを固定する。
    // 657回の呼び出しが入力の種類数（ADR 0299 以降は321件）に畳まれるのは
    // 鍵の設計どおりであり、**その結果として再生は実行時の分散を潰す**（ADR 0052）。
    const entries = Object.keys(loadCassette(COMPARE_CASSETTE_PATH).llm.entries);
    const totalCalls = DEFAULT_COMPARE_SEQUENCE.reduce((sum, n) => sum + n + 1, 0);
    expect(entries.length).toBeLessThan(totalCalls);
    expect(totalCalls).toBe(657);
  });
});

// ---------------------------------------------------------------------------
// `answer` の旧形式カセット（`examples/chat/cassettes/answer.json`）は、
// `record`/`verify`/CLI の再生対象からは外れた（ADR 0309）が、
// `answer-trials-material.ts` が ADR 0301 の対照の基準として読み続ける。
// ⟹ **1バイトも変わっていないことだけ**をここで固定する——
// 中身の対応検査（質問文・naive プロンプト等）は、もう実行時に使わないので増やさない。
// ---------------------------------------------------------------------------

describe("`answer` の旧形式カセット（ADR 0301 対照の基準。1バイトも変えない、ADR 0309）", () => {
  it("カセットがリポジトリに存在し、形式検査に通る", () => {
    expect(cassetteExists(ANSWER_CASSETTE_PATH)).toBe(true);
    expect(() => loadCassette(ANSWER_CASSETTE_PATH)).not.toThrow();
  });

  it("sha256 が実測した記録のままである（書き換わっていたら落ちる）", () => {
    expect(sha256OfFile(ANSWER_CASSETTE_PATH)).toBe(
      "303d59031935cbcabad9c55aa9e4b605e697944359d3a71196f4b11ce58acd7b",
    );
  });
});

describe("`answer` の新形式カセットと評価ケース集合の対応（Issue #498 / #506 / #691、ADR 0309）", () => {
  const cases = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];

  it("カセットがリポジトリに存在する", () => {
    expect(cassetteExists(ANSWER_ORDER_LEGEND_CASSETTE_PATH)).toBe(true);
  });

  it("形式検査に通る", () => {
    expect(() => loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH)).not.toThrow();
  });

  it("記録元は、いま使っている埋め込み空間と同じである", () => {
    expect(loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH).embedding.space).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 256,
    });
  });

  it("記録元の LLM は、いま使っているモデルと同じである", () => {
    expect(loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH).llm.model).toBe(OPENAI_LLM_MODEL);
  });

  it("すべてのケースの質問文が埋め込みとして記録されている（ケースを足したら録り直す）", () => {
    // `queryRecall` は `conversation.query`（＝ ケースの `question`）を埋め込む。
    const { entries } = loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH).embedding;
    const missing = cases
      .filter((c) => entries[embeddingCassetteKey(c.question)] === undefined)
      .map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it("🔴 すべてのケースの naive（全文経路）回答プロンプトが記録されている", () => {
    // ⭐ naive 側のプロンプトは**ケースの定義だけから決まる**（recall に依らない）ので、
    // ここで完全に組み立て直して鍵を引ける——ケースの会話・質問を1文字でも変えて
    // 録り直しを忘れたら、実行の数分後ではなく**この検査の時点で**赤くなる。
    // ⛔ mnemora 側は `recall()` の結果に依るため、ここからは組み立てられない。
    // ⚠ naive プロンプトの形は `buildMnemoraPrompt` の描画（ADR 0309）に依らないので、
    // 旧形式カセットと新形式カセットで同じ鍵が引けるはずである——だが検査は新形式側
    // （実際に使う側）だけに置く。二重化すると、どちらかを直し忘れて静かにずれる。
    const { entries } = loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH).llm;
    const missing = cases
      .filter((c) => entries[llmCassetteKey(buildNaiveAnswerPromptSpec(c))] === undefined)
      .map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it("🔴 記録は入力の種類ぶんしか無い——実行時の呼び出し回数とは一致しない（ADR 0052 の代償）", () => {
    // ⚠ `answer` の評価ケースは同じフィラー発話を共有しており、同じ抽出プロンプトが
    // 1回の記録の中で複数回現れる。**記録器はそれを memo として1回しか叩かない**
    // （`RecordingLLMProvider`）——さもないと後勝ちで先の値が消え、記録が、記録を
    // 作った実行そのものを再生できなくなる。
    const entries = Object.keys(loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH).llm.entries);
    // 回答生成2回(naive+mnemora) + judge2回(naive+mnemora) をケース数ぶん + 抽出（会話ターンぶん）。
    const answerAndJudgeCalls = cases.length * 4;
    expect(entries.length).toBeGreaterThan(answerAndJudgeCalls);
  });
});

// ---------------------------------------------------------------------------
// answer-time-weighting のカセット（Issue #690、ADR 0300、段3b）
//
// `answer` と違い、会話も抽出も無い——記憶を直接書くため、埋め込みの対象は
// (1) 各ケースの質問文と (2) 各ケースが直接書く記憶の content の2種類だけである。
// ---------------------------------------------------------------------------

describe("`answer-time-weighting` の旧形式カセット（実行時にはもう使わない。1バイトも変えない、ADR 0309）", () => {
  it("カセットがリポジトリに存在し、形式検査に通る", () => {
    expect(cassetteExists(ANSWER_TIME_WEIGHTING_CASSETTE_PATH)).toBe(true);
    expect(() => loadCassette(ANSWER_TIME_WEIGHTING_CASSETTE_PATH)).not.toThrow();
  });

  it("sha256 が実測した記録のままである（書き換わっていたら落ちる）", () => {
    expect(sha256OfFile(ANSWER_TIME_WEIGHTING_CASSETTE_PATH)).toBe(
      "43b4b593afedc590a44bb9c5770d0c193eb48f610a5978b43b9d518beb86e79c",
    );
  });
});

describe("`answer-time-weighting` の新形式カセットとケース集合の対応（Issue #690 / #691、ADR 0300 / 0309）", () => {
  const cases = [
    ...TIME_WEIGHTING_CASE_SET_DEV,
    ...TIME_WEIGHTING_CASE_SET_EVAL,
    ...TIME_WEIGHTING_CASE_SET_EVAL_UNDATED,
  ];

  it("カセットがリポジトリに存在し、形式検査に通る", () => {
    expect(cassetteExists(ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH)).toBe(true);
    expect(() => loadCassette(ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH)).not.toThrow();
  });

  it("記録元は、いま使っている埋め込み空間と同じである", () => {
    expect(loadCassette(ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH).embedding.space).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 256,
    });
  });

  it("記録元の LLM は、いま使っているモデルと同じである", () => {
    expect(loadCassette(ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH).llm.model).toBe(
      OPENAI_LLM_MODEL,
    );
  });

  it("すべてのケースの質問文が埋め込みとして記録されている（ケースを足したら録り直す）", () => {
    const { entries } = loadCassette(ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH).embedding;
    const missing = cases
      .filter((c) => entries[embeddingCassetteKey(c.question)] === undefined)
      .map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it("すべてのケースが直接書く記憶の content が埋め込みとして記録されている（記憶を足したら録り直す）", () => {
    // seedTimeWeightingMemories は seed.content をそのまま embed する
    // （time-weighting-bench.ts の buildTimeWeightingNewMemory / drainEmbedTicks）。
    const { entries } = loadCassette(ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH).embedding;
    const missing = cases.flatMap((c) =>
      c.memories
        .filter((m) => entries[embeddingCassetteKey(m.content)] === undefined)
        .map((m) => `${c.id}/${m.localId}`),
    );
    expect(missing).toEqual([]);
  });

  it("LLM の記録が1件以上ある（record:answer-time-weighting を一度も実行していない空カセットではない）", () => {
    const entries = Object.keys(
      loadCassette(ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH).llm.entries,
    );
    expect(entries.length).toBeGreaterThan(0);
  });
});
