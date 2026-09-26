import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFullMarkdownReport,
  buildPackageMarkdownSection,
  buildPackageModel,
  diffPackageModels,
} from "../public-api-breaking-diff-lib.mjs";

/**
 * `scripts/public-api-breaking-diff.mjs`（Issue #818 / #811 / #813 / #815）が使う純関数の歯。
 *
 * 前半は合成フィクスチャ（小さな `.d.ts` 文字列）で5形それぞれの陽性・陰性を確かめる。
 * 後半（describe.skipIf ブロック）は実際の履歴（`v1.0.0` と `55a39bd`）を読み、
 * 実物の破壊的変更（`supportsTaxonomyMode`/`supportsLabels`/`supportsFindActiveByClaimKey` が
 * 一時的に必須化されていた区間、#717・#745 で足され #827 で任意へ戻された）を
 * 実際に捕まえることを確認する陽性対照（AGENTS.md「⚠ 「出なかった」を、事象が無いことの
 * 証明にしない」）。
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function diffOf(baseText, headText) {
  return diffPackageModels(
    buildPackageModel(baseText, "base.d.ts"),
    buildPackageModel(headText, "head.d.ts"),
  );
}

describe("① 既存の interface/型リテラルに必須メンバーが足された", () => {
  it("陽性: interface に必須プロパティが増える", () => {
    const base = `export interface Options {\n  name: string;\n}\n`;
    const head = `export interface Options {\n  name: string;\n  supportsFoo: boolean;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.requiredMemberAdded).toEqual([{ container: "Options", member: "supportsFoo" }]);
  });

  it("陽性: type alias の type literal に必須メソッドが増える", () => {
    const base = `export type Store = {\n  get(id: string): void;\n};\n`;
    const head = `export type Store = {\n  get(id: string): void;\n  put(id: string): void;\n};\n`;
    const diff = diffOf(base, head);
    expect(diff.requiredMemberAdded).toEqual([{ container: "Store", member: "put" }]);
  });

  it("陰性: 増えたメンバーが任意（?）なら検出しない", () => {
    const base = `export interface Options {\n  name: string;\n}\n`;
    const head = `export interface Options {\n  name: string;\n  supportsFoo?: boolean;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.requiredMemberAdded).toEqual([]);
  });

  it("陰性: class に必須メンバーが増えても検出しない（クラスは対象外——doc 参照）", () => {
    const base = `export declare class Store {\n  get(id: string): void;\n}\n`;
    const head = `export declare class Store {\n  get(id: string): void;\n  put(id: string): void;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.requiredMemberAdded).toEqual([]);
  });
});

describe("② 既存メンバーが任意から必須になった", () => {
  it("陽性: interface のプロパティが optional → required", () => {
    const base = `export interface Options {\n  supportsFoo?: boolean;\n}\n`;
    const head = `export interface Options {\n  supportsFoo: boolean;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.memberBecameRequired).toEqual([{ container: "Options", member: "supportsFoo" }]);
  });

  it("陰性: 逆向き（required → optional）は検出しない（非破壊）", () => {
    const base = `export interface Options {\n  supportsFoo: boolean;\n}\n`;
    const head = `export interface Options {\n  supportsFoo?: boolean;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.memberBecameRequired).toEqual([]);
  });

  it("陰性: 変化なし（両方 optional）は検出しない", () => {
    const base = `export interface Options {\n  supportsFoo?: boolean;\n}\n`;
    const head = `export interface Options {\n  supportsFoo?: boolean;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.memberBecameRequired).toEqual([]);
  });
});

describe("③ export が消えた／名前が変わった", () => {
  it("陽性: interface export がまるごと消える（改名候補なし）", () => {
    const base = `export interface Foo {\n  a: string;\n}\n`;
    const head = ``;
    const diff = diffOf(base, head);
    expect(diff.exportRemoved).toEqual([{ name: "Foo", kind: "interface", renamedTo: null }]);
  });

  it("陽性: 消えた export と同じ形（メンバー集合が一致）の新規 export があれば改名推定を併記する", () => {
    const base = `export interface Foo {\n  a: string;\n  b: number;\n}\n`;
    const head = `export interface Bar {\n  a: string;\n  b: number;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.exportRemoved).toEqual([{ name: "Foo", kind: "interface", renamedTo: "Bar" }]);
  });

  it("陽性: union（文字列リテラル）の export が消えても検出する", () => {
    const base = `export type Kind = "a" | "b";\n`;
    const head = ``;
    const diff = diffOf(base, head);
    expect(diff.exportRemoved).toEqual([{ name: "Kind", kind: "typeAlias", renamedTo: null }]);
  });

  it("陰性: export がそのまま残っていれば検出しない", () => {
    const base = `export interface Foo {\n  a: string;\n}\n`;
    const head = `export interface Foo {\n  a: string;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.exportRemoved).toEqual([]);
  });
});

describe("④ 関数/メソッド/コンストラクタの必須引数が増えた", () => {
  it("陽性: トップレベル関数の必須引数が増える", () => {
    const base = `export declare function run(a: string): void;\n`;
    const head = `export declare function run(a: string, b: number): void;\n`;
    const diff = diffOf(base, head);
    expect(diff.requiredParamIncreased).toEqual([
      { container: null, member: "run", before: 1, after: 2 },
    ]);
  });

  it("陽性: interface のメソッドの必須引数が増える", () => {
    const base = `export interface Store {\n  get(id: string): void;\n}\n`;
    const head = `export interface Store {\n  get(id: string, tenant: string): void;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.requiredParamIncreased).toEqual([
      { container: "Store", member: "get", before: 1, after: 2 },
    ]);
  });

  it("陽性: class のコンストラクタの必須引数が増える", () => {
    const base = `export declare class Client {\n  constructor(a: string);\n}\n`;
    const head = `export declare class Client {\n  constructor(a: string, b: string);\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.requiredParamIncreased).toEqual([
      { container: "Client", member: "(constructor)", before: 1, after: 2 },
    ]);
  });

  it("陽性: class の public メソッドの必須引数が増える", () => {
    const base = `export declare class Client {\n  send(a: string): void;\n}\n`;
    const head = `export declare class Client {\n  send(a: string, b: string): void;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.requiredParamIncreased).toEqual([
      { container: "Client", member: "send", before: 1, after: 2 },
    ]);
  });

  it("陰性: 増えた引数が任意（?）なら必須引数の個数は変わらないので検出しない", () => {
    const base = `export declare function run(a: string): void;\n`;
    const head = `export declare function run(a: string, b?: number): void;\n`;
    const diff = diffOf(base, head);
    expect(diff.requiredParamIncreased).toEqual([]);
  });

  it("陰性: 個数が変わらない型だけの変更は検出しない（既知の射程外——migration-v1.md 項目8と同じ形）", () => {
    const base = `export declare class Client {\n  setDefaultHalfLifeRecalls(tenantId: string, recalls: number): void;\n}\n`;
    const head = `export declare class Client {\n  setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void>;\n}\n`;
    const diff = diffOf(base, head);
    expect(diff.requiredParamIncreased).toEqual([]);
  });
});

describe("⑤ 出力側の union に値が増えた（入力側での拡張は非破壊）", () => {
  it("陽性: 戻り値としてしか使われない union に値が増える", () => {
    const base = [
      `export type Kind = "created" | "updated";`,
      `export interface Event { kind: Kind; }`,
      `export interface Store { list(id: string): Promise<Event[]>; }`,
      "",
    ].join("\n");
    const head = [
      `export type Kind = "created" | "updated" | "unsuperseded";`,
      `export interface Event { kind: Kind; }`,
      `export interface Store { list(id: string): Promise<Event[]>; }`,
      "",
    ].join("\n");
    const diff = diffOf(base, head);
    expect(diff.outputUnionValueAdded).toEqual([{ name: "Kind", addedValues: ["unsuperseded"] }]);
    expect(diff.needsHumanJudgment).toEqual([]);
  });

  it("陰性: 引数としてしか使われない union の拡張は非破壊として一覧に出さない", () => {
    const base = [
      `export type Mode = "a" | "b";`,
      `export interface Store { setMode(mode: Mode): void; }`,
      "",
    ].join("\n");
    const head = [
      `export type Mode = "a" | "b" | "c";`,
      `export interface Store { setMode(mode: Mode): void; }`,
      "",
    ].join("\n");
    const diff = diffOf(base, head);
    expect(diff.outputUnionValueAdded).toEqual([]);
    expect(diff.needsHumanJudgment).toEqual([]);
  });

  it("要人判断: 入力・出力の両方から到達できる union は機械では決め切れないとして分ける", () => {
    const base = [
      `export type Mode = "a" | "b";`,
      `export interface Options { mode: Mode; }`,
      `export interface Store {\n  setMode(opts: Options): void;\n  getMode(): Options;\n}`,
      "",
    ].join("\n");
    const head = [
      `export type Mode = "a" | "b" | "c";`,
      `export interface Options { mode: Mode; }`,
      `export interface Store {\n  setMode(opts: Options): void;\n  getMode(): Options;\n}`,
      "",
    ].join("\n");
    const diff = diffOf(base, head);
    expect(diff.outputUnionValueAdded).toEqual([]);
    expect(diff.needsHumanJudgment).toHaveLength(1);
    expect(diff.needsHumanJudgment[0].name).toBe("Mode");
  });

  it("要人判断: どこからも参照されていない union は「不明」として分ける", () => {
    const base = `export type Mode = "a" | "b";\n`;
    const head = `export type Mode = "a" | "b" | "c";\n`;
    const diff = diffOf(base, head);
    expect(diff.outputUnionValueAdded).toEqual([]);
    expect(diff.needsHumanJudgment).toHaveLength(1);
    expect(diff.needsHumanJudgment[0].name).toBe("Mode");
  });

  it("陰性: 非リテラル union（型を含む）は対象外", () => {
    const base = `export interface Other {}\nexport type Result = Other | null;\n`;
    const head = `export interface Other {}\nexport type Result = Other | null | undefined;\n`;
    const diff = diffOf(base, head);
    expect(diff.outputUnionValueAdded).toEqual([]);
    expect(diff.needsHumanJudgment).toEqual([]);
  });
});

describe("Markdown 組み立て", () => {
  it("差分が無ければパッケージの節は null", () => {
    const diff = diffOf(
      `export interface Foo { a: string; }\n`,
      `export interface Foo { a: string; }\n`,
    );
    expect(buildPackageMarkdownSection("@mnemora/core", diff)).toBeNull();
  });

  it("差分があれば見出しと箇条書きを含む", () => {
    const diff = diffOf(
      `export interface Foo { a: string; }\n`,
      `export interface Foo { a: string; b: boolean; }\n`,
    );
    const section = buildPackageMarkdownSection("@mnemora/core", diff);
    expect(section).toContain("### @mnemora/core");
    expect(section).toContain("Foo.b");
  });

  it("buildFullMarkdownReport は読み取り失敗を専用の節にまとめ、exit 判定の語彙を持たない", () => {
    const md = buildFullMarkdownReport({
      base: "v1.0.0",
      head: "作業ツリー",
      perPackage: [{ pkgName: "@mnemora/openai", diff: null, error: "snapshot が見つからない" }],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(md).toContain("読み取りに失敗したパッケージ");
    expect(md).toContain("@mnemora/openai");
    expect(md).toContain("判定ではなく候補の一覧");
  });
});

/**
 * 実際の履歴を読む陽性対照。`v1.0.0`/`55a39bd` の両 ref が手元に無い環境
 * （浅い clone 等）では、`adr-index-freshness.test.mjs` と同じ考え方で
 * スキップする——このテストの目的は「実履歴を読めたときに、実際の3件を捕まえるか」
 * であり、ref が無い環境で赤くして CI を無関係な理由で落とすことではない。
 */
function refIsAvailable(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

const BASE_REF = "v1.0.0";
const HEAD_REF = "55a39bd";
const bothRefsAvailable = refIsAvailable(BASE_REF) && refIsAvailable(HEAD_REF);

describe.skipIf(!bothRefsAvailable)(
  "陽性対照: v1.0.0 → 55a39bd（#827 の直前）で testkit の3フィールドが実際に必須化されていたことを捕まえる",
  () => {
    function readAtRef(ref) {
      return execFileSync("git", ["show", `${ref}:scripts/__snapshots__/public-api/testkit.d.ts`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
    }

    it("supportsTaxonomyMode / supportsLabels / supportsFindActiveByClaimKey を requiredMemberAdded に出す", () => {
      const baseModel = buildPackageModel(readAtRef(BASE_REF), `${BASE_REF}:testkit.d.ts`);
      const headModel = buildPackageModel(readAtRef(HEAD_REF), `${HEAD_REF}:testkit.d.ts`);
      const diff = diffPackageModels(baseModel, headModel);

      const members = diff.requiredMemberAdded.map((x) => x.member).sort();
      expect(members).toEqual(
        ["supportsFindActiveByClaimKey", "supportsLabels", "supportsTaxonomyMode"].sort(),
      );
      // 空振り防止（AGENTS.md「⚠ 「出なかった」を、事象が無いことの証明にしない」）:
      // 3件が本当にちょうど3件であり、探り棒が鈍って0件やそれ以上を返していないことまで見る。
      expect(diff.requiredMemberAdded).toHaveLength(3);
    });

    it("同じ2点間で、無関係な破壊的変更まで過剰検出していない（この2点間の実際の差分は3件だけ——本文冒頭のコメント参照）", () => {
      const baseModel = buildPackageModel(readAtRef(BASE_REF), `${BASE_REF}:testkit.d.ts`);
      const headModel = buildPackageModel(readAtRef(HEAD_REF), `${HEAD_REF}:testkit.d.ts`);
      const diff = diffPackageModels(baseModel, headModel);
      expect(diff.memberBecameRequired).toEqual([]);
      expect(diff.exportRemoved).toEqual([]);
      expect(diff.requiredParamIncreased).toEqual([]);
    });
  },
);
