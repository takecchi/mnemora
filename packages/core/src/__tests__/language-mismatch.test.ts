import { describe, expect, it } from "vitest";
import {
  LANGUAGE_MISMATCH_MIN_CONTENT_LATIN_LETTERS,
  LANGUAGE_MISMATCH_MIN_CONTENT_LOWERCASE_WORDS,
  LANGUAGE_MISMATCH_MIN_LATIN_SHARE,
  LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS,
  LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_SHARE,
  detectLanguageMismatch,
} from "../language-mismatch.js";

/**
 * Issue #1370（ADR 0391）: 言語の事後検査の判定関数（純関数）。
 * 「印を付けるだけ」の判定であり、偽陽性の側（固有名詞だけ・コード片・短い本文・
 * 観測が日本語ほぼ皆無）に倒れないことを、ここで例で縛る。
 */

const JA_OBSERVATION = "今日は渋谷のパン屋で働いています。毎朝パンを焼くのが好きです。";
const EN_CONTENT = "The user works at a bakery in Shibuya and enjoys baking bread every morning.";

describe("detectLanguageMismatch: 陽性（印が付く）", () => {
  it("日本語の観測から、かな・漢字が1文字も無い英語の本文が出たら印を付ける", () => {
    const mark = detectLanguageMismatch(JA_OBSERVATION, EN_CONTENT);
    expect(mark).not.toBeNull();
    expect(mark?.rule).toBe("cjk_observation_latin_content");
    expect(mark?.contentLatinLetters).toBeGreaterThanOrEqual(
      LANGUAGE_MISMATCH_MIN_CONTENT_LATIN_LETTERS,
    );
    expect(mark?.contentLatinShare).toBeGreaterThanOrEqual(LANGUAGE_MISMATCH_MIN_LATIN_SHARE);
  });

  it("観測がカタカナだけ・漢字だけでも、CJK の量が足りていれば陽性", () => {
    expect(detectLanguageMismatch("ユーザーハパンヲヤク", EN_CONTENT)).not.toBeNull();
    expect(detectLanguageMismatch("渋谷在住東京勤務", EN_CONTENT)).not.toBeNull();
  });

  it("固有名詞（大文字語）が混じっていても、小文字の語が十分あれば陽性", () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "Tanaka lives in Tokyo and goes to work by train."),
    ).not.toBeNull();
  });
});

describe("detectLanguageMismatch: 陰性（印を付けない）", () => {
  it("本文にかな・漢字が1文字でもあれば陰性", () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "ユーザーは Shibuya の bakery works every morning"),
    ).toBeNull();
    expect(detectLanguageMismatch(JA_OBSERVATION, `${EN_CONTENT} 渋`)).toBeNull();
  });

  it("日本語の本文は陰性", () => {
    expect(
      detectLanguageMismatch(JA_OBSERVATION, "ユーザーは渋谷のパン屋で働いている。"),
    ).toBeNull();
  });

  it("観測にかな・漢字が無ければ（英語の観測から英語の本文）陰性", () => {
    expect(detectLanguageMismatch("I work at a bakery in Shibuya.", EN_CONTENT)).toBeNull();
  });

  it("偽陽性への備え: 固有名詞だけ（短い）は陰性", () => {
    expect(
      detectLanguageMismatch("週末は東京ディズニーランドに行った", "Tokyo Disneyland"),
    ).toBeNull();
  });

  it("偽陽性への備え: 固有名詞だけ（長く、大文字語ばかり）は陰性", () => {
    expect(
      detectLanguageMismatch(
        "週末は東京ディズニーランドに行った",
        "Tokyo Disneyland Resort Hotel MiraCosta Bay Area Tower",
      ),
    ).toBeNull();
  });

  it("偽陽性への備え: コード片・コマンドは陰性（短いもの・長いもの・囲み）", () => {
    const obs = "ビルドするときは次のコマンドを打つ";
    expect(detectLanguageMismatch(obs, "npm run build")).toBeNull();
    expect(detectLanguageMismatch(obs, "npm run build && npm run test -- --coverage")).toBeNull();
    expect(
      detectLanguageMismatch(
        obs,
        "`pnpm install --frozen-lockfile` and then run pnpm build for the package",
      ),
    ).toBeNull();
    expect(
      detectLanguageMismatch(
        obs,
        "const value = items.map((item) => item.name).filter(Boolean) in the module",
      ),
    ).toBeNull();
  });

  it("偽陽性への備え: URL だけの本文は陰性", () => {
    expect(
      detectLanguageMismatch(
        "参考リンクはここ",
        "https://example.com/docs/getting-started/installation-and-setup-guide",
      ),
    ).toBeNull();
  });

  it("偽陽性への備え: 短すぎる本文は陰性", () => {
    expect(detectLanguageMismatch(JA_OBSERVATION, "Likes coffee")).toBeNull();
    expect(detectLanguageMismatch(JA_OBSERVATION, "")).toBeNull();
  });

  it("偽陽性への備え: 観測が英語の文に日本語の名前が1つだけ混じる程度なら陰性", () => {
    expect(
      detectLanguageMismatch(
        "Meeting notes: we discussed the roadmap with 田中 and agreed on next steps for the release.",
        "The team agreed on next steps for the release after discussing the roadmap.",
      ),
    ).toBeNull();
  });

  it("ラテン文字が大半でない（他の文字体系が多い）本文は陰性", () => {
    expect(
      detectLanguageMismatch(
        JA_OBSERVATION,
        "Пользователь работает в пекарне and likes bread каждое утро",
      ),
    ).toBeNull();
  });
});

describe("閾値の定数", () => {
  it("名前付きで、意味のある値である", () => {
    expect(LANGUAGE_MISMATCH_MIN_CONTENT_LATIN_LETTERS).toBeGreaterThan(16); // "Tokyo Disneyland" は15字
    expect(LANGUAGE_MISMATCH_MIN_CONTENT_LOWERCASE_WORDS).toBeGreaterThanOrEqual(2);
    expect(LANGUAGE_MISMATCH_MIN_LATIN_SHARE).toBeGreaterThan(0.5);
    expect(LANGUAGE_MISMATCH_MIN_LATIN_SHARE).toBeLessThanOrEqual(1);
    expect(LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS).toBeGreaterThan(0);
    expect(LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_SHARE).toBeGreaterThan(0);
  });
});
