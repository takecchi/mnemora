import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **README.md / docs/vision.md / docs/architecture.md の「中核を守る3つの層」の節群は、
 * `findCorrectionCandidates` と `applyCorrection` が「どの層にも置かれていない」理由を
 * 「どこへ置くかは意味の判定であり、機械には決まらない」と説明したうえで、その判定を
 * *誰が下すか*（＝判断の置き場）を Issue 番号で名指ししている。この歯は、3文書が名指し
 * している番号が互いに一致していることだけを縛る**（Issue #518 最終コメント・
 * Issue #605 本文）。
 *
 * 🔑 **なぜ「一致」であって「特定の番号への一致」ではないか**: [Issue #518] を実際に
 * 手で1箇所だけ `#605` へ付け替えて3文書を食い違わせたうえで `npx vitest run` を
 * フルで走らせたところ、83 files / 1514 tests が全部緑のまま通った——**判断の置き場
 * ポインタの食い違いを止める歯は、この歯を書く前は1本も無かった**（実測。付け替えは
 * その場で戻した）。既存の `runtime-method-doc-correspondence.test.mjs`（ADR 0244）は
 * *メソッド名の集合*しか縛っておらず、この種の食い違いの射程外である。
 *
 * ## ⛔ Issue 番号を literal で焼き込まない（AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」/ ADR 0234）
 *
 * **判断の置き場がどの Issue かは `main` が動けば変わる側である**——現に本 PR 自体が
 * `#518` から `#605` へその番号を動かす。⟹ この歯は「605」や「518」という文字列を
 * 期待値として一度も持たない。**3文書それぞれから番号を抽出し、抽出した値どうしを
 * 比較するだけである。**どちらの値が「正しい」かは、この歯の外（Issue 側の記述、
 * オーナーの判断）で決まる。
 *
 * ## 抽出する2つの文脈（実物を `grep -n` で確認した逐語。プローズ全体は読まない）
 *
 * 現物の6箇所は、文書によらず同じ2つの定型文に載っている（`grep -n "518" README.md
 * docs/vision.md docs/architecture.md` で確認済み）:
 *
 * 1. **リンク形**（3文書に各1箇所）:
 *    `（[Issue #NNN](https://github.com/takecchi/mnemora/issues/NNN)）。⛔ **書き込まない口**
 *    なので、`
 * 2. **素の形**（3文書に各1箇所）:
 *    `依然として意味の判定であり、この一覧はそれを決めていない（Issue #NNN）。`
 *
 * ⭐ **この歯は、上記2つの逐語に一致する箇所からしか番号を拾わない**——⛔ **文書全体から
 * 無差別に `#\d+` を拾うことはしない。**そうしないと、文書中の無関係な Issue 参照
 * （例: 別の ADR へのリンクに含まれる番号）まで「判断の置き場」として誤って巻き込む。
 *
 * ## この歯が捕まえないもの
 *
 * ⛔ **3層への分類そのものは見ない。**意味の判定であり機械には決まらない、という前提は
 * `runtime-method-doc-correspondence.test.mjs`（ADR 0244）と同じである。
 * ⛔ **番号が指す Issue が GitHub 上に実在するか・OPEN か CLOSED かは見ない。**この歯は
 * ネットワークに繋がず、repo 内の3文書だけを読む。
 * ⛔ **6箇所以外の場所（他の文書・コード中のコメント）に同じ形のポインタが増えても、
 * 正規表現の文脈（上記2つの定型文）に一致しなければ拾わない。**定型文自体が書き換われば、
 * この歯は「番号が1つも取れない」側で空回り防止に引っかかって落ちる（下記 it 1）。
 * ⛔ **3文書のうち1本が丸ごと欠けている・空である場合、`readFileSync` が例外を投げるか
 * 空回り防止（it 1）が落ちる。それ以上の「なぜ空か」の診断はしない。**
 *
 * ## 確かめていないこと
 *
 * - README.md / docs/vision.md / docs/architecture.md 以外の文書（各 package 配下の
 *   README.md 等）に同じ形の判断置き場ポインタがコピーされているかは掃いていない。
 * - Issue #518 本文・Issue #605 本文それ自体の記述内容とこの3文書が整合しているかは
 *   見ていない——この歯が縛るのは「3文書間で番号が一致していること」だけである。
 * - 番号が一致してさえいれば、その番号が「正しい移管先」であるかはこの歯の外側の判断
 *   （オーナー・Issue 側の記述）に委ねている。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const readmePath = join(repoRoot, "README.md");
const visionPath = join(repoRoot, "docs/vision.md");
const architecturePath = join(repoRoot, "docs/architecture.md");

const LIVE_DOCS = [
  { label: "README.md", path: readmePath },
  { label: "docs/vision.md", path: visionPath },
  { label: "docs/architecture.md", path: architecturePath },
];

// 文脈1: リンク形。「（[Issue #NNN](https://github.com/takecchi/mnemora/issues/NNN)）。
// ⛔ **書き込まない口**なので、」——3文書に共通する逐語（grep -n で確認済み）。
// group 1 = リンクテキストの番号、group 2 = URL 中の番号。
const LINKED_POINTER_RE =
  /\[Issue #(\d+)\]\(https:\/\/github\.com\/takecchi\/mnemora\/issues\/(\d+)\)）。⛔ \*\*書き込まない口\*\*なので、/g;

// 文脈2: 素の形。「依然として意味の判定であり、この一覧はそれを決めていない（Issue #NNN）。」
// ——3文書に共通する逐語。
const BARE_POINTER_RE =
  /依然として意味の判定であり、この一覧はそれを決めていない（Issue #(\d+)）。/g;

/**
 * @param {string} text
 * @param {RegExp} re グローバルフラグ付きの正規表現。呼ぶたびに lastIndex をリセットする。
 * @returns {string[][]} マッチごとのキャプチャグループ配列
 */
function extractAllMatches(text, re) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m.slice(1));
  }
  return out;
}

const docTexts = LIVE_DOCS.map((doc) => ({
  ...doc,
  text: readFileSync(doc.path, "utf8"),
}));

describe("生きた文書3本の「判断の置き場」Issue ポインタが一致している（Issue #518 最終コメント、Issue #605 本文）", () => {
  it("空回り防止: 各文書から、リンク形・素の形の番号が最低1つずつ取れる", () => {
    for (const doc of docTexts) {
      const linked = extractAllMatches(doc.text, LINKED_POINTER_RE);
      const bare = extractAllMatches(doc.text, BARE_POINTER_RE);
      expect(
        linked.length,
        `${doc.label} からリンク形（（[Issue #NNN](.../issues/NNN)）。⛔ **書き込まない口**なので、）の` +
          `番号が1つも取れなかった——抽出用の正規表現が、文書側の表現の変化に追随できていない可能性がある。`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        bare.length,
        `${doc.label} から素の形（依然として意味の判定であり、この一覧はそれを決めていない（Issue #NNN）。）の` +
          `番号が1つも取れなかった——抽出用の正規表現が、文書側の表現の変化に追随できていない可能性がある。`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("リンク形は、表示テキストの番号と URL 中の番号が食い違っていない", () => {
    const mismatches = [];
    for (const doc of docTexts) {
      const linked = extractAllMatches(doc.text, LINKED_POINTER_RE);
      for (const [textNum, urlNum] of linked) {
        if (textNum !== urlNum) {
          mismatches.push(`  ${doc.label}: 表示は #${textNum} だが URL は .../issues/${urlNum}`);
        }
      }
    }
    if (mismatches.length > 0) {
      expect.fail(
        [
          "リンクの表示番号と URL の番号が食い違っている:",
          "",
          ...mismatches,
          "",
          "⟹ Markdown リンクの `[Issue #NNN]` 部分と `(https://.../issues/NNN)` 部分の",
          "  両方を、同じ番号へ揃えて直すこと。",
        ].join("\n"),
      );
    }
  });

  it("3文書（README / vision / architecture）が名指しする判断の置き場の番号が、すべて一致している", () => {
    /** @type {Map<string, { linked: string[], bare: string[] }>} */
    const byDoc = new Map();
    const allNumbers = new Set();

    for (const doc of docTexts) {
      const linked = extractAllMatches(doc.text, LINKED_POINTER_RE).map(([textNum]) => textNum);
      const bare = extractAllMatches(doc.text, BARE_POINTER_RE).map(([num]) => num);
      byDoc.set(doc.label, { linked, bare });
      for (const n of [...linked, ...bare]) {
        allNumbers.add(n);
      }
    }

    if (allNumbers.size > 1) {
      const lines = [];
      for (const [label, { linked, bare }] of byDoc) {
        lines.push(
          `  ${label.padEnd(17)} リンク形: ${linked.map((n) => `#${n}`).join(", ") || "(無し)"} / ` +
            `素の形: ${bare.map((n) => `#${n}`).join(", ") || "(無し)"}`,
        );
      }
      const message = [
        "生きた文書3本が、判断の置き場として別々の Issue 番号を名指ししている:",
        "",
        ...lines,
        "",
        `  見つかった番号の集合: ${[...allNumbers].map((n) => `#${n}`).join(", ")}`,
        "",
        "⟹ どうすればよいか:",
        "  上に挙げた3文書の「中核を守る3つの層」の節で、リンク形・素の形の",
        "  両方を、同じ1つの Issue 番号（リンクの表示テキストと URL の両方）へ",
        "  揃えること。⛔ 一部だけを付け替えて残りを古いままにしないこと——",
        "  生きた文書が閉じた Issue を指す状態を、一度でも作らないため",
        "  （Issue #518 最終コメント、Issue #605 本文）。",
        "  ⛔ この歯を満たすために、番号を本テストファイルへ literal で書き戻さないこと",
        "     （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。",
      ].join("\n");
      expect.fail(message);
    }

    expect(allNumbers.size).toBe(1);
  });
});
