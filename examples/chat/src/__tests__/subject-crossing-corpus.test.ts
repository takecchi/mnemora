import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildUtterances, type CorpusPole } from "../subject-crossing-measure.js";

/**
 * Issue #1024: `subject-crossing-measure`（ADR 0310）のコーパスの歯。
 *
 * disjoint 極は subject k に話題 `k mod 10` だけを話させる。以前は1つの話題の本文が
 * テンプレート4 × filler 12 = 48通りしかなく、1 subject あたり48件を超えると本文まで同一の
 * 発話を繰り返していた（N=100 で52%）。ADR 0310 の表は N=100 まで測るので、
 * 1 subject の中で N=100 まで本文が重複しないことを要求する。
 */

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("subject-crossing のコーパス（Issue #1024）", () => {
  for (const pole of ["disjoint", "shared"] as CorpusPole[]) {
    for (const s of [2, 5, 10]) {
      it(`${pole} S=${s} N=100: 1 subject の中で本文が100件とも異なる`, () => {
        const bySubject = new Map<string, string[]>();
        for (const u of buildUtterances({ s, n: 100, pole })) {
          const texts = bySubject.get(u.subjectId) ?? [];
          texts.push(u.text);
          bySubject.set(u.subjectId, texts);
        }
        expect(bySubject.size).toBe(s);
        for (const texts of bySubject.values()) {
          expect(new Set(texts).size).toBe(100);
        }
      });
    }
  }

  /**
   * 🔴 重複の無かった行（disjoint の N ≤ 48、shared の N ≤ 100）は、ADR 0310 が測った
   * コーパスそのままでなければならない——表のそれらの行は測り直していないため。
   * 生成は前から順に作る（subject も発話も）ので、disjoint S=10 N=48 と shared S=10 N=100 の
   * 2つが、それより小さい全ての行を含む。値は main 8a5c9a0（修正前）の生成物の sha256。
   */
  it("重複の無かった行のコーパスは変わらない（disjoint S=10 N=48・shared S=10 N=100）", () => {
    expect(sha256(buildUtterances({ s: 10, n: 48, pole: "disjoint" }))).toBe(
      "34752d0b9e2ebcc44cd75ccc4d6869ff9662ad40e98240306b460f7f4b7023ac",
    );
    expect(sha256(buildUtterances({ s: 10, n: 100, pole: "shared" }))).toBe(
      "38324f779d5be828afb004e627e27edee779a54a4a74627a44afbc9c28e68a67",
    );
  });
});
