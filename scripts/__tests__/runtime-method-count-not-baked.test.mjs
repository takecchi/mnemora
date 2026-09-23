import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ⭐ **この歯が測っているもの（消す前に読むこと）**
 *
 * **`Runtime` の非中核メソッドの「件数」が、生きた文書に焼き込まれていないこと**
 * （ADR 0269「引き受けた負債」、ADR 0270）。
 *
 * 🔑 **なぜ「正しい件数か」ではなく「件数が焼き込まれていること自体」を検査するか**:
 * `Runtime` のメソッド集合は `main` が動けば増減する側の数である
 * （`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」の「⭐ 線は『main が動くと変わるか』
 * である」）。⟹ **「いくつか」を検査すると、検査自体が「main が動くたびに書き直す」という
 * 同じ罪を歯の中に持ち込むことになる。この歯は値を検査しない——「数を書いている」という
 * *形* だけを検査する。**
 *
 * ## 出所
 *
 * [ADR 0244](../../docs/decisions/0244-runtime-method-doc-correspondence-tooth.md) の歯
 * （`runtime-method-doc-correspondence.test.mjs`）は README.md / docs/vision.md /
 * docs/architecture.md の3文書だけを見ており、**`docs/README.md`（ルート README.md とは
 * 別ファイル）は対象外だった。** [ADR 0269](../../docs/decisions/0269-port-interface-doc-correspondence-sweep.md)
 * の掃引が、その第4のファイルで実際に「9個」という古い数が焼き込まれたままなのを見つけた
 * （実体は17メソッド・非中核12。「9」は PR #344 時点、当時は正しかった値）。
 *
 * ⛔ **`docs/README.md` を ADR 0244 の `LIVE_DOCS` にそのまま足す道は採らなかった**——
 * それをすると「`docs/README.md` に非中核12個の名前を全部列挙せよ」という要求になり、
 * 文書の地図であるファイルへ API の写しを作ることを強制してしまう
 * （ADR 0270「採らなかった案」に、実際に足して走らせた赤の出力を記録した）。
 *
 * **ADR 0270 は表記の軸を「算用数字＋『個』」1つだけに絞っていた**
 * （逐語「確かめていないこと」: 「漢数字（『九個』等）や『N つ』の形は当てていない」）。
 * [ADR 0271](../../docs/decisions/0271-runtime-method-count-notation-sweep.md) が、
 * その表記の軸だけを広げた——**主語の錨（`メソッド`/`口`）は外していない。**
 *
 * ## この歯が検査するもの・しないもの
 *
 * - ⭕ **検査するもの**: 数値（算用数字または漢数字）＋助数詞（個/つ/本/件/箇所/種/通り）＋
 *   「の」＋（メソッド|口）という*形*（Runtime の非中核メソッド件数を名指しする、この repo で
 *   実際に腐った書き方とその表記違い）が、4本の生きた文書のどこにも無いこと。
 * - ⛔ **検査しないもの**: その数が正しいかどうか。**「十七個」に直しても、この歯はそれでも
 *   赤くする**——直すべきは値ではなく、数を書かない形にすることだからである。
 *
 * ## 正規表現を狭く取った理由 — 主語の錨は外さない
 *
 * **`main` が動いても変わらない数（中核5動詞の「5」、3層の「3」、この歯が見る文書の
 * 「4本」等）まで拾うと、正しい記述を赤にしてしまう**
 * （`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」）。
 * **4文書に在る裸の数（`メソッド`/`口` に係らない数）の分布を実測すると、
 * 「2つ」「三つ」「5つ」「3つ」「1つ」「一つ」「一本」「6つ」「7件」等が多数在り
 * （`main` が動いても変わらない側——中核5動詞の「5」、3層の「3」等）、**⟹ **裸の「N つ」
 * まで拾う広げ方は採らない。**⟹ **主語の錨（`メソッド`/`口`）を外さないまま、表記
 * （算用数字/漢数字、助数詞の種類）の軸だけを広げる。**ADR 0271 に、広げた各パターンを
 * 4文書へ実際に走らせて0件だったことと、変異試験で「広げる前の歯では緑のまま」だったことの
 * 実測を記録した。
 *
 * ## 総数を literal で持たない
 *
 * ⛔ **この歯は `Runtime` のメソッド数をどこにも持たない**——`packages/core/src/runtime.ts` を
 * 読みすらしない。ADR 0244 の歯が `CORE_VERBS`（中核5動詞、`main` が動いても変わらない側）を
 * literal で持つのとは違い、**この歯が検査する対象（件数という「値」）自体が `main` で
 * 動く側なので、literal で持つ余地がそもそも無い。**
 *
 * ## 確かめていないこと
 *
 * - **裸の「N つ」等**（`メソッド`/`口` に係らない数の焼き込み一般）は当てていない——
 *   [Issue #606](https://github.com/takecchi/mnemora/issues/606) が引き受けた、生きた文書の
 *   数の焼き込みを一般形で掃く仕事の範囲であり、この歯は主語がメソッド件数だと分かる形に
 *   錨を打ったままにしている（AGENTS.md「⚠ 偽陽性率に上限を置けない検査は門にしない」）。
 * - `Runtime` 以外の interface（`MemoryStore` 等）のメソッド件数の焼き込みは見ていない
 *   （ADR 0269 の対象外、ADR 0270 / 0271 も引き継がない）。
 * - プローズ中の**箇条書き形**の焼き込み（`Runtime` が3文書で実際に踏んだ、メソッド *名前の
 *   列挙* が腐る形。ADR 0244「⛔ この歯が捕まえないもの」参照）は、この歯の対象外である。
 *   この歯が見るのは「件数」という1個の数値の焼き込みだけであり、「行頭に `interface X {`
 *   があるかを見る」ような構文パースも、名前の列挙の正しさも見ていない。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const readmePath = join(repoRoot, "README.md");
const visionPath = join(repoRoot, "docs/vision.md");
const architecturePath = join(repoRoot, "docs/architecture.md");
const docsReadmePath = join(repoRoot, "docs/README.md");

const LIVE_DOCS = [
  { label: "README.md", path: readmePath },
  { label: "docs/vision.md", path: visionPath },
  { label: "docs/architecture.md", path: architecturePath },
  { label: "docs/README.md", path: docsReadmePath },
];

// ⛔ この正規表現は「Runtime の非中核メソッド件数」という、この repo で実際に腐った
//    1つの形と、その表記違い（算用数字/漢数字 × 個/つ/本/件/箇所/種/通り）だけを狙う。
//    ⭐ 主語の錨（「メソッド」「口」）は外していない——裸の「N つ」まで拾う広げ方は
//    採らない。4文書に在る裸の数（「2つ」「三つ」「5つ」「3つ」等、main が動いても
//    変わらない側）の分布が多いため、錨を外すと偽陽性の山になる（ADR 0271、実測）。
//    数値部＋助数詞＋「の」＋（メソッド|口）という組み合わせは、対象4文書を横断 grep
//    した実測でどこにも当たらない（ADR 0271）。
const KANJI_DIGITS = "[〇一二三四五六七八九十百千]+";
const COUNTER_WORD = "(?:個|つ|本|件|箇所|種|通り)";
const BAKED_METHOD_COUNT_RE = new RegExp(
  `(?:[0-9]+|${KANJI_DIGITS})${COUNTER_WORD}の(?:メソッド|口)`,
  "g",
);

/**
 * @param {string} text
 * @returns {string[]}
 */
function findBakedMethodCounts(text) {
  return [...text.matchAll(BAKED_METHOD_COUNT_RE)].map((m) => m[0]);
}

describe("Runtime の非中核メソッド件数が、生きた文書に焼き込まれていない（ADR 0269 引き受けた負債、ADR 0270 / 0271）", () => {
  it("陽性対照: 検出器は、算用数字＋「個」の実例を実際に捕まえる（空回り防止）", () => {
    const sample =
      "`記憶そのものを動かす中核`は5つの動詞。`Runtime` には他に9個のメソッドがあるが、3層に分かれる。";
    expect(findBakedMethodCounts(sample)).toEqual(["9個のメソッド"]);

    // main が動いても変わらない側の数（5つ・3層）は拾わないことも、同じ陽性対照の中で確認する。
    // 空文字列にならないこと自体は上の toEqual で既に示している。
  });

  it("陽性対照（ADR 0271 で広げた表記1）: 漢数字＋「個」の実例を捕まえる", () => {
    const sample = "`Runtime` には他に九個のメソッドがある。";
    expect(findBakedMethodCounts(sample)).toEqual(["九個のメソッド"]);
  });

  it("陽性対照（ADR 0271 で広げた表記2）: 算用数字＋「つ」の実例を捕まえる", () => {
    const sample = "`Runtime` には他に9つのメソッドがある。";
    expect(findBakedMethodCounts(sample)).toEqual(["9つのメソッド"]);
  });

  it("陽性対照（ADR 0271 で広げた表記3）: 算用数字＋「本」＋「口」の実例を捕まえる", () => {
    const sample = "別の層へ、3本の口を出した。";
    expect(findBakedMethodCounts(sample)).toEqual(["3本の口"]);
  });

  it("陽性対照（ADR 0271 で広げた表記4）: 漢数字＋「件」の実例を捕まえる", () => {
    const sample = "`Runtime` には他に五件のメソッドがある。";
    expect(findBakedMethodCounts(sample)).toEqual(["五件のメソッド"]);
  });

  it("陽性対照: 主語の錨が無い裸の数（「3つ」等）は、広げた後も拾わない（空回り防止）", () => {
    const sample = "中核は5つの動詞、3つの層、6つの案を検討した。";
    expect(findBakedMethodCounts(sample)).toEqual([]);
  });

  it("4本の生きた文書のどれも、Runtime の非中核メソッド件数を焼き込んでいない", () => {
    /** @type {string[]} */
    const hits = [];
    for (const doc of LIVE_DOCS) {
      const text = readFileSync(doc.path, "utf8");
      for (const match of findBakedMethodCounts(text)) {
        hits.push(`  ${doc.label.padEnd(17)} に在る: "${match}"`);
      }
    }

    if (hits.length > 0) {
      const message = [
        "生きた文書に、Runtime の非中核メソッド件数が焼き込まれている:",
        "",
        ...hits,
        "",
        "⟹ どうすればよいか:",
        "  数を*正しい件数に書き直す*のではなく、数を書かない形に変えること。",
        "  正本は packages/core/src/runtime.ts の `export interface Runtime` である。",
        "  件数を言わずに書くか、唯一の出所（上記ファイルの `export interface Runtime`）を",
        "  指すだけにすること（README.md「`Runtime` の中核5動詞以外」・docs/vision.md",
        "  「中核を守る3つの層」に、既にその形が在る）。",
        "  ⛔ この歯を満たすために「N個」を別の数へ書き換えないこと",
        "     （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。",
      ].join("\n");
      expect.fail(message);
    }

    expect(hits.length).toBe(0);
  });

  it("この歯が読んでいる4文書が、実在して空でない", () => {
    for (const doc of LIVE_DOCS) {
      const text = readFileSync(doc.path, "utf8");
      expect(
        text.length,
        `${doc.label} が1000文字未満——静かに空回りしている可能性がある`,
      ).toBeGreaterThanOrEqual(1000);
    }
  });
});
