// ADR 0050 の「引き受けた負債1」を、測れる形にした歯。
//
// カセットは probe set に強く結び付いている。probe を1件足して録り直しを忘れると、
// **再生は「記録に無い」で落ちる**——設計としてはそれで正しいが、落ちる場所が
// `retrieval` の実行中（DB を用意して数分走らせた後）になる。
//
// ここでは、その食い違いを**検査の時点で**捕まえる。DB も API キーも要らない。

import { embeddingCassetteKey } from "@mnemora/testkit";
import { describe, expect, it } from "vitest";
import { cassetteExists, loadCassette } from "../cassette-io.js";
import { DEFAULT_HAYSTACK_SIZE, PROBES, buildProbeSetConversation } from "../probe-set.js";

describe("記録した応答のカセットと probe set の対応（ADR 0050）", () => {
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
