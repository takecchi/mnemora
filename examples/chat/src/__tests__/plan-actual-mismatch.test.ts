import { describe, expect, it } from "vitest";
import {
  createProviders,
  decideProviderSource,
  describePlanActualMismatch,
  detectPlanActualMismatch,
} from "../providers.js";

/**
 * Issue #594 —— **「予定」と「実測」が食い違ったとき、画面がそれを名指しするか。**
 *
 * `cli.ts` の画面には2つの行が出る。**別の関数が、別の入力から決めている:**
 *
 * | 行 | 出所 | 入力 |
 * |---|---|---|
 * | `[cassette] provider source の予定: …` | `decideProviderSource` | `MNEMORA_PROVIDER_SOURCE` / `OPENAI_API_KEY` |
 * | `[provider] LLM / Embedding : …` | `createProviders` | `MNEMORA_LLM` / `MNEMORA_EMBEDDING` / `OPENAI_API_KEY` |
 *
 * ⟹ **両者は原理的に食い違いうる**（ADR 0262「これが覆るとしたら」）。
 *
 * ⚠ **この鍵は偽物である。実 API は1バイトも叩かない。**下の陽性対照の 1 本目は
 * `MNEMORA_LLM`/`MNEMORA_EMBEDDING` をどちらも `"deterministic"` に倒すため、
 * `createProviders` は OpenAI provider を1つも組まない（`usageMeter` が `undefined` に
 * なることで確かめる）。
 */
const FAKE_KEY = "sk-fake-not-a-real-key";

/**
 * 🔴 **陽性対照（ADR 0256）。この describe が緑でないかぎり、下の本題の赤は何も証明しない。**
 *
 * ここで固定するのは **「食い違いが本当に起きていること」と「既存の検出器がそれを
 * 見ていないこと」**である——本題の歯が赤くなったとき、それが「食い違いを作れて
 * いないから」ではないことを、同じファイルの中で示す。
 */
describe("陽性対照 — 予定と実測は実際に食い違い、`cassetteIgnored` はそれを見ていない", () => {
  it("鍵あり + `MNEMORA_LLM`/`MNEMORA_EMBEDDING` を deterministic に明示すると、予定=openai・実測=deterministic になる", () => {
    const env = {
      OPENAI_API_KEY: FAKE_KEY,
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    };

    // 画面の「予定」の側。
    expect(decideProviderSource(env)).toEqual({ source: "openai", reason: "key-present" });

    // 画面の「実測」の側。`cli.ts` の `resolveRecordedRun` は
    // `decision.source === "openai"` の枝でカセットを読まずに即 return するため、
    // `createProviders` へ渡る options は空である——ここでも同じ形で呼ぶ。
    const providers = createProviders(env, {});
    expect(providers.llmMode).toBe("deterministic");
    expect(providers.embeddingMode).toBe("deterministic");

    // 実 API を叩いていないことの証拠。`usageMeter` は `llmMode`/`embeddingMode` の
    // どちらかが `"openai"` のときだけ作られる。
    expect(providers.usageMeter).toBeUndefined();
  });

  it("🔴 その食い違いを `cassetteIgnored` は検出しない（`openai` 枝はカセットを読まないので原理的に発火しない）", () => {
    const env = {
      OPENAI_API_KEY: FAKE_KEY,
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    };
    expect(createProviders(env, {}).cassetteIgnored).toBe(false);

    // 対照: 食い違いの無い `openai` 経路でも `false`。⟹ `cassetteIgnored` は
    // この経路で「食い違いの有無」を1バイトも区別していない。
    expect(createProviders({ OPENAI_API_KEY: FAKE_KEY }, {}).cassetteIgnored).toBe(false);
  });
});

/**
 * 本題 —— **食い違いを名指しする検出器（Issue #594 案(3a)）。**
 *
 * ⭐ **判定ではなく開示である。**`retrieval` の arm A / arm B は**意図して**予定と
 * 食い違わせる対照群であり（`buildArmSpecs`）、食い違い自体は欠陥とは限らない。
 * ⟹ 例外にはできない（Issue #594 案(3b) が落ちた理由）。
 */
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
    // arm B は「擬似LLM + 本物の埋め込み」。予定が recorded のとき embedding は
    // recorded だが LLM は deterministic に倒される（`buildArmSpecs`）。
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

    // 予定の側と実測の側が、どちらも画面に出る。
    expect(line).toContain("予定");
    expect(line).toContain("openai");
    expect(line).toContain("deterministic");

    // ⭐ **開示であって判定ではない**——意図した食い違い（arm A / arm B）が
    // 正当であることを、行そのものが名乗る。
    expect(line).toContain("arm");
  });
});
