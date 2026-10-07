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
    const utterances = buildProbeSetConversation(DEFAULT_HAYSTACK_SIZE);
    expect(Object.keys(loadCassette().llm.entries)).toHaveLength(utterances.length);
  });
});

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
    const longest = Math.max(...DEFAULT_COMPARE_SEQUENCE);
    const texts = new Set(buildConversation(longest).userUtterances.map((t) => t.text));
    const entries = loadCassette(COMPARE_CASSETTE_PATH).llm.entries;
    // 鍵はプロンプト全体のハッシュなので、種類の数が一致することで代替する（組み立てを examples/chat から再現すると二重定義になる）。
    expect(Object.keys(entries)).toHaveLength(texts.size);
  });

  it("🔴 記録は入力の種類ぶんしか無い——実行時の呼び出し回数とは一致しない（ADR 0052 の代償）", () => {
    const entries = Object.keys(loadCassette(COMPARE_CASSETTE_PATH).llm.entries);
    const totalCalls = DEFAULT_COMPARE_SEQUENCE.reduce((sum, n) => sum + n + 1, 0);
    expect(entries.length).toBeLessThan(totalCalls);
    expect(totalCalls).toBe(657);
  });
});

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
    const { entries } = loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH).embedding;
    const missing = cases
      .filter((c) => entries[embeddingCassetteKey(c.question)] === undefined)
      .map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it("🔴 すべてのケースの naive（全文経路）回答プロンプトが記録されている", () => {
    // mnemora 側は recall() の結果に依るので組み立てない。naive 側の検査は新形式カセットにだけ置く（旧形式にも置くと、片方を直し忘れて静かにずれる）。
    const { entries } = loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH).llm;
    const missing = cases
      .filter((c) => entries[llmCassetteKey(buildNaiveAnswerPromptSpec(c))] === undefined)
      .map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it("🔴 記録は入力の種類ぶんしか無い——実行時の呼び出し回数とは一致しない（ADR 0052 の代償）", () => {
    const entries = Object.keys(loadCassette(ANSWER_ORDER_LEGEND_CASSETTE_PATH).llm.entries);
    const answerAndJudgeCalls = cases.length * 4;
    expect(entries.length).toBeGreaterThan(answerAndJudgeCalls);
  });
});

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
