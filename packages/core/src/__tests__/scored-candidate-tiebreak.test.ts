import { describe, expect, it } from "vitest";
import { compareScoredCandidates } from "../recall-runtime.js";
import type { ScoreBreakdown } from "../recall.js";

/**
 * `Array.prototype.sort` は安定なので、`score.total` が同点のとき明示のタイブレークが無ければ入力配列の順序（= adapter が返した順序）が
 * そのまま残り、`memory_id`（ingest のたびに振り直されるランダムな UUID）に依存する並びが `recall()` の結果を変えてしまう。
 * `ScoredCandidate` の最小の作り方は `threshold-partition.test.ts` の `candidate()` と同じ作法（型は export していないので
 * `as unknown as Parameters<...>[0]` で組み立てる）。
 */

function candidate(
  id: string,
  total: number,
  opts: { occurredAt?: Date | null; recordedAt: Date },
): Parameters<typeof compareScoredCandidates>[0] {
  const score: ScoreBreakdown = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total };
  return {
    memory: {
      id,
      occurredAt: opts.occurredAt ?? null,
      recordedAt: opts.recordedAt,
    },
    retrievedVia: "ann",
    score,
  } as unknown as Parameters<typeof compareScoredCandidates>[0];
}

describe("compareScoredCandidates（Issue #339 / ADR 0170）", () => {
  it("score.total が違えば、それだけで決まる（高い方が先）", () => {
    const higher = candidate("higher", 0.9, { recordedAt: new Date("2026-01-01T00:00:00Z") });
    const lower = candidate("lower", 0.1, { recordedAt: new Date("2026-01-02T00:00:00Z") });
    expect(compareScoredCandidates(higher, lower)).toBeLessThan(0);
    expect(compareScoredCandidates(lower, higher)).toBeGreaterThan(0);
  });

  it("score.total が同点なら、実効時刻（occurredAt ?? recordedAt）が新しい方を先にする", () => {
    const older = candidate("older", 0.5, { recordedAt: new Date("2026-01-01T00:00:00Z") });
    const newer = candidate("newer", 0.5, { recordedAt: new Date("2026-01-02T00:00:00Z") });
    expect(compareScoredCandidates(older, newer)).toBeGreaterThan(0);
    expect(compareScoredCandidates(newer, older)).toBeLessThan(0);
    const sorted = [older, newer].sort(compareScoredCandidates);
    expect(sorted.map((c) => c.memory.id)).toEqual(["newer", "older"]);
    const sortedReverseInput = [newer, older].sort(compareScoredCandidates);
    expect(sortedReverseInput.map((c) => c.memory.id)).toEqual(["newer", "older"]);
  });

  it("occurredAt が在ればそちらを実効時刻として使う（recordedAt は無視する）", () => {
    const a = candidate("a-id", 0.5, {
      occurredAt: new Date("2020-06-01T00:00:00Z"),
      recordedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const b = candidate("b-id", 0.5, {
      occurredAt: new Date("2020-06-01T00:00:00Z"),
      recordedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const sorted = [b, a].sort(compareScoredCandidates);
    expect(sorted.map((c) => c.memory.id)).toEqual(["a-id", "b-id"]);
  });

  it("score.total も実効時刻も同点なら、memory.id の昇順にフォールバックする（最終手段）", () => {
    const sameTime = new Date("2026-01-01T00:00:00Z");
    const z = candidate("zzz", 0.5, { recordedAt: sameTime });
    const a = candidate("aaa", 0.5, { recordedAt: sameTime });
    const sorted = [z, a].sort(compareScoredCandidates);
    expect(sorted.map((c) => c.memory.id)).toEqual(["aaa", "zzz"]);
  });

  it("score.total の差がごく小さくても（1e-12）同点とみなさず、total の高い方を先にする", () => {
    // 実効時刻と id は、どちらも total の低い方を先にする向きに置く（同点扱いに落ちれば順が逆になる）。
    const higher = candidate("zzz-higher", 0.5 + 1e-12, {
      recordedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const lower = candidate("aaa-lower", 0.5, { recordedAt: new Date("2026-01-02T00:00:00Z") });
    expect(compareScoredCandidates(higher, lower)).toBeLessThan(0);
    expect(compareScoredCandidates(lower, higher)).toBeGreaterThan(0);
  });
});
