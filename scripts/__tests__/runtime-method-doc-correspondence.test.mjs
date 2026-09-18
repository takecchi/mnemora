import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`Runtime`（`packages/core/src/runtime.ts` の `export interface Runtime`）に生えている
 * メソッドが、README.md / docs/vision.md / docs/architecture.md の3文書すべてで
 * 名指しされていること**（Issue #518、ADR 0244）。
 *
 * 🔑 **なぜ「件数」ではなく「名前の集合」を検査するか**: Issue #518 が見つけた壊れ方は
 * 「10個」という数字が古くなったことだった。だが同じ Issue の本文が予告したとおり、
 * 方向1（数を消して唯一の出所を指すだけにする、PR #531）だけを実装した翌日には
 * 「数は消えたが、名前の *列挙* のほうが腐る」ことが実際に起きた（`applyCorrection`、
 * ADR 0242 が着地して3文書のどこにも名前が出ない状態になった）。⟹ **この歯は件数を
 * 数え直すのではなく、`Runtime` の各メソッド名が3文書のどこかに `` `name` `` として
 * 実在するかを直接見る。**
 *
 * ## 正典の導出は、コードのパースであってプローズのパースではない
 *
 * `packages/core/src/runtime.ts` を読み、`export interface Runtime {` の行から
 * 列0の `}` までを切り出し、その範囲から行頭2スペースのメソッド宣言
 * （`/^ {2}([A-Za-z][A-Za-z0-9_]*)\s*[(<]/`）を正規表現で拾う。これは TypeScript の
 * 構文を機械的に数え直しているだけであり、`docs/vision.md`「中核を守る3つの層」のような
 * 散文をパースしているわけではない——ADR 0199 が「表現が変わると歯自体が壊れる」として
 * 落とした形（節を切り出してプローズをパースする）とは違う。
 *
 * ## literal で持ってよい唯一のもの: 中核5動詞
 *
 * `CORE_VERBS` だけは literal で持つ。正典（`docs/vision.md`「外から見える API: 中核の5動詞」）
 * が逐語で「ここは増やさない」と固定しており、`main` が動いても変わらない側だからである
 * （`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」の「⭐ 線は『main が動くと変わるか』
 * である」）。**`Runtime` の残り（非中核）のメソッド集合は `main` が動けば変わる側なので、
 * literal では持たない**——`export interface Runtime` から毎回数え直す（`it` 2）。
 *
 * ADR 0212（`local-embedding-size-noun-correspondence.test.mjs`）から継いだのは
 * 「literal を持つなら、その literal が一次資料に実在することを別の `it` で検査する」
 * という部分だけである（`it` 1）。「正典値を literal で持つ」という ADR 0212 の型そのものは
 * 継いでいない——ADR 0212 の対象（モデルサイズ）は `main` では動かない側だが、
 * `Runtime` のメソッド集合は動く側であり、前提が違うためである。
 *
 * ## この歯が縛らないこと
 *
 * ⛔ **3層（保守操作 / 是正・取り消し / 説明）への分類は縛らない。**意味の判定であり、
 * 機械には決まらない（Issue #518 本文、ADR 0223 決定2）。この歯が検査するのは
 * 「名前がどこかに出ているか」だけであり、「正しい節で説明されているか」ではない。
 *
 * ⛔ **総数はハードコードしない。**`main` が動けば増減する側の数だからである
 * （`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。`it` 2 は下限
 * （`R.length >= 10`）だけを固定する空回り防止であり、正確な総数の代わりにはしない。
 *
 * ## 確かめていないこと
 *
 * - 名前が文書の「どこに」書かれているかは見ていない。3文書のまったく無関係な場所に
 *   名前が1度出ていれば、この歯は通る——保証するのは「名前が落ちていないこと」だけで、
 *   「正しい節で説明されていること」ではない。
 * - `Runtime` 以外の interface（`MemoryStore` 等）に同じ形の焼き込みが在るかは掃いていない
 *   （Issue #518 本文も同じことを「確かめていないこと」に挙げている）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const runtimePath = join(repoRoot, "packages/core/src/runtime.ts");
const runtimeText = readFileSync(runtimePath, "utf8");

const readmePath = join(repoRoot, "README.md");
const visionPath = join(repoRoot, "docs/vision.md");
const architecturePath = join(repoRoot, "docs/architecture.md");

const LIVE_DOCS = [
  { label: "README.md", path: readmePath },
  { label: "docs/vision.md", path: visionPath },
  { label: "docs/architecture.md", path: architecturePath },
];

// ⭐ 中核5動詞だけは literal で持つ。正典（docs/vision.md「外から見える API: 中核の5動詞」）が
//    逐語で「ここは増やさない」と固定しており、main が動いても変わらない側だからである
//    （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」の「⭐ 線は『main が動くと変わるか』である」）。
const CORE_VERBS = ["observe", "recall", "consolidate", "reflect", "forget"];

/**
 * `export interface Runtime { ... }` を、列0の `}` までで切り出す。
 *
 * @returns {string}
 */
function extractRuntimeInterfaceBlock() {
  const startMarker = "export interface Runtime {";
  const startIdx = runtimeText.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(
      `runtime.ts に "${startMarker}" が見つからない——interface の宣言が変わった可能性がある`,
    );
  }
  const afterStart = runtimeText.slice(startIdx);
  const lines = afterStart.split("\n");
  let endLineIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^}/.test(lines[i])) {
      endLineIndex = i;
      break;
    }
  }
  if (endLineIndex === -1) {
    throw new Error("export interface Runtime の閉じる列0の '}' が見つからない");
  }
  return lines.slice(0, endLineIndex + 1).join("\n");
}

/**
 * `export interface Runtime` のブロックから、行頭2スペースのメソッド宣言の名前を
 * 機械的に抽出する。⭐ これはコードのパースであってプローズのパースではない。
 *
 * @returns {string[]}
 */
function extractRuntimeMethodNames() {
  const block = extractRuntimeInterfaceBlock();
  const methodRe = /^ {2}([A-Za-z][A-Za-z0-9_]*)\s*[(<]/gm;
  const names = [];
  let match;
  while ((match = methodRe.exec(block)) !== null) {
    names.push(match[1]);
  }
  return names;
}

describe("Runtime のメソッドが3文書（README/vision/architecture）で名指しされている（Issue #518、ADR 0244）", () => {
  it("中核5動詞の literal が、一次資料 docs/vision.md に実在する", () => {
    const visionText = readFileSync(visionPath, "utf8");
    expect(visionText, "docs/vision.md に「中核の5動詞」という文字列が見つからない").toContain(
      "中核の5動詞",
    );
    for (const verb of CORE_VERBS) {
      expect(
        visionText,
        `docs/vision.md に CORE_VERBS の "${verb}" が \`${verb}\` の形で見つからない`,
      ).toContain(`\`${verb}\``);
    }
  });

  it("export interface Runtime から、メソッド名の集合を機械的に数え直せる", () => {
    const names = extractRuntimeMethodNames();

    // 陽性対照: 抽出が生きていることの証拠。CORE_VERBS を全部含まなければ、
    // 正規表現かマーカー文字列が壊れている。
    for (const verb of CORE_VERBS) {
      expect(names, `抽出結果に中核動詞 "${verb}" が含まれない——抽出が壊れている`).toContain(verb);
    }

    // ⛔ 総数をハードコードしない——main が動けば変わる側である
    // （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。下限だけを空回り防止として固定する。
    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it("Runtime のメソッド（中核5動詞を除く）は、README / vision / architecture の3文書すべてで名指しされている", () => {
    const allNames = extractRuntimeMethodNames();
    const target = allNames.filter((name) => !CORE_VERBS.includes(name));

    const docTexts = LIVE_DOCS.map((doc) => ({
      ...doc,
      text: readFileSync(doc.path, "utf8"),
    }));

    /** @type {Map<string, string[]>} 文書ラベル -> 見つからなかった名前の配列 */
    const missingByDoc = new Map();
    for (const doc of docTexts) {
      const missing = target.filter((name) => !doc.text.includes(`\`${name}\``));
      if (missing.length > 0) {
        missingByDoc.set(doc.label, missing);
      }
    }

    if (missingByDoc.size > 0) {
      const lines = [];
      for (const [label, names] of missingByDoc) {
        for (const name of names) {
          lines.push(`  ${label.padEnd(17)} に無い: ${name}`);
        }
      }
      const message = [
        "Runtime のメソッドが、生きた文書で名指しされていない:",
        "",
        ...lines,
        "",
        "⟹ どうすればよいか:",
        "  packages/core/src/runtime.ts の `export interface Runtime` に口を足したら、",
        "  上の文書の「中核を守る3つの層」の節に、その名前を `バッククォート付き` で書くこと。",
        "  ⭐ 3層のどれに分類するかは意味の判定であり、この歯は縛っていない。",
        "     分類が決まらないなら「どの層にも置かれていない」側に名指しするだけでよい",
        "     （README.md / docs/vision.md / docs/architecture.md に既にその形が在る）。",
        "  ⛔ この歯を満たすために、個数を文書へ書き戻さないこと",
        "     （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。",
      ].join("\n");
      expect.fail(message);
    }

    expect(missingByDoc.size).toBe(0);
  });

  it("この歯が読んでいる3文書が、実在して空でない", () => {
    for (const doc of LIVE_DOCS) {
      const text = readFileSync(doc.path, "utf8");
      expect(
        text.length,
        `${doc.label} が1000文字未満——静かに空回りしている可能性がある`,
      ).toBeGreaterThanOrEqual(1000);
    }
  });
});
