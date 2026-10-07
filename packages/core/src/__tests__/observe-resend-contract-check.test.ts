import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { ObserveResult } from "../runtime.js";
import { checkObserveContract } from "./runtime-return-contract.js";

const ctx: Ctx = { tenantId: "t" };
const utterance = { kind: "utterance" as const, text: "u" };
const base: ObserveResult = {
  observationId: "obs-1",
  memoryIds: [],
  extraction: "skipped",
  extractionFailure: null,
};
const resendOf = (...ids: string[]): ObserveResult => ({
  ...base,
  resend: { memories: ids.map((memoryId) => ({ memoryId, status: "active", purged: false })) },
});

describe("checkObserveContract: resend（ADR 0639）", () => {
  it("正しい再送・正しい新規は破れ無し", () => {
    const seen = new Set<string>();
    expect(checkObserveContract([ctx, utterance], base, seen)).toEqual([]);
    expect(checkObserveContract([ctx, utterance], resendOf("a", "b"), seen)).toEqual([]);
    expect(checkObserveContract([ctx, utterance], resendOf(), seen)).toEqual([]);
  });

  it("同じ Observation をもう一度返したのに resend が無いと破れ", () => {
    const seen = new Set<string>();
    expect(checkObserveContract([ctx, utterance], base, seen)).toEqual([]);
    expect(checkObserveContract([ctx, utterance], base, seen)).toHaveLength(1);
  });

  it("別テナントの同じ id は再送とみなさない", () => {
    const seen = new Set<string>();
    checkObserveContract([ctx, utterance], base, seen);
    expect(checkObserveContract([{ tenantId: "u" }, utterance], base, seen)).toEqual([]);
  });

  it("抽出が走った（extraction が skipped でない）呼び出しに resend が付くと破れ", () => {
    const result: ObserveResult = { ...resendOf("a"), extraction: "ok" };
    expect(checkObserveContract([ctx, utterance], result)).not.toEqual([]);
  });

  it("memoryIds が空でない再送は破れ", () => {
    const result: ObserveResult = { ...resendOf("a"), memoryIds: ["a"] };
    expect(checkObserveContract([ctx, utterance], result)).not.toEqual([]);
  });

  it("memory_usage に resend が付くと破れ", () => {
    const usage = { kind: "memory_usage" as const, memoryIds: ["a"] } as never;
    expect(checkObserveContract([ctx, usage], resendOf())).not.toEqual([]);
  });

  it("memories が昇順でない・重複があると破れ", () => {
    expect(checkObserveContract([ctx, utterance], resendOf("b", "a"))).not.toEqual([]);
    expect(checkObserveContract([ctx, utterance], resendOf("a", "a"))).not.toEqual([]);
  });

  it("purged が真偽値でないと破れ", () => {
    const result: ObserveResult = {
      ...base,
      resend: { memories: [{ memoryId: "a", status: "active", purged: undefined as never }] },
    };
    expect(checkObserveContract([ctx, utterance], result)).not.toEqual([]);
  });
});
