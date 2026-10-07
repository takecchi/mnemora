import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 件数の「値」は検査しない（main が動けば増減する数で、検査自体が書き直しを要求する）。
// 「数を書いている」という形だけを見る。

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

// 主語の錨（「メソッド」「口」）を外さない。裸の「N つ」まで拾うと、main が動いても変わらない数
// （5つ・3層）で偽陽性になる。
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

describe("Runtime の非中核メソッド件数が、生きた文書に焼き込まれていない（ADR 0269 引き受けた負債、ADR 0270 / 0272）", () => {
  it("陽性対照: 検出器は、算用数字＋「個」の実例を実際に捕まえる（空回り防止）", () => {
    const sample =
      "`記憶そのものを動かす中核`は5つの動詞。`Runtime` には他に9個のメソッドがあるが、3層に分かれる。";
    expect(findBakedMethodCounts(sample)).toEqual(["9個のメソッド"]);
  });

  it("陽性対照（ADR 0272 で広げた表記1）: 漢数字＋「個」の実例を捕まえる", () => {
    const sample = "`Runtime` には他に九個のメソッドがある。";
    expect(findBakedMethodCounts(sample)).toEqual(["九個のメソッド"]);
  });

  it("陽性対照（ADR 0272 で広げた表記2）: 算用数字＋「つ」の実例を捕まえる", () => {
    const sample = "`Runtime` には他に9つのメソッドがある。";
    expect(findBakedMethodCounts(sample)).toEqual(["9つのメソッド"]);
  });

  it("陽性対照（ADR 0272 で広げた表記3）: 算用数字＋「本」＋「口」の実例を捕まえる", () => {
    const sample = "別の層へ、3本の口を出した。";
    expect(findBakedMethodCounts(sample)).toEqual(["3本の口"]);
  });

  it("陽性対照（ADR 0272 で広げた表記4）: 漢数字＋「件」の実例を捕まえる", () => {
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
