import { describe, expect, it } from "vitest";
import { normalizeWorkflowExpressions } from "../workflow-expression-lib.mjs";

describe("normalizeWorkflowExpressions(照合専用の網そのもの)", () => {
  const CANONICAL = "lexical-regime-${{ matrix.serverEncoding }}";

  const EQUIVALENT = [
    "lexical-regime-${{ matrix.serverEncoding }}",
    "lexical-regime-${{matrix.serverEncoding}}",
    "lexical-regime-${{  matrix.serverEncoding  }}",
    "lexical-regime-${{\tmatrix.serverEncoding\t}}",
    "lexical-regime-${{ format('{0}', matrix.serverEncoding) }}",
    "lexical-regime-${{format('{0}',matrix.serverEncoding)}}",
    "lexical-regime-${{ format('{0}', format('{0}', matrix.serverEncoding)) }}",
  ];

  const BREAKING = [
    "lexical-regime-UTF8",
    "lexical-regime-${{ matrix.initdbArgs }}",
    "lexical-regime-${{ matrix.serverencoding }}",
    "lexical-regime",
    "lexical-regime-${{ format('{0}-{1}', matrix.serverEncoding, matrix.initdbArgs) }}",
    "lexical-regime-${{ format('x{0}', matrix.serverEncoding) }}",
  ];

  it.each(EQUIVALENT)("⭐ 同値な書き換えは正規形へ揃う: %s", (variant) => {
    const { text, unhandled } = normalizeWorkflowExpressions(variant);
    expect(unhandled).toEqual([]);
    expect(text).toContain(CANONICAL);
  });

  it.each(BREAKING)("🔴 依存が消える/値が変わる書き換えは正規形にならない: %s", (variant) => {
    const { text } = normalizeWorkflowExpressions(variant);
    expect(text).not.toContain(CANONICAL);
  });

  it("⛔ `${{ … }}` の外側は1バイトも変えない(インデント・改行・引用符)", () => {
    const source = '        with:\n          name: "a  b"   # 空白2つ\n          x: 1\n';
    expect(normalizeWorkflowExpressions(source).text).toBe(source);
  });

  it("⛔ 単一引用符の文字列の中の空白は詰めない(値が変わるため)", () => {
    const { text } = normalizeWorkflowExpressions("${{ format('a  b{0}',  x) }}");
    expect(text).toBe("${{ format('a  b{0}', x) }}");
  });

  it("⭐ 引用符の中に `}}` が在っても式の終わりと取り違えない", () => {
    const { text, unhandled } = normalizeWorkflowExpressions("${{ format('{0}}}', x) }}-tail");
    expect(unhandled).toEqual([]);
    expect(text).toBe("${{ format('{0}}}', x) }}-tail");
  });

  it("🔴 `${{` に対応する `}}` が無ければ unhandled に名乗り、テキストは変えない", () => {
    const { text, unhandled } = normalizeWorkflowExpressions("name: x-${{ matrix.y");
    expect(text).toBe("name: x-${{ matrix.y");
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]).toContain("${{ matrix.y");
  });

  it("🔴 引用符が閉じていなければ unhandled に名乗り、その式は変えない", () => {
    const { text, unhandled } = normalizeWorkflowExpressions("${{ format('{0}, x) }}");
    expect(text).toBe("${{ format('{0}, x) }}");
    expect(unhandled).toHaveLength(1);
  });

  it("⭐ 1行に複数の式が在っても、それぞれ独立に正規化する", () => {
    const { text, unhandled } = normalizeWorkflowExpressions(
      "${{github.workspace}}/a-${{ format('{0}', matrix.serverEncoding) }}",
    );
    expect(unhandled).toEqual([]);
    expect(text).toBe("${{ github.workspace }}/a-${{ matrix.serverEncoding }}");
  });

  it("⭐ 式が1つも無いテキストは恒等(この網が無関係な行を壊していないこと)", () => {
    const source = "          if-no-files-found: ignore\n";
    expect(normalizeWorkflowExpressions(source)).toEqual({ text: source, unhandled: [] });
  });
});
