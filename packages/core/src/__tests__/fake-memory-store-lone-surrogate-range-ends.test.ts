import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** ソースにサロゲートは `\u` の表記で書く（生の文字を入れない）。 */

const ctx: Ctx = { tenantId: "fake-lone-surrogate-range-ends" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

// 既存の置き換えの試験は U+D800・U+D83D・U+DC00 しか使っておらず、範囲の終わり側の端を縛っていない。
const LONE_AT_RANGE_ENDS: ReadonlyArray<readonly [label: string, input: string, expected: string]> =
  [
    ["上位サロゲートの終点 U+DBFF（後ろに文字）", "a\uDBFFb", "a\uFFFDb"],
    ["上位サロゲートの終点 U+DBFF（末尾）", "ab\uDBFF", "ab\uFFFD"],
    ["下位サロゲートの終点 U+DFFF（前に文字）", "a\uDFFFb", "a\uFFFDb"],
    ["下位サロゲートの終点 U+DFFF（先頭）", "\uDFFFab", "\uFFFDab"],
    ["逆順に並んだ端（U+DFFF・U+DBFF）", "x\uDFFF\uDBFFy", "x\uFFFD\uFFFDy"],
  ];

const PAIRS_AT_RANGE_ENDS: ReadonlyArray<readonly [label: string, value: string]> = [
  ["U+D800 U+DFFF（U+103FF）", "p-\uD800\uDFFF-p"],
  ["U+DBFF U+DC00（U+10FC00）", "p-\uDBFF\uDC00-p"],
  ["U+DBFF U+DFFF（U+10FFFF）", "p-\uDBFF\uDFFF-p"],
];

let counter = 0;
function newMemory(value: string): NewMemory {
  counter += 1;
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: value,
    contentHash: `range-ends-${counter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [value],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "ready",
  };
}

describe("core の Fake（FakeMemoryStore）: サロゲートの範囲の端でも、孤立したものだけが1単位ずつ U+FFFD に置き換わる", () => {
  it.each(LONE_AT_RANGE_ENDS)("孤立: %s", async (_label, input, expected) => {
    const { memoryStore } = createFakeRuntimeStores();
    const m = await memoryStore.createMemory(ctx, newMemory(input));
    expect(m.content).toBe(expected);
    expect(m.tags).toEqual([expected]);
    const got = await memoryStore.get(ctx, m.id);
    expect(got?.content).toBe(expected);
    expect(got?.tags).toEqual([expected]);
  });

  it.each(PAIRS_AT_RANGE_ENDS)("対をなす端は変わらない: %s", async (_label, value) => {
    const { memoryStore } = createFakeRuntimeStores();
    const m = await memoryStore.createMemory(ctx, newMemory(value));
    expect(m.content).toBe(value);
    expect(m.tags).toEqual([value]);
    const got = await memoryStore.get(ctx, m.id);
    expect(got?.content).toBe(value);
    expect(got?.tags).toEqual([value]);
  });
});
