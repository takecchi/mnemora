import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Issue #1040: node-postgres（`pg`）は `Date` のパラメータを**プロセスのローカル時刻**の
 * 文字列にし、時差を分に切り捨てて送る。プロセスの TZ が Asia/Tokyo のとき、1888年より前の
 * 日時は59秒ずれて保存されていた。直し方は「`Date` を `pg` に渡さず、必ず
 * `toPgTimestamp`（`mapping.ts`）を通す」であり、76か所を直した（PR #1052）。
 *
 * この歯は、生の `Date` が SQL に戻ってくるのを止める。`src/`（`__tests__` を除く）を
 * TypeScript の型検査器にかけ、次の位置に**型が `Date` を含む式**が1つも無いことを確かめる。
 *
 * - タグ付きテンプレート（`` sql`...${x}...` ``）の埋め込み式
 * - `sql.param(...)` / `.query(...)` / `.execute(...)` の引数（タグ付きテンプレートそのものを除く）
 *
 * 「`Date` を含む」は、`Date` そのもの・`Date` を含む union / intersection・`Date` の
 * 配列 / tuple・制約が `Date` の型引数である。
 *
 * ⚠ **捕まらないもの**:
 * - **型が `any` の式**。`any` を経由して `Date` が入ると（`as any`・型の無い行の値・
 *   `JSON.parse` の結果など）、この歯は何も言わない。型が `unknown` の式も同じである。
 * - `Date` をプロパティに持つオブジェクト（`{ at: Date }` をそのまま渡す）。
 * - 上の位置以外から `pg` に届く値（例: 自前の関数で包んでから `pool.query` に渡す）。
 *   ただし `.query` / `.execute` の引数としては、上の規則で見る。
 * - 実行時の値。これは静的な検査であり、DB の往復は `timestamp-write-process-tz.postgres.test.ts`
 *   が見る。
 */

const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = path.join(PACKAGE_DIR, "src") + path.sep;
const TESTS_DIR = path.join(SRC_DIR, "__tests__") + path.sep;

interface RawDateSite {
  file: string;
  line: number;
  where: string;
  text: string;
  type: string;
}

interface ScanResult {
  scannedFiles: string[];
  checkedExpressions: number;
  sites: RawDateSite[];
}

function containsDate(checker: ts.TypeChecker, program: ts.Program, type: ts.Type): boolean {
  if (type.isUnion() || type.isIntersection()) {
    return type.types.some((t) => containsDate(checker, program, t));
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint !== undefined && constraint !== type
      ? containsDate(checker, program, constraint)
      : false;
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return checker
      .getTypeArguments(type as ts.TypeReference)
      .some((t) => containsDate(checker, program, t));
  }
  const symbol = type.getSymbol();
  return (
    symbol?.getName() === "Date" &&
    (symbol.getDeclarations() ?? []).some((d) =>
      program.isSourceFileDefaultLibrary(d.getSourceFile()),
    )
  );
}

function scan(program: ts.Program, isTarget: (fileName: string) => boolean): ScanResult {
  const checker = program.getTypeChecker();
  const result: ScanResult = { scannedFiles: [], checkedExpressions: 0, sites: [] };
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !isTarget(sf.fileName)) {
      continue;
    }
    result.scannedFiles.push(sf.fileName);
    const check = (expr: ts.Expression, where: string): void => {
      result.checkedExpressions += 1;
      const type = checker.getTypeAtLocation(expr);
      if (containsDate(checker, program, type)) {
        result.sites.push({
          file: sf.fileName,
          line: sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1,
          where,
          text: expr.getText(sf),
          type: checker.typeToString(type),
        });
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)) {
        for (const span of node.template.templateSpans) {
          check(span.expression, `${node.tag.getText(sf)}\`\${}\``);
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf);
        if (/(^|\.)param$|\.query$|\.execute$/.test(callee)) {
          for (const arg of node.arguments) {
            if (!ts.isTaggedTemplateExpression(arg)) {
              check(arg, `${callee}(...)`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return result;
}

function format(sites: RawDateSite[]): string {
  return sites
    .map(
      (s) => `${path.relative(PACKAGE_DIR, s.file)}:${s.line} [${s.where}] ${s.text} : ${s.type}`,
    )
    .join("\n");
}

describe("生の Date を SQL に渡さない（Issue #1040。Date は toPgTimestamp を通す）", () => {
  it("src/ の sql テンプレート・sql.param・.query/.execute の引数に、型が Date を含む式が無い", () => {
    const configPath = path.join(PACKAGE_DIR, "tsconfig.json");
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        },
      },
    );
    if (parsed === undefined) {
      throw new Error(`tsconfig を読めない: ${configPath}`);
    }
    const isTarget = (fileName: string): boolean => {
      const normalized = path.normalize(fileName);
      return normalized.startsWith(SRC_DIR) && !normalized.startsWith(TESTS_DIR);
    };
    const program = ts.createProgram(parsed.fileNames.filter(isTarget), parsed.options);
    const result = scan(program, isTarget);

    // 何も見ずに緑にならないこと: 検査の対象に、Date を書き込む本体が入っている。
    const scanned = result.scannedFiles.map((f) => path.relative(PACKAGE_DIR, f));
    expect(scanned).toContain(path.join("src", "memory-store.ts"));
    expect(scanned).toContain(path.join("src", "event-store.ts"));
    expect(result.checkedExpressions).toBeGreaterThan(0);

    expect(format(result.sites)).toBe("");
  });

  it("陽性対照: 検出器は、生の Date を渡す式を拾い、toPgTimestamp を通した式は拾わない", () => {
    const fileName = path.join(SRC_DIR, "__fixture_raw_date__.ts");
    const source = `
      declare function sql(strings: TemplateStringsArray, ...values: unknown[]): unknown;
      declare namespace sql { function param(value: unknown): unknown; }
      declare function toPgTimestamp(d: Date | null | undefined): string | null;
      declare const db: { execute(q: unknown): unknown; query(text: string, values: unknown[]): unknown };
      declare const at: Date;
      declare const maybe: Date | null | undefined;
      function f<T extends Date>(t: T) { return sql\`x = \${t}\`; }
      sql\`a = \${at}\`;
      sql\`b = \${maybe ?? null}\`;
      sql\`c = \${sql.param([at])}\`;
      db.query("d = $1", [at]);
      sql\`ok = \${toPgTimestamp(at)}\`;
      sql\`ok = \${at.getTime()}\`;
      sql\`ok = \${"text"}\`;
      const loose: any = at;
      sql\`missed = \${loose}\`;
    `;
    const host = ts.createCompilerHost({ strict: true, noEmit: true });
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, ...rest) =>
      path.normalize(name) === fileName
        ? ts.createSourceFile(name, source, languageVersion, true)
        : originalGetSourceFile(name, languageVersion, ...rest);
    const program = ts.createProgram([fileName], { strict: true, noEmit: true }, host);
    const result = scan(program, (f) => path.normalize(f) === fileName);

    expect(result.sites.map((s) => s.text)).toEqual(["t", "at", "maybe ?? null", "[at]", "[at]"]);
    // `any` を経由した `loose` は拾えない（doc の「捕まらないもの」）。
    expect(result.sites.map((s) => s.text)).not.toContain("loose");
  });
});
