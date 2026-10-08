import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { detectLanguageMismatch } from "../language-mismatch.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const JA_OBSERVATION = "今日は渋谷のパン屋で働いています。毎朝パンを焼くのが好きです。";

/** 小文字だけの10字の語を `n` 個。ラテン文字が 10n 字・小文字語が n 語になる。 */
function latinWords(n: number): string {
  return Array.from({ length: n }, () => "abcdefghij").join(" ");
}
/** キリル文字（ラテンではない文字）の1語。 */
function cyrillicWord(n: number): string {
  return "ж".repeat(n);
}

describe("ラテン割合の条件（0.9。決定3の5）", () => {
  it("ラテン90字＋キリル10字（割合 0.9 ちょうど）は陽性", () => {
    const content = `${latinWords(9)} ${cyrillicWord(10)}`;
    expect(detectLanguageMismatch(JA_OBSERVATION, content)).toMatchObject({
      rule: "cjk_observation_latin_content",
      contentLatinLetters: 90,
      contentLatinShare: 0.9,
    });
  });

  it("ラテン90字＋キリル11字（割合 約 0.89）は陰性", () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, `${latinWords(9)} ${cyrillicWord(11)}`),
    ).toBeNull();
  });

  it("ラテン80字＋キリル20字（割合 0.8。他の条件はすべて満たす）は陰性", () => {
    // 20字以上・小文字語3語以上・かな漢字なし・コード片なし。割合だけが条件を割る。
    expect(
      detectLanguageMismatch(JA_OBSERVATION, `${latinWords(8)} ${cyrillicWord(20)}`),
    ).toBeNull();
  });
});

describe("contentLatinShare は小数第2位まで（LanguageMismatch の TSDoc）", () => {
  it("ラテン100字＋キリル5字（100/105 = 0.95238…）は 0.95 になる", () => {
    const result = detectLanguageMismatch(JA_OBSERVATION, `${latinWords(10)} ${cyrillicWord(5)}`);
    expect(result).not.toBeNull();
    expect(result!.contentLatinLetters).toBe(100);
    expect(result!.contentLatinShare).toBe(0.95);
  });

  it("ラテン文字だけなら 1", () => {
    expect(detectLanguageMismatch(JA_OBSERVATION, latinWords(3))!.contentLatinShare).toBe(1);
  });
});

describe("コード片の印（決定3の3）は、1つずつ単独で陰性にする", () => {
  const PROSE = "the user works at a bakery in the city every morning";

  it("対照: 印を含まない散文は陽性（以下の陰性が、印だけによると言える）", () => {
    expect(detectLanguageMismatch(JA_OBSERVATION, PROSE)).not.toBeNull();
  });

  it.each([
    ["./scripts/deploy.sh is used to deploy the app to the server"],
    ["/usr/bin/env is used to find the interpreter for the script"],
    ["../config/app.json holds the settings for the server in the city"],
  ])("パスだけを印に持つ本文は陰性: %s", (content) => {
    expect(detectLanguageMismatch(JA_OBSERVATION, content)).toBeNull();
  });

  it.each([["{"], ["}"], ["<"], [">"], ["|"], ["\\"]])(
    "記号 %s だけを印に持つ本文は陰性",
    (mark) => {
      expect(detectLanguageMismatch(JA_OBSERVATION, `${PROSE} ${mark}`)).toBeNull();
    },
  );

  it.each([["&&"], ["--verbose"], ["`"]])("%s だけを印に持つ本文は陰性", (mark) => {
    expect(detectLanguageMismatch(JA_OBSERVATION, `${PROSE} ${mark}`)).toBeNull();
  });
});

describe("検査の対象は content で、digest ではない（決定4）", () => {
  const ctx: Ctx = { tenantId: "language-mismatch-conditions" };
  const EN = "The user works at a bakery in Shibuya and enjoys baking bread every morning.";
  const JA = "ユーザーは渋谷のパン屋で働いており、毎朝パンを焼くのが好き。";

  function kitReturning(memory: { content: string; digest: string }) {
    const llm: LLMProvider = {
      complete: async () => ({ content: "" }),
      completeStructured: async (_ctx, req) =>
        req.schema.parse({ memories: [{ ...memory, provenanceKind: "stated" }] }),
    };
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llm,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content) => `h:${content}`,
      clock: { now: () => new Date(Date.now() + 60_000) },
    });
    return {
      observe: () => runtime.observe(ctx, { kind: "utterance", text: JA_OBSERVATION }),
      createdMetas: async () =>
        (await stores.eventStore.list(ctx, { kind: "created" })).map((e) => e.meta ?? {}),
    };
  }

  it("content が英語・digest が日本語なら、印が出る", async () => {
    const kit = kitReturning({ content: EN, digest: JA });
    await kit.observe();
    const metas = await kit.createdMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0]!.languageMismatch).toMatchObject({ rule: "cjk_observation_latin_content" });
  });

  it("content が日本語・digest が英語なら、印は出ない", async () => {
    const kit = kitReturning({ content: JA, digest: EN });
    await kit.observe();
    const metas = await kit.createdMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0]!.languageMismatch).toBeUndefined();
  });
});
