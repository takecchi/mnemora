// ADR 0051 の「引き受けた負債1」を、測れる形にした歯。
//
// カセットは probe set に強く結び付いている。probe を1件足して録り直しを忘れると、
// **再生は「記録に無い」で落ちる**——設計としてはそれで正しいが、落ちる場所が
// `retrieval` の実行中（DB を用意して数分走らせた後）になる。
//
// ここでは、その食い違いを**検査の時点で**捕まえる。DB も API キーも要らない。

import { embeddingCassetteKey } from "@mnemora/testkit";
import { describe, expect, it } from "vitest";
import { COMPARE_CASSETTE_PATH, cassetteExists, loadCassette } from "../cassette-io.js";
import { DEFAULT_HAYSTACK_SIZE, PROBES, buildProbeSetConversation } from "../probe-set.js";
import { DEFAULT_COMPARE_SEQUENCE } from "../compare.js";
import { buildConversation } from "../scenario.js";

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
