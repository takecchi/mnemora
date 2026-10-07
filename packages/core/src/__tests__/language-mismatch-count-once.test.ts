import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import * as languageMismatch from "../language-mismatch.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const profileSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../language-mismatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof languageMismatch>();
  return {
    ...actual,
    profileObservationLanguage: (text: string) => {
      profileSpy.calls += 1;
      return actual.profileObservationLanguage(text);
    },
  };
});

// ---- 参照実装: 畳む前の `detectLanguageMismatch` の写し ----
const CJK = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
const LATIN = /(?=\p{L})\p{Script=Latin}/gu;
const LETTER = /\p{L}/gu;
const URL_PATTERN = /https?:\/\/\S+/gi;
const CODE_MARKER = /[`{}<>|\\]|&&|=>|(?:^|\s)--[a-z]|(?:^|\s)\.{0,2}\/[\w.-]+/;
const LOWERCASE_WORD = /^[a-z]+(?:'[a-z]+)?[.,!?;:]?$/;
function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}
function referenceDetect(
  observationText: string,
  content: string,
): languageMismatch.LanguageMismatch | null {
  const observationCjk = count(observationText, CJK);
  if (observationCjk < languageMismatch.LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS) return null;
  const observationLatin = count(observationText, LATIN);
  if (
    observationCjk / (observationCjk + observationLatin) <
    languageMismatch.LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_SHARE
  ) {
    return null;
  }
  if (count(content, CJK) > 0) return null;
  if (CODE_MARKER.test(content)) return null;
  const prose = content.replace(URL_PATTERN, " ");
  const latinLetters = count(prose, LATIN);
  if (latinLetters < languageMismatch.LANGUAGE_MISMATCH_MIN_CONTENT_LATIN_LETTERS) return null;
  const share = latinLetters / count(prose, LETTER);
  if (share < languageMismatch.LANGUAGE_MISMATCH_MIN_LATIN_SHARE) return null;
  const lowercaseWords = prose.split(/\s+/).filter((word) => LOWERCASE_WORD.test(word)).length;
  if (lowercaseWords < languageMismatch.LANGUAGE_MISMATCH_MIN_CONTENT_LOWERCASE_WORDS) return null;
  return {
    rule: "cjk_observation_latin_content",
    contentLatinLetters: latinLetters,
    contentLatinShare: Math.round(share * 100) / 100,
  };
}

const JA = "今日は渋谷のパン屋で働いています。毎朝パンを焼くのが好きです。";
const EN = "The user works at a bakery in Shibuya and enjoys baking bread every morning.";
const OBSERVATIONS: Record<string, string> = {
  empty: "",
  ja: JA,
  kanjiOnly: "渋谷在住東京勤務",
  kanaOnly: "ユーザーハパンヲヤク",
  belowMinCjk: "あいう and some English text here",
  latin: EN,
  mixedJaHeavy: `${JA} I like bread.`,
  mixedLatinHeavy: `${EN} ${EN} ${EN} ${EN} 日本語です。`,
  mixedAtThreshold: `${"あ".repeat(3)}${"a".repeat(7)}`,
  roman: `第一章の概要 ${"Ⅰ".repeat(24)}`,
  hangul: "안녕하세요 반갑습니다",
  huge: `${JA}\n`.repeat(5_000),
  hugeLatin: `${EN}\n`.repeat(3_000) + "日本語の名前です",
};
const CONTENTS: Record<string, string> = {
  empty: "",
  en: EN,
  ja: "ユーザーは渋谷のパン屋で働いており、毎朝パンを焼くのが好き。",
  short: "Tokyo Disneyland",
  properNouns: "Tokyo Disneyland Resort Hotel MiraCosta",
  code: "run `npm run build` && deploy --prod today for everyone",
  url: "https://example.com/some/very/long/path/that/has/many/letters/in/it",
  urlPlusEn: `${EN} https://example.com/x`,
  enPlusKana: `${EN} ユ`,
  cyrillic: "Пользователь работает в пекарне в Сибуя каждое утро и любит печь",
  roman: `the user works ${"Ⅳ".repeat(12)}`,
  huge: `${EN} `.repeat(2_000),
};

describe("(a) 観測の数えを畳んでも、判定の結果は畳む前と1バイトも変わらない（ADR 0507）", () => {
  for (const [oName, observation] of Object.entries(OBSERVATIONS)) {
    // 観測ごとに1回だけ数えて、全候補へ使い回す（runtime の使い方）。
    const profile = languageMismatch.profileObservationLanguage(observation);
    for (const [cName, content] of Object.entries(CONTENTS)) {
      it(`観測 ${oName} × 候補 ${cName}`, () => {
        const expected = referenceDetect(observation, content);
        expect(languageMismatch.detectLanguageMismatch(observation, content)).toStrictEqual(
          expected,
        );
        expect(languageMismatch.detectLanguageMismatchFromProfile(profile, content)).toStrictEqual(
          expected,
        );
      });
    }
  }

  it("陽性対照: 組の中に、印が付くものと付かないものの両方が在る（全部 null では何も縛れない）", () => {
    let marked = 0;
    let unmarked = 0;
    for (const observation of Object.values(OBSERVATIONS)) {
      for (const content of Object.values(CONTENTS)) {
        if (referenceDetect(observation, content) === null) unmarked += 1;
        else marked += 1;
      }
    }
    expect(marked).toBeGreaterThan(10);
    expect(unmarked).toBeGreaterThan(10);
  });
});

const ctx: Ctx = { tenantId: "language-mismatch-count-once" };

function makeKit(contents: readonly string[]) {
  const llm: LLMProvider = {
    complete: async () => ({ content: "" }),
    completeStructured: async (_ctx, req) =>
      req.schema.parse({
        memories: contents.map((content) => ({ content, provenanceKind: "stated" })),
      }),
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
    runtime,
    createdMetas: async () =>
      (await stores.eventStore.list(ctx, { kind: "created" })).map((e) => e.meta ?? {}),
  };
}

describe("(b) 観測の数えは、1回の observe で候補の数によらず1回だけ（ADR 0507）", () => {
  for (const n of [1, 5, 40]) {
    it(`候補 ${n} 件: 数え関数は1回。印は候補ごとに今までどおり付く`, async () => {
      // 偶数番目は英語（印が付く）、奇数番目は日本語（印が付かない）。
      const contents = Array.from({ length: n }, (_, i) =>
        i % 2 === 0 ? `${EN} (${i})` : `ユーザーは渋谷のパン屋で働いており ${i} 番目の記憶。`,
      );
      const kit = makeKit(contents);
      profileSpy.calls = 0;
      const result = await kit.runtime.observe(ctx, { kind: "utterance", text: JA });
      expect(result.extraction).toBe("ok");
      expect(result.memoryIds).toHaveLength(n);
      expect(profileSpy.calls).toBe(1);
      const metas = await kit.createdMetas();
      expect(metas).toHaveLength(n);
      const marked = metas.filter((m) => m.languageMismatch !== undefined);
      expect(marked).toHaveLength(Math.ceil(n / 2));
      for (const m of marked) {
        expect(m.languageMismatch).toMatchObject({ rule: "cjk_observation_latin_content" });
      }
    });
  }

  it("observe を2回呼べば、観測が違うので2回数える（観測をまたいで使い回さない）", async () => {
    const kit = makeKit([EN, `${EN} again`]);
    profileSpy.calls = 0;
    await kit.runtime.observe(ctx, { kind: "utterance", text: JA });
    await kit.runtime.observe(ctx, { kind: "utterance", text: `${JA} 別の観測です。` });
    expect(profileSpy.calls).toBe(2);
  });
});
