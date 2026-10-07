import { describe, expect, it } from "vitest";
import { normalizeClaimKeyPart } from "../claim-key.js";

/**
 * `normalizeClaimKeyPart` のべき等は、今は破れている入力がある（「大文字 + 結合文字」の一部）。直さないのは、小文字化のあとにもう一度 NFKC をかけると、
 * 保存済みの鍵（分解形）と新しく作る鍵（合成形）が食い違い、contested の検出が同じ主張と見なさなくなるため（ADR 0474）。
 * この歯は「今は破れている」ことを記録する `it.fails` である。実装が直って赤になったら、ADR 0474 と保存済みの鍵の扱いを読み直してから、普通の `it` に替えること。
 *
 * 下の表は総当たり（`\p{Lu}`・`\p{Lt}` の全コードポイント × U+0300〜U+036F の結合文字 1 つ）で見つかった組の代表。
 */

const BROKEN: ReadonlyArray<readonly [name: string, input: string]> = [
  ["ギリシャ Α + U+0342", "Α͂"],
  ["ギリシャ Ι + U+0342", "Ι͂"],
  ["ギリシャ Η + U+0342", "Η͂"],
  ["ギリシャ Ω + U+0342", "Ω͂"],
  ["ギリシャ Υ + U+0342", "Υ͂"],
  ["ギリシャ Υ + U+0313", "Υ̓"],
  ["ギリシャ Υ + U+0343", "Υ̓"],
  ["ギリシャ Ϊ + U+0301", "Ϊ́"],
  ["ギリシャ Ϋ + U+0301", "Ϋ́"],
  ["ラテン H + U+0331", "H̱"],
  ["ラテン J + U+030C", "J̌"],
  ["ラテン T + U+0308", "T̈"],
  ["ラテン W + U+030A", "W̊"],
  ["ラテン Y + U+030A", "Y̊"],
  ["ラテン İ + U+0316", "İ̖"],
];

describe("normalizeClaimKeyPart のべき等の例外（今は破れている。ADR 0474）", () => {
  it.each(BROKEN)("【破れている】%s", { fails: true }, (_name, input) => {
    const once = normalizeClaimKeyPart(input);
    expect(normalizeClaimKeyPart(once)).toBe(once);
  });

  it.each(BROKEN)(
    "%s は、2回目で合成形に替わる（1回目の出力は NFKC の不動点でない）",
    (_name, input) => {
      const once = normalizeClaimKeyPart(input);
      expect(once.normalize("NFKC")).not.toBe(once);
      expect(normalizeClaimKeyPart(once)).toBe(once.normalize("NFKC"));
    },
  );

  it("陽性対照: 結合文字を伴わない入力・合成済みの入力・小文字の入力は、べき等が成り立つ", () => {
    for (const input of [
      "Α",
      "ᾶ",
      "Η",
      "H",
      "J",
      "T",
      "W",
      "Y",
      "İ",
      "ẖ",
      "ΑΣ Β",
      " Ａ　B\tc ",
      "ǅ",
    ]) {
      const once = normalizeClaimKeyPart(input);
      expect(normalizeClaimKeyPart(once)).toBe(once);
    }
  });

  it("陽性対照: 既存の規則（NFKC → 前後の空白除去 → 小文字化 → 内部の空白を _）は変わらない", () => {
    expect(normalizeClaimKeyPart(" Ａ　B\tc ")).toBe("a_b_c");
    expect(normalizeClaimKeyPart("İ")).toBe("i̇");
    expect(normalizeClaimKeyPart("ǅ")).toBe("dž");
    expect(normalizeClaimKeyPart("ΑΣ Β")).toBe("ας_β");
  });
});
