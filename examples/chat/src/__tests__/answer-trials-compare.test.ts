import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnswerTrialsResult } from "../answer-trials.js";
import {
  compareAnswerTrials,
  formatCompareMismatchReport,
  formatCompareTable,
  runAnswerTrialsCompareFromFiles,
} from "../answer-trials-compare.js";

/**
 * `answer-trials-compare.ts` の単体試験。**DB 不要・鍵不要。**
 *
 * Issue #705 完了条件2「対照の材料の記憶集合が、比べたい記録と同じであることを、器が
 * 確かめて表示する」——ADR 0295 追記2 の見落とし（別の記憶集合を比べて『退行は消えた』と
 * 誤判定した）の再発防止そのものを検査する。
 */

function baseResult(overrides: Partial<AnswerTrialsResult> = {}): AnswerTrialsResult {
  const base = {
    measuredAt: "2026-09-25T00:00:00.000Z",
    model: "gpt-4o-mini",
    n: 5,
    renders: ["recorded", "digest-only"] as const,
    cassettePath: "/x/answer.json",
    cassetteSha256: "sha-a",
    cassetteRecordedAt: "2026-09-24T20:59:18.736Z",
    caseMaterials: [
      {
        caseId: "pref-tea-over-coffee",
        fingerprint: "fp-1",
        renders: [
          { renderName: "recorded" as const, systemChars: 10, userContentChars: 100 },
          { renderName: "digest-only" as const, systemChars: 10, userContentChars: 50 },
        ],
      },
    ],
  };
  return {
    ...base,
    evaluated: true,
    temperature: "provider既定（未指定）",
    caseResults: [
      {
        caseId: "pref-tea-over-coffee",
        renders: [
          { renderName: "recorded", n: 5, passCount: 5, failCount: 0, indeterminateCount: 0 },
          { renderName: "digest-only", n: 5, passCount: 4, failCount: 1, indeterminateCount: 0 },
        ],
      },
    ],
    usage: { chatCalls: 10, promptTokens: 100, completionTokens: 20 },
    costUsd: { inputUsd: 0.001, outputUsd: 0.0002, totalUsd: 0.0012 },
    ...overrides,
  } as AnswerTrialsResult;
}

describe("compareAnswerTrials", () => {
  it("同じカセット・同じ指紋なら ok:true", () => {
    const a = baseResult();
    const b = baseResult();
    const compare = compareAnswerTrials([
      { label: "run-a", result: a },
      { label: "run-b", result: b },
    ]);
    expect(compare.ok).toBe(true);
    expect(compare.cassetteMismatch).toBe(false);
    expect(compare.fingerprintMismatches).toHaveLength(0);
  });

  it("カセットの sha256 が違えば ok:false(ADR 0295 追記2 の見落としの再発防止)", () => {
    const a = baseResult({ cassetteSha256: "sha-a" });
    const b = baseResult({ cassetteSha256: "sha-b" });
    const compare = compareAnswerTrials([
      { label: "run-a", result: a },
      { label: "run-b", result: b },
    ]);
    expect(compare.ok).toBe(false);
    expect(compare.cassetteMismatch).toBe(true);
  });

  it("同じカセットでもケースの材料指紋が違えば ok:false", () => {
    const a = baseResult();
    const b = baseResult({
      caseMaterials: [
        {
          caseId: "pref-tea-over-coffee",
          fingerprint: "fp-DIFFERENT",
          renders: a.caseMaterials[0]?.renders ?? [],
        },
      ],
    });
    const compare = compareAnswerTrials([
      { label: "run-a", result: a },
      { label: "run-b", result: b },
    ]);
    expect(compare.ok).toBe(false);
    expect(compare.cassetteMismatch).toBe(false);
    expect(compare.fingerprintMismatches).toHaveLength(1);
    expect(compare.fingerprintMismatches[0]?.caseId).toBe("pref-tea-over-coffee");
  });

  it("入力が1件以下なら例外", () => {
    expect(() => compareAnswerTrials([{ label: "only-one", result: baseResult() }])).toThrow();
  });

  it("ラベルが重複していれば例外", () => {
    expect(() =>
      compareAnswerTrials([
        { label: "dup", result: baseResult() },
        { label: "dup", result: baseResult() },
      ]),
    ).toThrow();
  });

  it("formatCompareMismatchReport はずれた箇所(どのラベルがどの値か)を具体的に示す", () => {
    const a = baseResult({ cassetteSha256: "sha-a" });
    const b = baseResult({ cassetteSha256: "sha-b" });
    const compare = compareAnswerTrials([
      { label: "run-a", result: a },
      { label: "run-b", result: b },
    ]);
    const report = formatCompareMismatchReport(compare);
    expect(report).toContain("run-a");
    expect(report).toContain("run-b");
    expect(report).toContain("sha-a");
    expect(report).toContain("sha-b");
  });

  it("formatCompareTable は一致時にラベルごとの pass/fail を並べる", () => {
    const a = baseResult();
    const b = baseResult({
      caseResults: [
        {
          caseId: "pref-tea-over-coffee",
          renders: [
            { renderName: "recorded", n: 5, passCount: 3, failCount: 2, indeterminateCount: 0 },
            { renderName: "digest-only", n: 5, passCount: 5, failCount: 0, indeterminateCount: 0 },
          ],
        },
      ],
    });
    const table = formatCompareTable([
      { label: "run-a", result: a },
      { label: "run-b", result: b },
    ]);
    expect(table).toContain("run-a");
    expect(table).toContain("run-b");
    expect(table).toContain("pass=5/fail=0");
    expect(table).toContain("pass=3/fail=2");
  });
});

describe("runAnswerTrialsCompareFromFiles(ファイル経由、変異試験(b)の対象)", () => {
  function writeJson(dir: string, name: string, value: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value), "utf8");
    return path;
  }

  it("2件のJSONが一致すれば ok:true", () => {
    const dir = mkdtempSync(join(tmpdir(), "answer-trials-compare-test-"));
    try {
      const p1 = writeJson(dir, "a.json", baseResult());
      const p2 = writeJson(dir, "b.json", baseResult());
      const { ok, report } = runAnswerTrialsCompareFromFiles([p1, p2]);
      expect(ok).toBe(true);
      expect(report).toContain("✅");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("カセットのsha256が違う2件は ok:false(exit 1に相当)——比較が指紋を見ずに通してしまう変異が入るとここが緑のままになる", () => {
    const dir = mkdtempSync(join(tmpdir(), "answer-trials-compare-test-"));
    try {
      const p1 = writeJson(dir, "a.json", baseResult({ cassetteSha256: "sha-a" }));
      const p2 = writeJson(dir, "b.json", baseResult({ cassetteSha256: "sha-b" }));
      const { ok, report } = runAnswerTrialsCompareFromFiles([p1, p2]);
      expect(ok).toBe(false);
      expect(report).toContain("⛔");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("パスが1件以下なら例外", () => {
    expect(() => runAnswerTrialsCompareFromFiles(["/only/one.json"])).toThrow();
  });
});
