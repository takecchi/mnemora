/**
 * 歯: markdown リンクを表示文字だけにする置換の、唯一の定義（Issue #646）。
 * 3つの呼び手（`delink` / `stripMarkdownDecoration` / `normalizeForAdrDecisionReferences`）が
 * すべてこの定義を使う。⟹ ここで固定した振る舞いが、3つともに効く。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { delinkMarkdown, matchMarkdownLinkAt } from "../markdown-link-lib.mjs";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("delinkMarkdown", () => {
  it("リンクを表示文字だけにする（url は落とす）", () => {
    expect(delinkMarkdown("— [ADR 0178](./docs/decisions/0178-x.md) が反例")).toBe(
      "— ADR 0178 が反例",
    );
  });

  it("1つの文字列の中の複数のリンクを、すべて外す", () => {
    expect(delinkMarkdown("[a](u) と [b](v)")).toBe("a と b");
  });

  it("リンクでない角括弧・丸括弧は残す", () => {
    expect(delinkMarkdown("[a] (u) と [b]")).toBe("[a] (u) と [b]");
  });

  describe("🔴 改行を含むリンクは外さない（CommonMark と違う。理由は markdown-link-lib.mjs の冒頭 doc）", () => {
    it("表示文字が改行をまたぐリンクは外さない", () => {
      expect(delinkMarkdown("[ADR\n0200](./0200-x.md)")).toBe("[ADR\n0200](./0200-x.md)");
    });

    it("url が改行をまたぐリンクは外さない", () => {
      expect(delinkMarkdown("[ADR 0106](../docs/decisions/\n0106-x.md)")).toBe(
        "[ADR 0106](../docs/decisions/\n0106-x.md)",
      );
    });

    it("⭐ 陽性対照: JS の配列リテラルの `[` から、数行先の本物のリンクまでを1つの偽リンクにしない", () => {
      // 改行を許すと、配列の `[` から `[ADR 0078]` の `](` までが表示文字の顔をして丸ごと当たる
      // （Issue #646 の決め手。改行を許した形では、実在のコードでこの偽リンクが11件出た）。
      const code = [
        "expect(hits).toEqual([",
        "  {",
        '    raw: "[ADR 0078](./0078-strength-value-range.md)",',
        "  },",
        "]);",
      ].join("\n");
      expect(delinkMarkdown(code)).toBe(
        code.replace("[ADR 0078](./0078-strength-value-range.md)", "ADR 0078"),
      );
    });

    it("⚠ 1行に収まる `[a, b](x)` は、コードの中でもリンクとして外す（形では区別できない）", () => {
      expect(delinkMarkdown("f([a, b](x))")).toBe("f(a, b)");
    });
  });

  it("画像 `![alt](src)` は `!alt` になる（`!` は残す）", () => {
    expect(delinkMarkdown("![図1](./fig.png) を見よ")).toBe("!図1 を見よ");
  });

  it("入れ子の角括弧 `[a [b]](u)` は外さない（表示文字は最初の `]` で止まる）", () => {
    expect(delinkMarkdown("[a [b]](u)")).toBe("[a [b]](u)");
  });

  it("空の表示文字 `[](u)` は空文字になる", () => {
    expect(delinkMarkdown("x[](u)y")).toBe("xy");
  });
});

describe("matchMarkdownLinkAt", () => {
  it("その位置から始まるリンクだけを当てる", () => {
    const text = "見よ [ADR 0178](./0178-x.md) を";
    const at = text.indexOf("[");
    expect(matchMarkdownLinkAt(text, at)).toEqual({
      display: "ADR 0178",
      url: "./0178-x.md",
      length: "[ADR 0178](./0178-x.md)".length,
    });
  });

  it("その位置がリンクの始まりでなければ null（先へ探しにいかない）", () => {
    expect(matchMarkdownLinkAt("見よ [a](u)", 0)).toBeNull();
  });

  it("delinkMarkdown と同じ形を当てる（改行をまたぐリンクは当てない）", () => {
    expect(matchMarkdownLinkAt("[ADR\n0200](u)", 0)).toBeNull();
    expect(matchMarkdownLinkAt("[a](u\nv)", 0)).toBeNull();
  });

  it("続けて呼んでも前の呼び出しの位置を引きずらない", () => {
    const text = "[a](u)[b](v)";
    expect(matchMarkdownLinkAt(text, 6)?.display).toBe("b");
    expect(matchMarkdownLinkAt(text, 0)?.display).toBe("a");
  });
});

describe("⛔ 定義を1つに保つ —— リンクを外す正規表現を、ほかのファイルに書き戻さない", () => {
  it("3つの呼び手のファイルに、リンクを外す形の正規表現が無い", () => {
    // リンクを「外す」形（表示文字をグループで取る `\[([^\]`）だけを見る。
    // `MD_LINK_COLON_RE` のように、リンクを「拾う」ための形（`\[ADR…\]\(`）は対象外。
    for (const file of ["adr-citation-lib.mjs", "agents-md-quote-attribution-lib.mjs"]) {
      const text = readFileSync(path.join(SCRIPTS, file), "utf8");
      expect(text.includes(String.raw`\[([^\]`), file).toBe(false);
    }
  });
});
