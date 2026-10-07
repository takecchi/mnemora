import { describe, expect, it } from "vitest";
import {
  createProviders,
  decideProviderSource,
  describePlanActualMismatch,
  detectPlanActualMismatch,
} from "../providers.js";

const FAKE_KEY = "sk-fake-not-a-real-key";

describe("陽性対照 — 予定と実測は実際に食い違い、`cassetteIgnored` はそれを見ていない", () => {
  it("鍵あり + `MNEMORA_LLM`/`MNEMORA_EMBEDDING` を deterministic に明示すると、予定=openai・実測=deterministic になる", () => {
    const env = {
      OPENAI_API_KEY: FAKE_KEY,
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    };

    expect(decideProviderSource(env)).toEqual({ source: "openai", reason: "key-present" });

    const providers = createProviders(env, {});
    expect(providers.llmMode).toBe("deterministic");
    expect(providers.embeddingMode).toBe("deterministic");

    expect(providers.usageMeter).toBeUndefined();
  });

  it("🔴 その食い違いを `cassetteIgnored` は検出しない（`openai` 枝はカセットを読まないので原理的に発火しない）", () => {
    const env = {
      OPENAI_API_KEY: FAKE_KEY,
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    };
    expect(createProviders(env, {}).cassetteIgnored).toBe(false);

    expect(createProviders({ OPENAI_API_KEY: FAKE_KEY }, {}).cassetteIgnored).toBe(false);
  });
});

/** 判定ではなく開示にする。arm A / arm B は予定と意図して食い違わせる対照群なので、例外にはできない。 */
describe("detectPlanActualMismatch — 予定と実測の食い違いを名指しする", () => {
  it("🔴 予定=openai・実測=deterministic（Issue #594 が挙げた画面）を、両方の欄の食い違いとして検出する", () => {
    const mismatch = detectPlanActualMismatch("openai", {
      llmMode: "deterministic",
      embeddingMode: "deterministic",
    });
    expect(mismatch).toEqual({
      plannedSource: "openai",
      llmMode: "deterministic",
      embeddingMode: "deterministic",
      llmDiffers: true,
      embeddingDiffers: true,
    });
  });

  it("予定と実測が揃っていれば `undefined`（食い違っていないものを食い違いと呼ばない）", () => {
    expect(
      detectPlanActualMismatch("openai", { llmMode: "openai", embeddingMode: "openai" }),
    ).toBeUndefined();
    expect(
      detectPlanActualMismatch("recorded", { llmMode: "recorded", embeddingMode: "recorded" }),
    ).toBeUndefined();
  });

  it("予定を名乗っていない経路（`null`）では何も検出しない —— 名乗っていない予定と食い違うことはできない", () => {
    expect(
      detectPlanActualMismatch(null, { llmMode: "deterministic", embeddingMode: "deterministic" }),
    ).toBeUndefined();
  });

  it("⭐ 片方だけ食い違う場合を、片方だけとして検出する（`retrieval` の arm B の形）", () => {
    expect(
      detectPlanActualMismatch("recorded", { llmMode: "deterministic", embeddingMode: "recorded" }),
    ).toEqual({
      plannedSource: "recorded",
      llmMode: "deterministic",
      embeddingMode: "recorded",
      llmDiffers: true,
      embeddingDiffers: false,
    });
  });

  it("`local` 埋め込みも予定との食い違いとして数える（実 API でもカセットでもない）", () => {
    expect(
      detectPlanActualMismatch("openai", { llmMode: "openai", embeddingMode: "local" }),
    ).toEqual({
      plannedSource: "openai",
      llmMode: "openai",
      embeddingMode: "local",
      llmDiffers: false,
      embeddingDiffers: true,
    });
  });
});

describe("describePlanActualMismatch — 画面に焼く一行", () => {
  it("予定・実測の両方の値を逐語で含み、⛔ どちらが正しいかは判定しない", () => {
    const mismatch = detectPlanActualMismatch("openai", {
      llmMode: "deterministic",
      embeddingMode: "deterministic",
    });
    expect(mismatch).toBeDefined();
    const line = describePlanActualMismatch(mismatch!);

    expect(line).toContain("予定");
    expect(line).toContain("openai");
    expect(line).toContain("deterministic");

    expect(line).toContain("arm");
  });
});
