import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { execSyncWithDeadline } from "./spawn-with-deadline.mjs";

/**
 * ADR (`docs/decisions/**`) は対象外（ADR 本文は書き換えない規律なので、直せないのに赤くなる）。
 * 実在検査の範囲は ADR 0085 全体（`36MB` は決定1、`42MB` は決定7にあり、決定7からは再導出できない）。
 * 数字の文脈は窓に含むかではなく最近傍の名詞で判定する（1つの文に両方の名詞が同居するため）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const adrPath = join(repoRoot, "docs/decisions/0085-local-embedding-provider.md");
const adrText = readFileSync(adrPath, "utf8");

/** 自分自身はスキャン対象から除く（テスト内に数字を並べた例示があるので、自分の例示を誤検知する）。 */
const selfPath = relative(repoRoot, fileURLToPath(import.meta.url));

const CANONICAL = {
  totalMb: "42MB",
  weightMb: "36MB",
  fileCountPhrase: "4ファイル",
  weightBytes: "37,142,404",
};

const TOTAL_NOUNS = ["モデル一式", "一式", "4ファイル計", "4ファイル"];

/** 素の「モデル」を含めるのは、推論コストの文脈で「重み」の同義語として使われているため。 */
const WEIGHT_NOUNS = ["重み本体", "重み", "model_quantized.onnx", "ONNXモデル", "モデル"];

const CONTEXT_WINDOW = 50;

/**
 * 小数部は `0` 以外を許さない（別の値を拾わないため）。全角数字は半角へ正規化してから比較し、生のマッチは `rawMatched` に持つ。
 */
const SIZE_RE =
  /(?<![0-9０-９.．])(36|42|３６|４２)(?:[.．]0+)?\s*(MB|MiB|ＭＢ|ＭｉＢ)(?![0-9A-Za-z])/g;

/**
 * @param {string} str
 * @returns {string}
 */
function toHalfWidthDigits(str) {
  return str.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/**
 * `.github/workflows/publish.yml` は publish の経路に触れない規律のため、読まずに除外する。
 *
 * @returns {string[]} repo ルートからの相対パス
 */
function listScannableFiles() {
  const raw = execSyncWithDeadline("git ls-files", { cwd: repoRoot, encoding: "utf8" });
  return raw
    .split("\n")
    .filter(Boolean)
    .filter((relPath) => !relPath.startsWith("docs/decisions/"))
    .filter((relPath) => relPath !== ".github/workflows/publish.yml")
    .filter((relPath) => relPath !== selfPath);
}

/**
 * @param {string} before マッチ直前 `CONTEXT_WINDOW` 文字
 * @param {string} after マッチ直後 `CONTEXT_WINDOW` 文字
 * @param {string[]} nouns
 * @returns {number}
 */
function nearestNounDistance(before, after, nouns) {
  let min = Infinity;
  for (const noun of nouns) {
    const idxBefore = before.lastIndexOf(noun);
    if (idxBefore !== -1) {
      const distance = before.length - (idxBefore + noun.length);
      if (distance < min) min = distance;
    }
    const idxAfter = after.indexOf(noun);
    if (idxAfter !== -1 && idxAfter < min) min = idxAfter;
  }
  return min;
}

/**
 * @typedef {{ file: string, line: number, matched: string, rawMatched: string, context: "total" | "weight" | "none", snippet: string }} SizeMention
 */

/**
 * @returns {SizeMention[]}
 */
function scanSizeMentions() {
  /** @type {SizeMention[]} */
  const mentions = [];
  for (const relPath of listScannableFiles()) {
    let text;
    try {
      text = readFileSync(join(repoRoot, relPath), "utf8");
    } catch {
      continue; // シンボリックリンク切れ等は無視(このリポジトリでは起きない想定)
    }
    SIZE_RE.lastIndex = 0;
    let match;
    while ((match = SIZE_RE.exec(text)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start);
      const after = text.slice(end, end + CONTEXT_WINDOW);
      const totalDistance = nearestNounDistance(before, after, TOTAL_NOUNS);
      const weightDistance = nearestNounDistance(before, after, WEIGHT_NOUNS);
      /** @type {"total" | "weight" | "none"} */
      let context = "none";
      if (totalDistance < weightDistance) context = "total";
      else if (weightDistance < totalDistance) context = "weight";
      const line = text.slice(0, start).split("\n").length;
      mentions.push({
        file: relPath,
        line,
        matched: toHalfWidthDigits(match[1]),
        rawMatched: match[0],
        context,
        snippet: `${before}[${match[0]}]${after}`.replace(/\s+/g, " "),
      });
    }
  }
  return mentions;
}

describe("local-embedding のサイズ表記(36MB/42MB)が、名詞と正しく対応している(Issue #455)", () => {
  it("正典値(literal)が ADR 0085 の本文に実在する(決定7: 42MB/4ファイル/バイト厳密値、決定1: 重み36MB)", () => {
    for (const literal of Object.values(CANONICAL)) {
      expect(adrText, `ADR 0085 に literal "${literal}" が見つからない`).toContain(literal);
    }
  });

  it("スキャン対象ファイルが1本以上見つかる(listScannableFiles の土台が崩れていない)", () => {
    expect(listScannableFiles().length).toBeGreaterThan(0);
  });

  const mentions = scanSizeMentions();

  it("⚠ 空回り防止の下限: 判定できた(total/weightのいずれか)出現が最低10件はある(総数はハードコードしない)", () => {
    // `toBe` にしない（出現数は編集で増減する）。下限だけを固定する。
    const resolved = mentions.filter((m) => m.context !== "none");
    expect(resolved.length).toBeGreaterThanOrEqual(10);
  });

  it("⚠ 空回り防止の下限: 出現が見つかったファイルが最低5本はある", () => {
    const filesWithResolvedMention = new Set(
      mentions.filter((m) => m.context !== "none").map((m) => m.file),
    );
    expect(filesWithResolvedMention.size).toBeGreaterThanOrEqual(5);
  });

  it("⭐ 文脈が判定できたすべての出現で、数字が文脈(一式=42/重み=36)と対応している", () => {
    const mismatches = mentions
      .filter((m) => m.context !== "none")
      .filter((m) => (m.context === "total" ? m.matched !== "42" : m.matched !== "36"))
      .map(
        (m) =>
          `${m.file}:${m.line} — "${m.rawMatched}"(数字=${m.matched}) が「${
            m.context === "total" ? "一式" : "重み"
          }」文脈(期待値 ${m.context === "total" ? "42" : "36"}MB)に付いている: ...${m.snippet}...`,
      );
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("すべての出現で、最近傍の名詞から文脈(一式/重み)を判定できる(未判定=noneが無い)", () => {
    const unresolved = mentions
      .filter((m) => m.context === "none")
      .map(
        (m) => `${m.file}:${m.line} — "${m.rawMatched}" の文脈を判定できない: ...${m.snippet}...`,
      );
    expect(
      unresolved,
      `${unresolved.join(
        "\n",
      )}\n⟹ 新しい言い回しが TOTAL_NOUNS/WEIGHT_NOUNS のどちらにも一致しない。名詞集合を見直すか、書き方を既存の形に揃えること。`,
    ).toEqual([]);
  });
});

/**
 * この `describe` を別ファイルへ切り出さない（例示文字列が `selfPath` の除外対象外になり、
 * `scanSizeMentions()` に未判定として拾われて自分が赤くなる。ADR 0212 決定2）。
 */
describe("SIZE_RE の射程(表記揺れ) — ADR 0212 追記(2026-09-21)", () => {
  /**
   * `SIZE_RE` は `g` フラグ付きで `lastIndex` を使い回すと呼び出し順に依存するので、呼び出しごとに新しいインスタンスを作る。
   *
   * @param {string} text
   * @returns {{ raw: string, num: string }[]}
   */
  function extractSizeMatches(text) {
    const re = new RegExp(SIZE_RE.source, SIZE_RE.flags);
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ raw: m[0], num: toHalfWidthDigits(m[1]) });
    }
    return out;
  }

  it("HIT する(拾えるべき)表記をすべて拾う(既存5形+今回広げた5形)", () => {
    const cases = [
      ["42MB", "42"],
      ["42 MB", "42"], // 半角スペース1個
      ["42 MB", "42"], // NBSP
      ["42\tMB", "42"],
      ["42\nMB", "42"],
      ["36MB", "36"],
      ["36 MB", "36"],
      ["42  MB", "42"], // 連続空白(2個以上)
      ["42.0MB", "42"], // 小数(.0)
      ["42.00MB", "42"], // 小数(.00)
      ["42．0MB", "42"], // 全角ピリオド
      ["４２MB", "42"], // 全角数字
      ["３６MB", "36"], // 全角数字
      ["42MiB", "42"], // MiB表記
      ["42ＭＢ", "42"], // 全角MB
      ["42ＭｉＢ", "42"], // 全角MiB
      ["重みは 42MB", "42"],
      ["（42MB）", "42"],
      ["約42MB", "42"],
    ];
    for (const [text, expectedNum] of cases) {
      const matches = extractSizeMatches(text);
      expect(matches, `"${text}" が拾えない(HITするはずの形)`).toHaveLength(1);
      expect(matches[0].num, `"${text}" から読んだ数字`).toBe(expectedNum);
    }
  });

  it("miss しなければならない(誤って拾ってはいけない)表記を拾わない", () => {
    const cases = [
      "142MB", // 前置に別の数字(2桁前置の誤検出)
      "1042MB",
      "42MBps", // 単位の後ろに英字が続く(別の単位の略語の一部)
      "4.2MB", // "42" が連続した部分文字列として現れない
      "42Mb", // 小文字の b = メガビット(射程外)
      "41.9MB", // 36/42 とは別の値
      "4.42MB",
      "4．42MB", // 全角ピリオド
      "約4.42MB",
    ];
    for (const text of cases) {
      expect(extractSizeMatches(text), `"${text}" を誤って拾った(missするはずの形)`).toEqual([]);
    }
  });

  it("全角数字が半角へ正規化される(matched)。エラーメッセージ用には生のマッチ文字列(rawMatched)が残る", () => {
    expect(toHalfWidthDigits("４２")).toBe("42");
    expect(toHalfWidthDigits("３６")).toBe("36");
    expect(toHalfWidthDigits("42")).toBe("42"); // 半角はそのまま

    const matches = extractSizeMatches("実行時に４２MBを落とす");
    expect(matches).toHaveLength(1);
    expect(matches[0].raw, "rawMatched相当は生の文字列を保つ").toBe("４２MB");
    expect(matches[0].num, "matched相当は正規化後の値").toBe("42");
  });

  // いまも残る検出漏れは、拾えないことを assert して固定する（受け入れた盲点。ADR 0212）。拾えるようにしたらこの it を書き換える。
  describe("SIZE_RE が意図的に検出しない残存の穴(⚠ 受け入れた盲点。埋める計画は無い)", () => {
    it("「42 メガバイト」のような漢字単位は拾えない", () => {
      expect(extractSizeMatches("実行時に42 メガバイトを落とす")).toEqual([]);
    });

    it("「0.042GB」のような別単位への換算は拾えない", () => {
      expect(extractSizeMatches("実行時に0.042GBを落とす")).toEqual([]);
    });

    it("「42Mb」(メガビット、小文字b)は意図的に射程外——別の単位", () => {
      expect(extractSizeMatches("回線速度は42Mbps")).toEqual([]);
      expect(extractSizeMatches("42Mb")).toEqual([]);
    });

    it("2桁以外の誤記(1桁・3桁)は、そもそも36/42という値として扱われない", () => {
      expect(extractSizeMatches("4MB")).toEqual([]);
      expect(extractSizeMatches("420MB")).toEqual([]);
    });
  });
});
