/**
 * 門ではない。終了コードは測定結果を見ない（常に 0）。記録の再生が 0 件でも安全の証拠ではない（条件3〜6は試されていない）。
 * 判定の正規表現は本体が export していないので写している。ずれは本体との突き合わせで検知して先頭に出す。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectLanguageMismatch,
  LANGUAGE_MISMATCH_MIN_CONTENT_LATIN_LETTERS,
  LANGUAGE_MISMATCH_MIN_CONTENT_LOWERCASE_WORDS,
  LANGUAGE_MISMATCH_MIN_LATIN_SHARE,
  LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS,
  LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_SHARE,
} from "../../../../packages/core/src/language-mismatch.js";
import { observationPayloadText } from "../../../../packages/core/src/observation-text.js";
import type { Observation } from "../../../../packages/core/src/observation.js";
import { tryGitRevParseHead } from "../git-info.js";
import { BOUNDARY_CASES, type BoundaryLabel } from "./language-mismatch-boundary-cases.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..", "..");
const CASSETTE_DIR = join(REPO_ROOT, "examples", "chat", "cassettes");
const FIXTURE_DIR = join(REPO_ROOT, "packages", "core", "src", "__tests__", "fixtures");
const EXTRACTION_SYSTEM_PREFIX =
  "あなたは会話・イベント・文書から再利用可能な記憶を抽出するアシスタントです";

// 本体が export していないので、判定を写している。
const CJK = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
const LATIN = /(?=\p{L})\p{Script=Latin}/gu;
const LETTER = /\p{L}/gu;
const URL_PATTERN = /https?:\/\/\S+/gi;
const CODE_MARKER = /[`{}<>|\\]|&&|=>|(?:^|\s)--[a-z]|(?:^|\s)\.{0,2}\/[\w.-]+/;
const LOWERCASE_WORD_CORE = /^[a-z]+(?:'[a-z]+)?[.,!?;:]?$/;
const LOWERCASE_WORD_WIDE = (word: string): boolean =>
  /^[a-z]+(?:['’-][a-z]+)*$/.test(word.replace(/^[("“‘]+/, "").replace(/[.,!?;:)"”’]+$/, ""));

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

interface Params {
  minObsCjk: number;
  minObsShare: number;
  minLatin: number;
  minShare: number;
  minWords: number;
  isLowercaseWord: (word: string) => boolean;
}

const CORE_PARAMS: Params = {
  minObsCjk: LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_CHARS,
  minObsShare: LANGUAGE_MISMATCH_MIN_OBSERVATION_CJK_SHARE,
  minLatin: LANGUAGE_MISMATCH_MIN_CONTENT_LATIN_LETTERS,
  minShare: LANGUAGE_MISMATCH_MIN_LATIN_SHARE,
  minWords: LANGUAGE_MISMATCH_MIN_CONTENT_LOWERCASE_WORDS,
  isLowercaseWord: (word) => LOWERCASE_WORD_CORE.test(word),
};

const STAGES = ["1a", "1b", "2", "3", "4", "5", "6", "flag"] as const;
type Stage = (typeof STAGES)[number];

interface Verdict {
  stage: Stage;
  latinLetters: number;
  share: number;
}

function evaluate(observation: string, content: string, p: Params): Verdict {
  const obsCjk = count(observation, CJK);
  const verdict = (stage: Stage, latinLetters = 0, share = 0): Verdict => ({
    stage,
    latinLetters,
    share,
  });
  if (obsCjk < p.minObsCjk) return verdict("1a");
  const obsLatin = count(observation, LATIN);
  if (obsCjk / (obsCjk + obsLatin) < p.minObsShare) return verdict("1b");
  if (count(content, CJK) > 0) return verdict("2");
  if (CODE_MARKER.test(content)) return verdict("3");
  const prose = content.replace(URL_PATTERN, " ");
  const latinLetters = count(prose, LATIN);
  if (latinLetters < p.minLatin) return verdict("4", latinLetters);
  const share = latinLetters / count(prose, LETTER);
  if (share < p.minShare) return verdict("5", latinLetters, share);
  const words = prose.split(/\s+/).filter((w) => p.isLowercaseWord(w)).length;
  if (words < p.minWords) return verdict("6", latinLetters, share);
  return verdict("flag", latinLetters, share);
}

interface Disagreement {
  where: string;
  observation: string;
  content: string;
  mine: Verdict;
  coreFlagged: boolean;
}
const disagreements: Disagreement[] = [];
let crossChecked = 0;

function evaluateAndCrossCheck(where: string, observation: string, content: string): Verdict {
  const mine = evaluate(observation, content, CORE_PARAMS);
  const core = detectLanguageMismatch(observation, content);
  crossChecked += 1;
  const coreFlagged = core !== null;
  const same =
    (mine.stage === "flag") === coreFlagged &&
    (core === null ||
      (core.contentLatinLetters === mine.latinLetters &&
        core.contentLatinShare === Math.round(mine.share * 100) / 100));
  if (!same) disagreements.push({ where, observation, content, mine, coreFlagged });
  return mine;
}

interface Pair {
  observation: string;
  content: string;
}
interface Material {
  name: string;
  files: { path: string; responses: number; pairs: Pair[] }[];
}

interface CassetteEntry {
  prompt: { system: string; messages: { role: string; content: string }[] };
  value: { memories?: { content?: unknown }[] };
}

function loadCassettes(): Material {
  const files: Material["files"] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(CASSETTE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const path = join(CASSETTE_DIR, name);
    const json = JSON.parse(readFileSync(path, "utf8")) as {
      llm?: { entries?: Record<string, CassetteEntry> };
    };
    let responses = 0;
    const pairs: Pair[] = [];
    for (const entry of Object.values(json.llm?.entries ?? {})) {
      if (!entry.prompt.system.startsWith(EXTRACTION_SYSTEM_PREFIX)) continue;
      const key = JSON.stringify([entry.prompt.system, entry.prompt.messages, entry.value]);
      if (seen.has(key)) continue; // 同じ記録が別のカセットに複製されている
      seen.add(key);
      responses += 1;
      const observation = entry.prompt.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
      for (const memory of entry.value.memories ?? []) {
        if (typeof memory.content === "string")
          pairs.push({ observation, content: memory.content });
      }
    }
    if (responses > 0) files.push({ path: relative(REPO_ROOT, path), responses, pairs });
  }
  return { name: "カセット（examples/chat/cassettes/*.json の llm.entries）", files };
}

interface FixtureRun {
  response?: { message?: { content?: unknown } };
}
interface FixtureCase {
  observation: unknown;
  response?: FixtureRun["response"];
  runs?: FixtureRun[];
}

function loadFixtures(): Material {
  const files: Material["files"] = [];
  for (const name of readdirSync(FIXTURE_DIR)
    .filter((f) => /^extraction-context-.*recorded.*\.json$/.test(f))
    .sort()) {
    const path = join(FIXTURE_DIR, name);
    const json = JSON.parse(readFileSync(path, "utf8")) as {
      cases?: FixtureCase[];
      rows?: FixtureCase[];
    };
    const seen = new Set<string>();
    let responses = 0;
    const pairs: Pair[] = [];
    for (const c of json.cases ?? json.rows ?? []) {
      const observation = observationPayloadText(c.observation as Observation);
      const runs: FixtureRun[] = c.runs ?? [{ response: c.response }];
      for (const run of runs) {
        const raw = run.response?.message?.content;
        if (typeof raw !== "string") continue;
        const key = JSON.stringify([observation, raw]);
        if (seen.has(key)) continue;
        seen.add(key);
        responses += 1;
        const parsed = JSON.parse(raw) as { memories?: { content?: unknown }[] };
        for (const memory of parsed.memories ?? []) {
          if (typeof memory.content === "string") {
            pairs.push({ observation, content: memory.content });
          }
        }
      }
    }
    files.push({ path: relative(REPO_ROOT, path), responses, pairs });
  }
  return {
    name: "フィクスチャ（packages/core/src/__tests__/fixtures/extraction-context-*recorded*.json）",
    files,
  };
}

function row(cells: (string | number)[]): string {
  return `| ${cells.join(" | ")} |`;
}

function tallyMaterial(label: string, pairs: Pair[]): { fell: Record<Stage, number>; n: number } {
  const fell = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const pair of pairs) {
    fell[evaluateAndCrossCheck(label, pair.observation, pair.content).stage] += 1;
  }
  return { fell, n: pairs.length };
}

function printDistribution(materials: Material[]): void {
  console.log("## (a) 記録の再生での、実際に出た分布\n");
  console.log("数えた記録（パスと件数。実行のたびに数えている）:\n");
  console.log(row(["材料", "記録", "応答数", "memory 数（= 本文の数）"]));
  console.log(row(["---", "---", "---", "---"]));
  for (const m of materials) {
    for (const f of m.files)
      console.log(row([m.name.split("（")[0]!, f.path, f.responses, f.pairs.length]));
  }
  console.log("");
  console.log(
    "観測は、カセットでは `prompt.messages` の user の content、フィクスチャでは `observation.payload`",
  );
  console.log(
    "（`observationPayloadText`）。⚠ カセットの観測は近似（ADR 0554 の「近似の誤差」）。\n",
  );
  const header = ["材料", "N", ...STAGES.slice(0, 7).map((s) => `${s}で落ちた`), "印あり"];
  console.log(row(header));
  console.log(row(header.map(() => "---")));
  const total = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  let totalN = 0;
  for (const m of materials) {
    const { fell, n } = tallyMaterial(
      m.name,
      m.files.flatMap((f) => f.pairs),
    );
    console.log(row([m.name.split("（")[0]!, n, ...STAGES.map((s) => fell[s])]));
    for (const s of STAGES) total[s] += fell[s];
    totalN += n;
  }
  console.log(row(["合計", totalN, ...STAGES.map((s) => total[s])]));
  console.log("");
  console.log(`印が付いた件数 / N = ${total.flag} / ${totalN}`);
  let reaching = totalN;
  const reached: string[] = [];
  for (const s of STAGES.slice(0, 7)) {
    reached.push(`${s}: ${reaching}`);
    reaching -= total[s];
  }
  console.log(`各条件に到達した（その条件を実際に試された）件数: ${reached.join(" / ")}`);
  const untested = STAGES.slice(3, 7)
    .map((s, i) => ({ s, reached: Number(reached[i + 3]!.split(": ")[1]) }))
    .filter((x) => x.reached === 0)
    .map((x) => x.s);
  if (untested.length > 0) {
    console.log(
      `⚠ 条件 ${untested.join("・")} は、この材料では 1 件も試されていない。0 件は「安全」の証拠ではない。`,
    );
  }
  console.log("");
}

type Judgement = "一致" | "誤検出" | "取りこぼし" | "（判断が割れる）";
function judge(label: BoundaryLabel, flagged: boolean): Judgement {
  if (label === "split") return "（判断が割れる）";
  if (label === "should") return flagged ? "一致" : "取りこぼし";
  return flagged ? "誤検出" : "一致";
}
const LABEL_NAME: Record<BoundaryLabel, string> = {
  should: "付くべき",
  shouldNot: "付くべきでない",
  split: "割れる",
};

function printBoundary(): void {
  console.log("## (b) 境界の例と当たり方（⚠ 率ではない。手で作った入力）\n");
  const header = ["id", "ラテン文字", "割合", "本文", "ラベル", "落ちた条件", "判定"];
  console.log(row(header));
  console.log(row(header.map(() => "---")));
  const tally: Record<Judgement, number> = {
    一致: 0,
    誤検出: 0,
    取りこぼし: 0,
    "（判断が割れる）": 0,
  };
  for (const c of BOUNDARY_CASES) {
    const v = evaluateAndCrossCheck(`boundary:${c.id}`, c.observation, c.content);
    const j = judge(c.label, v.stage === "flag");
    tally[j] += 1;
    const reachedLatin =
      v.stage === "4" || v.stage === "5" || v.stage === "6" || v.stage === "flag";
    const latin = reachedLatin ? v.latinLetters : "-";
    const share =
      v.stage === "5" || v.stage === "6" || v.stage === "flag" ? v.share.toFixed(2) : "-";
    console.log(
      row([
        c.id,
        latin,
        share,
        `\`${c.content.replace(/\|/g, "\\|")}\``,
        LABEL_NAME[c.label],
        v.stage === "flag" ? "印あり" : `条件${v.stage}`,
        j,
      ]),
    );
  }
  console.log("");
  console.log(
    `入力 ${BOUNDARY_CASES.length} 件の内訳（率ではない）: 一致 ${tally["一致"]} / 誤検出 ${tally["誤検出"]} / 取りこぼし ${tally["取りこぼし"]} / 判断が割れる ${tally["（判断が割れる）"]}`,
  );
  console.log(
    "⚠ 入力は境界を突くために手で作った。この件数から取りこぼし率・偽陽性率は言えない。\n",
  );
}

function printSensitivity(materials: Material[]): void {
  console.log("## 基準を変えたとき、(b) のどの判定が入れ替わるか（材料。本体は変えていない）\n");
  const variants: { name: string; params: Params }[] = [
    ...[10, 15, 30].map((v) => ({
      name: `条件4 ラテン文字の下限 ${CORE_PARAMS.minLatin} → ${v}`,
      params: { ...CORE_PARAMS, minLatin: v },
    })),
    ...[2, 4, 5].map((v) => ({
      name: `条件6 小文字語の下限 ${CORE_PARAMS.minWords} → ${v}`,
      params: { ...CORE_PARAMS, minWords: v },
    })),
    ...[0.8, 0.95, 1].map((v) => ({
      name: `条件5 ラテン文字の割合 ${CORE_PARAMS.minShare} → ${v}`,
      params: { ...CORE_PARAMS, minShare: v },
    })),
    ...[2, 8].map((v) => ({
      name: `条件1a 観測のかな・漢字の下限 ${CORE_PARAMS.minObsCjk} → ${v}`,
      params: { ...CORE_PARAMS, minObsCjk: v },
    })),
    ...[0.2, 0.5].map((v) => ({
      name: `条件1b 観測のかな・漢字の割合 ${CORE_PARAMS.minObsShare} → ${v}`,
      params: { ...CORE_PARAMS, minObsShare: v },
    })),
    {
      name: "条件6 LOWERCASE_WORD を ’・囲み語・ハイフン語へ広げる",
      params: { ...CORE_PARAMS, isLowercaseWord: LOWERCASE_WORD_WIDE },
    },
  ];
  const base = BOUNDARY_CASES.map(
    (c) => evaluate(c.observation, c.content, CORE_PARAMS).stage === "flag",
  );
  const allPairs = materials.flatMap((m) => m.files.flatMap((f) => f.pairs));
  const countErrors = (flags: boolean[]): string => {
    let fp = 0;
    let miss = 0;
    BOUNDARY_CASES.forEach((c, i) => {
      const j = judge(c.label, flags[i]!);
      if (j === "誤検出") fp += 1;
      if (j === "取りこぼし") miss += 1;
    });
    return `誤検出 ${fp} / 取りこぼし ${miss}`;
  };
  console.log(
    `現行（比較の基準）: (b) の印あり ${base.filter(Boolean).length} 件、${countErrors(base)}\n`,
  );
  console.log(
    row([
      "変えたもの",
      "(a) の印あり",
      "(b) の印あり",
      "(b) の誤検出・取りこぼし",
      "判定が入れ替わった入力（現行→変更後）",
    ]),
  );
  console.log(row(["---", "---", "---", "---", "---"]));
  for (const v of variants) {
    const flags = BOUNDARY_CASES.map(
      (c) => evaluate(c.observation, c.content, v.params).stage === "flag",
    );
    const flips = BOUNDARY_CASES.flatMap((c, i) =>
      flags[i] === base[i]
        ? []
        : [`${c.id}（${LABEL_NAME[c.label]}。${base[i] ? "印あり→なし" : "なし→印あり"}）`],
    );
    const aFlagged = allPairs.filter(
      (p) => evaluate(p.observation, p.content, v.params).stage === "flag",
    ).length;
    console.log(
      row([
        v.name,
        `${aFlagged} / ${allPairs.length}`,
        flags.filter(Boolean).length,
        countErrors(flags),
        flips.length === 0 ? "なし" : flips.join("<br>"),
      ]),
    );
  }
  console.log("");
}

function main(): void {
  const commit = tryGitRevParseHead(REPO_ROOT);
  const materials = [loadCassettes(), loadFixtures()];
  const out: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => out.push(args.join(" "));
  printDistribution(materials);
  printBoundary();
  printSensitivity(materials);
  console.log = log;

  console.log("# 言語の事後検査（ADR 0391・0490）の測定 — ADR 0554");
  console.log(`測った commit: ${commit ?? "取れなかった"}`);
  console.log("⛔ 門ではない。終了コードは結果を見ない。数えた記録は下に名乗る。\n");
  if (disagreements.length > 0) {
    console.log("!".repeat(72));
    console.log(
      `!!! 本体との不一致が ${disagreements.length} 件 / 突き合わせ ${crossChecked} 件 !!!`,
    );
    console.log("!!! このスクリプトの判定の写しが、本体の detectLanguageMismatch とずれている。");
    console.log("!!! 以下の結果を信用しないこと。");
    for (const d of disagreements) {
      console.log(
        `!!!  ${d.where}: 本体=${d.coreFlagged ? "印あり" : "なし"} / 写し=${d.mine.stage} / 本文=${JSON.stringify(d.content)}`,
      );
    }
    console.log("!".repeat(72) + "\n");
  } else {
    console.log(
      `本体との突き合わせ: ${crossChecked} 件すべて一致（不一致 0 件。(a) と (b) の全入力で、最終判定と contentLatinLetters・contentLatinShare を比べた）\n`,
    );
  }
  for (const line of out) console.log(line);
}

main();
