import { describe, expect, it } from "vitest";
import { buildHaystackUtterance } from "../probe-set.js";
import type { ProbeUtterance } from "../probe-set.js";
import {
  ASSOCIATION_PROBES,
  ASSOCIATION_QUERY_KEYWORDS,
  associationAnchorExternalId,
  associationDistractorExternalId,
  associationGoldExternalId,
  associationHaystackExternalId,
  buildAssociationProbeSetConversation,
  findAssociationBridgeViolations,
  findAssociationQueryLeakViolations,
  ASSOCIATION_HAYSTACK,
  ASSOCIATION_HAYSTACK_SIZE,
} from "../association-probe-set.js";

describe("association-probe-set", () => {
  it("12件、カテゴリが4件ずつ(ascii-id/proper-noun/common-noun)", () => {
    expect(ASSOCIATION_PROBES).toHaveLength(12);
    const counts: Record<string, number> = {};
    for (const probe of ASSOCIATION_PROBES) {
      counts[probe.category] = (counts[probe.category] ?? 0) + 1;
    }
    expect(counts).toEqual({ "ascii-id": 4, "proper-noun": 4, "common-noun": 4 });
  });

  it("probe id は重複しない", () => {
    const ids = ASSOCIATION_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("query は gold と bridge を共有しない(三角形の前提: query ≉ gold)", () => {
    for (const probe of ASSOCIATION_PROBES) {
      expect(probe.query.includes(probe.bridge)).toBe(false);
    }
  });

  it("anchor と gold は bridge を共有する(三角形の前提: anchor ≈ gold)", () => {
    for (const probe of ASSOCIATION_PROBES) {
      expect(probe.anchor.includes(probe.bridge)).toBe(true);
      expect(probe.gold.includes(probe.bridge)).toBe(true);
    }
  });

  it("externalId 関数は assoc-<kind>-<id> / assoc-filler-NNNN の規約に従う", () => {
    expect(associationGoldExternalId("ascii-project")).toBe("assoc-gold-ascii-project");
    expect(associationAnchorExternalId("ascii-project")).toBe("assoc-anchor-ascii-project");
    expect(associationDistractorExternalId("ascii-project")).toBe("assoc-distractor-ascii-project");
    expect(associationHaystackExternalId(0)).toBe("assoc-filler-0000");
    expect(associationHaystackExternalId(12)).toBe("assoc-filler-0012");
  });

  it("buildAssociationProbeSetConversation(): 既定の haystackSize で 12×3 + haystackSize = 98件（Issue #317 で60→62）", () => {
    const utterances = buildAssociationProbeSetConversation();
    expect(ASSOCIATION_HAYSTACK_SIZE).toBe(62);
    expect(utterances).toHaveLength(ASSOCIATION_PROBES.length * 3 + ASSOCIATION_HAYSTACK_SIZE);
    expect(utterances).toHaveLength(98);
  });

  it("buildAssociationProbeSetConversation(4): anchor/gold/distractor の externalId・kind・text が probe と対応する", () => {
    const utterances = buildAssociationProbeSetConversation(4);
    expect(utterances).toHaveLength(ASSOCIATION_PROBES.length * 3 + 4);
    for (const probe of ASSOCIATION_PROBES) {
      const anchor = utterances.find((u) => u.externalId === associationAnchorExternalId(probe.id));
      const gold = utterances.find((u) => u.externalId === associationGoldExternalId(probe.id));
      const distractor = utterances.find(
        (u) => u.externalId === associationDistractorExternalId(probe.id),
      );
      expect(anchor?.text).toBe(probe.anchor);
      expect(anchor?.kind).toBe("anchor");
      expect(anchor?.probeId).toBe(probe.id);
      expect(gold?.text).toBe(probe.gold);
      expect(gold?.kind).toBe("gold");
      expect(distractor?.text).toBe(probe.distractor);
      expect(distractor?.kind).toBe("distractor");
    }
    expect(utterances.some((u) => u.externalId === associationHaystackExternalId(0))).toBe(true);
  });

  describe("findAssociationBridgeViolations(歯1)", () => {
    it("正しい入力(実際の会話)では0件", () => {
      const utterances = buildAssociationProbeSetConversation(4);
      expect(findAssociationBridgeViolations(utterances)).toEqual([]);
    });

    it("bridge を漏らした発話を混ぜると違反を報告する(検査自体が機能することの確認)", () => {
      const utterances = buildAssociationProbeSetConversation(4);
      const leaking: ProbeUtterance = {
        externalId: "leak-test-0001",
        text: "PROJ-1234 の話が別の場所でも出ました。",
        kind: "haystack",
      };
      const violations = findAssociationBridgeViolations([...utterances, leaking]);
      expect(violations.length).toBeGreaterThan(0);
      expect(
        violations.some(
          (v) =>
            v.bridge === "PROJ-1234" &&
            v.probeId === "ascii-project" &&
            v.index === utterances.length,
        ),
      ).toBe(true);
    });
  });

  describe("findAssociationQueryLeakViolations(歯2)", () => {
    it("正しい入力(実際の ASSOCIATION_PROBES/ASSOCIATION_QUERY_KEYWORDS)では0件", () => {
      expect(findAssociationQueryLeakViolations()).toEqual([]);
    });

    it("query の内容語が gold に漏れていれば違反を報告する(検査自体が機能することの確認)", () => {
      const probeId = "ascii-project";
      const probe = ASSOCIATION_PROBES.find((p) => p.id === probeId);
      expect(probe).toBeDefined();
      const leakingKeyword = "顧客名";
      expect(probe!.gold.includes(leakingKeyword)).toBe(true);

      const mutableKeywords = ASSOCIATION_QUERY_KEYWORDS as Record<string, string[]>;
      const original = mutableKeywords[probeId];
      mutableKeywords[probeId] = [...(original ?? []), leakingKeyword];
      try {
        const violations = findAssociationQueryLeakViolations();
        expect(violations).toContainEqual({ probeId, keyword: leakingKeyword, gold: probe!.gold });
      } finally {
        mutableKeywords[probeId] = original as string[];
      }

      expect(findAssociationQueryLeakViolations()).toEqual([]);
    });
  });
});

describe("ASSOCIATION_HAYSTACK(専用 haystack) — なぜ buildHaystackUtterance を使わないか", () => {
  it("62件あり、1件も重複していない（Issue #317 で60→62。条件②の修正で2件足した）", () => {
    expect(ASSOCIATION_HAYSTACK_SIZE).toBe(62);
    expect(ASSOCIATION_HAYSTACK).toHaveLength(62);
    expect(new Set(ASSOCIATION_HAYSTACK).size).toBe(62);
  });

  it("⭐ probe-set.ts のテンプレート生成 haystack を1件も使っていない", () => {
    const templated = new Set(Array.from({ length: 200 }, (_, i) => buildHaystackUtterance(i)));
    for (const text of ASSOCIATION_HAYSTACK) {
      expect(templated.has(text)).toBe(false);
    }
  });

  it("⭐ 会話の haystack は ASSOCIATION_HAYSTACK から来ている(生成器から来ていない)", () => {
    const conversation = buildAssociationProbeSetConversation();
    const haystackTexts = conversation.filter((u) => u.kind === "haystack").map((u) => u.text);
    expect(haystackTexts).toHaveLength(62);
    for (const text of haystackTexts) {
      expect(ASSOCIATION_HAYSTACK).toContain(text);
    }
  });
});
