// ADR 0051 の「引き受けた負債1」を、測れる形にした歯。
//
// カセットは probe set に強く結び付いている。probe を1件足して録り直しを忘れると、
// **再生は「記録に無い」で落ちる**——設計としてはそれで正しいが、落ちる場所が
// `retrieval` の実行中（DB を用意して数分走らせた後）になる。
//
// ここでは、その食い違いを**検査の時点で**捕まえる。DB も API キーも要らない。

import { embeddingCassetteKey, llmCassetteKey } from "@mnemora/testkit";
import { describe, expect, it } from "vitest";
import {
  ANSWER_CASSETTE_PATH,
  ANSWER_TIME_WEIGHTING_CASSETTE_PATH,
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
// compare のカセット（ADR 0052）
//
// `retrieval` と同じ理由で、probe set ならぬ**会話生成関数**とカセットがずれたら
// 検査の時点で捕まえる。compare の入力は `scenario.ts` の filler 12種 + 事実表明1種の
// **13種しかない**——657回の LLM 呼び出しがこの13種に畳まれる（ADR 0052 の「代償」）。
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
    // 657回の呼び出しが13件に畳まれるのは鍵の設計どおりであり、
    // **その結果として再生は実行時の分散を潰す**（ADR 0052）。
    const entries = Object.keys(loadCassette(COMPARE_CASSETTE_PATH).llm.entries);
    const totalCalls = DEFAULT_COMPARE_SEQUENCE.reduce((sum, n) => sum + n + 1, 0);
    expect(entries.length).toBeLessThan(totalCalls);
    expect(totalCalls).toBe(657);
  });
});

describe("`answer` のカセットと評価ケース集合の対応（Issue #498 / #506、ADR 0051）", () => {
  const cases = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL];

  it("カセットがリポジトリに存在する", () => {
    expect(cassetteExists(ANSWER_CASSETTE_PATH)).toBe(true);
  });

  it("形式検査に通る", () => {
    expect(() => loadCassette(ANSWER_CASSETTE_PATH)).not.toThrow();
  });

  it("記録元は、いま使っている埋め込み空間と同じである", () => {
    expect(loadCassette(ANSWER_CASSETTE_PATH).embedding.space).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 256,
    });
  });

  it("記録元の LLM は、いま使っているモデルと同じである", () => {
    expect(loadCassette(ANSWER_CASSETTE_PATH).llm.model).toBe(OPENAI_LLM_MODEL);
  });

  it("すべてのケースの質問文が埋め込みとして記録されている（ケースを足したら録り直す）", () => {
    // `queryRecall` は `conversation.query`（＝ ケースの `question`）を埋め込む。
    const { entries } = loadCassette(ANSWER_CASSETTE_PATH).embedding;
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
    const { entries } = loadCassette(ANSWER_CASSETTE_PATH).llm;
    const missing = cases
      .filter((c) => entries[llmCassetteKey(buildNaiveAnswerPromptSpec(c))] === undefined)
      .map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it("🔴 記録は入力の種類ぶんしか無い——実行時の呼び出し回数とは一致しない（ADR 0052 の代償）", () => {
    // ⚠ `answer` の評価ケース12件は同じフィラー発話を共有しており、同じ抽出プロンプトが
    // 1回の記録の中で複数回現れる。**記録器はそれを memo として1回しか叩かない**
    // （`RecordingLLMProvider`）——さもないと後勝ちで先の値が消え、記録が、記録を
    // 作った実行そのものを再生できなくなる（本 PR の実測）。
    const entries = Object.keys(loadCassette(ANSWER_CASSETTE_PATH).llm.entries);
    // 回答生成24回 + judge 24回 + 抽出（会話ターンぶん）。
    const answerAndJudgeCalls = cases.length * 4;
    expect(entries.length).toBeGreaterThan(answerAndJudgeCalls);
  });
});

// ---------------------------------------------------------------------------
// answer-time-weighting のカセット（Issue #690、ADR 0299、段3b）
//
// `answer` と違い、会話も抽出も無い——記憶を直接書くため、埋め込みの対象は
// (1) 各ケースの質問文と (2) 各ケースが直接書く記憶の content の2種類だけである。
// ---------------------------------------------------------------------------

describe("`answer-time-weighting` のカセットとケース集合の対応（Issue #690、ADR 0299）", () => {
  const cases = [
    ...TIME_WEIGHTING_CASE_SET_DEV,
    ...TIME_WEIGHTING_CASE_SET_EVAL,
    ...TIME_WEIGHTING_CASE_SET_EVAL_UNDATED,
  ];

  it("カセットがリポジトリに存在し、形式検査に通る", () => {
    expect(cassetteExists(ANSWER_TIME_WEIGHTING_CASSETTE_PATH)).toBe(true);
    expect(() => loadCassette(ANSWER_TIME_WEIGHTING_CASSETTE_PATH)).not.toThrow();
  });

  it("記録元は、いま使っている埋め込み空間と同じである", () => {
    expect(loadCassette(ANSWER_TIME_WEIGHTING_CASSETTE_PATH).embedding.space).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 256,
    });
  });

  it("記録元の LLM は、いま使っているモデルと同じである", () => {
    expect(loadCassette(ANSWER_TIME_WEIGHTING_CASSETTE_PATH).llm.model).toBe(OPENAI_LLM_MODEL);
  });

  it("すべてのケースの質問文が埋め込みとして記録されている（ケースを足したら録り直す）", () => {
    const { entries } = loadCassette(ANSWER_TIME_WEIGHTING_CASSETTE_PATH).embedding;
    const missing = cases
      .filter((c) => entries[embeddingCassetteKey(c.question)] === undefined)
      .map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it("すべてのケースが直接書く記憶の content が埋め込みとして記録されている（記憶を足したら録り直す）", () => {
    // seedTimeWeightingMemories は seed.content をそのまま embed する
    // （time-weighting-bench.ts の buildTimeWeightingNewMemory / drainEmbedTicks）。
    const { entries } = loadCassette(ANSWER_TIME_WEIGHTING_CASSETTE_PATH).embedding;
    const missing = cases.flatMap((c) =>
      c.memories
        .filter((m) => entries[embeddingCassetteKey(m.content)] === undefined)
        .map((m) => `${c.id}/${m.localId}`),
    );
    expect(missing).toEqual([]);
  });

  it("LLM の記録が1件以上ある（record:answer-time-weighting を一度も実行していない空カセットではない）", () => {
    const entries = Object.keys(loadCassette(ANSWER_TIME_WEIGHTING_CASSETTE_PATH).llm.entries);
    expect(entries.length).toBeGreaterThan(0);
  });
});
