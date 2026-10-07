import { describe, expect, it } from "vitest";
import {
  DEFAULT_JAPANESE_NAME_DENSE_HAYSTACK_SIZE,
  JAPANESE_NAME_PROBES,
  JAPANESE_NAME_TOPIC_KEYWORDS,
  buildJapaneseNameProbeSetConversation,
  findJapaneseNameTopicKeywordViolations,
} from "../japanese-name-probe-set.js";

// 順位を主張する歯は置かない（実測が悪いと main が恒久的に赤くなる）。測るのは集合の形だけ。順位は identifier-probes が値として記録する。
describe("japanese-name-probe-set", () => {
  it("4領域を12件で覆っている", () => {
    expect(JAPANESE_NAME_PROBES).toHaveLength(12);
    const categories = new Set(JAPANESE_NAME_PROBES.map((p) => p.category));
    expect(categories).toEqual(new Set(["person", "org", "product", "place"]));
  });

  it("probe id は重複しない", () => {
    const ids = JAPANESE_NAME_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("query は固有名詞そのものを含む（識別子 probe と同じ狙い）", () => {
    for (const probe of JAPANESE_NAME_PROBES) {
      const keywords = JAPANESE_NAME_TOPIC_KEYWORDS[probe.id] ?? [];
      const [goldName] = keywords;
      expect(goldName).toBeDefined();
      expect(probe.query.includes(goldName!)).toBe(true);
      expect(probe.fact.includes(goldName!)).toBe(true);
    }
  });

  it("すべて日本語である——ASCII の識別子を含まない（この集合の存在理由）", () => {
    for (const probe of JAPANESE_NAME_PROBES) {
      const keywords = JAPANESE_NAME_TOPIC_KEYWORDS[probe.id] ?? [];
      for (const name of keywords) {
        expect(/^[\x20-\x7e]+$/.test(name)).toBe(false);
      }
    }
  });

  it("密 haystack の密度は 60/12 = 5:1 である（識別子ベンチの初期設計と同じ）", () => {
    expect(DEFAULT_JAPANESE_NAME_DENSE_HAYSTACK_SIZE / JAPANESE_NAME_PROBES.length).toBe(5);
  });

  it("haystack は probe の固有名詞を1つも含まない（疎・密の両方）", () => {
    for (const kind of ["sparse", "dense"] as const) {
      const utterances = buildJapaneseNameProbeSetConversation(undefined, kind);
      const haystack = utterances.filter((u) => u.kind === "haystack").map((u) => u.text);
      expect(findJapaneseNameTopicKeywordViolations(haystack)).toEqual([]);
    }
  });

  it("gold と distractor が両方とも会話に現れる", () => {
    const utterances = buildJapaneseNameProbeSetConversation(undefined, "sparse");
    expect(utterances.filter((u) => u.kind === "gold")).toHaveLength(12);
    expect(utterances.filter((u) => u.kind === "distractor")).toHaveLength(12);
  });

  it("gold/distractor が1文字違いなのは5件である（ADR 0110 §2 の標本の形）", () => {
    const oneCharDiff: { probeId: string; differingChars: string }[] = [];
    for (const [probeId, keywords] of Object.entries(JAPANESE_NAME_TOPIC_KEYWORDS)) {
      const g = [...(keywords[0] ?? "")];
      const d = [...(keywords[1] ?? "")];
      if (g.length !== d.length) continue;
      const positions = g.map((ch, i) => i).filter((i) => g[i] !== d[i]);
      if (positions.length !== 1) continue;
      const at = positions[0]!;
      oneCharDiff.push({ probeId, differingChars: `${g[at]}/${d[at]}` });
    }
    oneCharDiff.sort((a, b) => a.probeId.localeCompare(b.probeId));

    expect(
      oneCharDiff.map((entry) => entry.probeId),
      "日本語 probe の「1文字違い」の件数が変わった。ADR 0110 §2 は、この5件の margin が " +
        "−8.0e-5（org-b、最悪）から +4.85e-2（org-c、12件中で最良）まで散らばることを実測し、" +
        "「日本語の1文字違いが引けない」という読みを落とした。⟹ この集合を書き換えると、" +
        "その反例（通っている1文字違い4件）が標本から消え、誤った読みが復活しうる。" +
        "⛔ とくに org-b を易しくしないこと（ADR 0110 §7 案 D は却下されている）。",
    ).toEqual(["org-a", "org-b", "org-c", "person-c", "product-a"]);

    const asciiDifferences = oneCharDiff.filter((entry) =>
      /[\x20-\x7e]/.test(entry.differingChars.replace("/", "")),
    );
    expect(
      asciiDifferences,
      "1文字違いの probe の、弁別している1文字が ASCII になっている。ADR 0110 §5.3 の実測では、" +
        "同じ位置の漢字1文字を算用数字/ラテン文字へ替えるだけでベクトル変位は 2.2〜2.3 倍になり、" +
        "org-b の margin は −8.0e-5 から +2.70e-2 へ符号が反転する。⟹ この書き換えは probe を" +
        "通るようにするが、それは想起が良くなったのではなく問いが易しくなっただけである。" +
        "⛔ ADR 0110 §7 案 D（却下）を踏んでいる。新しい条件を測りたいなら、既存 probe を" +
        "書き換えるのではなく別の集合を足すこと（PR #192 がまさにその形である）。",
    ).toEqual([]);
  });
});
