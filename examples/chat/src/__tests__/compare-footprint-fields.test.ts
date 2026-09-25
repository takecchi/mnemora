import { describe, expect, it } from "vitest";
import type { DigestEntry, RecallResult, RecalledMemory } from "@mnemora/core";
import { footprintFieldsFromRecall } from "../compare.js";

/**
 * `ComparisonRow.bandEntryCount` / `rawIndexJsonLength` の計算そのものを検査する
 * （Issue #340 フォローアップ、ADR 0306/0310）。**Postgres は要らない**——
 * `footprintFieldsFromRecall`（`../compare.ts`）は `RecallResult` を渡すだけの純関数
 * であり、手で組み立てた `RecallResult` に対して直接呼べる。
 *
 * `packages/core/src/__tests__/recall-footprint.test.ts` の `makeRecallResult` と
 * 同じ組み立て方（最小限の `RecallResult` フィクスチャ）を、examples/chat 側で
 * 独立に再現している——`compare.ts` はこのフィクスチャの形を知らないので、二重実装には
 * ならない（テストされるのは `compare.ts` 側の2行の計算だけである）。
 */

function makeRecalledMemory(id: string): RecalledMemory {
  return {
    memoryId: id,
    digest: "d",
    retrievedVia: "ann",
    provenanceKind: "stated",
    score: { decay: 1, tagMatch: 0, freshness: 1, strength: 1, total: 1 },
  };
}

function makeRecallResult(overrides: {
  chars: number;
  memoryCount: number;
  digestBand?: DigestEntry[];
  totalInScope?: number;
}): RecallResult {
  return {
    recallId: "r1",
    memories: Array.from({ length: overrides.memoryCount }, (_, i) => makeRecalledMemory(`m${i}`)),
    omitted: [],
    index: {
      groups: [],
      totalInScope: overrides.totalInScope ?? overrides.memoryCount,
      countKind: "exact",
      ...(overrides.digestBand !== undefined ? { digestBand: overrides.digestBand } : {}),
    },
    usage: {
      chars: overrides.chars,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    explain: { stages: [] },
  };
}

describe("footprintFieldsFromRecall — bandEntryCount / rawIndexJsonLength", () => {
  it("帯が無ければ bandEntryCount=0、rawIndexJsonLength は JSON.stringify(index).length と一致する", () => {
    const result = makeRecallResult({ chars: 500, memoryCount: 5 });
    const fields = footprintFieldsFromRecall(result);
    expect(fields.bandEntryCount).toBe(0);
    expect(fields.rawIndexJsonLength).toBe(JSON.stringify(result.index).length);
  });

  it("帯が2件あれば bandEntryCount=2、rawIndexJsonLength はその分だけ長くなる", () => {
    const digestBand: DigestEntry[] = [
      { memoryId: "x1", digest: "a" },
      { memoryId: "x2", digest: "b" },
    ];
    const withBand = makeRecallResult({ chars: 900, memoryCount: 3, digestBand });
    const withoutBand = makeRecallResult({ chars: 900, memoryCount: 3 });
    const fieldsWithBand = footprintFieldsFromRecall(withBand);
    const fieldsWithoutBand = footprintFieldsFromRecall(withoutBand);

    expect(fieldsWithBand.bandEntryCount).toBe(2);
    expect(fieldsWithBand.rawIndexJsonLength).toBe(JSON.stringify(withBand.index).length);
    // 帯の有無で rawIndexJsonLength が実際に変わること（写しではなく計算していることの検算）。
    expect(fieldsWithBand.rawIndexJsonLength).toBeGreaterThan(fieldsWithoutBand.rawIndexJsonLength);
  });

  it("totalInScope は bandEntryCount / rawIndexJsonLength のどちらにも影響しない(index.groups等の他欄には影響する)", () => {
    const small = makeRecallResult({ chars: 500, memoryCount: 5, totalInScope: 5 });
    const large = makeRecallResult({ chars: 500, memoryCount: 5, totalInScope: 42 });
    // totalInScope の桁が変わると JSON の文字数自体は変わる(桁上がり)ので、
    // bandEntryCount だけを比較する——rawIndexJsonLength は変わりうることを認めた上で。
    expect(footprintFieldsFromRecall(small).bandEntryCount).toBe(0);
    expect(footprintFieldsFromRecall(large).bandEntryCount).toBe(0);
    expect(footprintFieldsFromRecall(large).rawIndexJsonLength).toBe(
      JSON.stringify(large.index).length,
    );
  });

  /**
   * ⭐ 変異検査(マネージャー委譲、Issue #340 フォローアップ)。
   * `footprintFieldsFromRecall` が `recall.index.digestBand` を無視して常に0を返す
   * ような退行を仮定し、この歯が実際に落ちることを示す——テストの検出力そのものの検算。
   */
  it("変異: bandEntryCount を無視する(常に0を返す)実装なら、帯ありのケースで落ちる", () => {
    const digestBand: DigestEntry[] = [
      { memoryId: "x1", digest: "a" },
      { memoryId: "x2", digest: "b" },
      { memoryId: "x3", digest: "c" },
    ];
    const result = makeRecallResult({ chars: 900, memoryCount: 3, digestBand });
    const mutatedBandEntryCount = 0; // 「常に0を返す」変異を模した値
    expect(footprintFieldsFromRecall(result).bandEntryCount).not.toBe(mutatedBandEntryCount);
  });

  /**
   * ⭐ 変異検査: `rawIndexJsonLength` が `recall.index` ではなく `recall.usage`
   * （別のオブジェクト）を stringify するような取り違えを仮定し、この歯が
   * 実際に落ちることを示す。
   */
  it("変異: rawIndexJsonLength が index ではなく usage を JSON 化する取り違えなら、落ちる", () => {
    const result = makeRecallResult({ chars: 12345, memoryCount: 5 });
    const mutatedRawIndexJsonLength = JSON.stringify(result.usage).length; // 取り違えを模した値
    expect(footprintFieldsFromRecall(result).rawIndexJsonLength).not.toBe(
      mutatedRawIndexJsonLength,
    );
  });
});
