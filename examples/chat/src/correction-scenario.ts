/**
 * 訂正を含む会話シナリオ。「間違いを正すと、古いほうが先に出てこなくなる」を `examples/chat` から実演する。
 *
 * 矛盾の判定はこのファイルが構造として宣言する（ADR 0134 決定2）。`contestedPair` は書いた時点で固定された宣言で、
 * LLM にもヒューリスティクスにも聞かない。「後のほうが勝つ」という順序規則も使わない。
 * `resolution.winnerId` は訂正側を name で指し、`turns` の並び順や `recordedAt` の大小からは導かない。
 *
 * 北極星の主測定（`compare`/`retrieval`）には関わらない。測定条件を一切共有しない独立したデモとして、
 * `compare.ts`/`compare-json.ts`/`scenario.ts`/`probe-set.ts`/`naive-path.ts` を import しない。
 * `__tests__/correction-scenario-compare-isolation.test.ts` が機械的に確かめている。
 */

export interface CorrectionTurn {
  index: number;
  role: "user" | "assistant";
  text: string;
}

export interface CorrectionStatement {
  externalId: string;
  text: string;
}

/**
 * 「この2件は対向する」という、呼び出し側が既に下した決定そのもの（ADR 0134 決定2）。
 *
 * `firstExternalId`/`secondExternalId` の並び順に意味を持たせない。`markContested` 自身が対称な操作で、
 * この宣言も「どの2件が組か」だけを運ぶ。
 *
 * `winnerExternalId` も宣言の一部として構造で持つ（ADR 0150 決定1）。順序規則からは導かず、シナリオが決め打った値を
 * `correction-demo.ts` がそのまま渡す。
 */
export interface ContestedPairDeclaration {
  firstExternalId: string;
  secondExternalId: string;
  winnerExternalId: string;
}

export interface CorrectionScenario {
  turns: CorrectionTurn[];
  original: CorrectionStatement;
  /** 訂正の発話。`resolveContested` で勝たせる側（このシナリオが決め打つ）。 */
  correction: CorrectionStatement;
  contestedPair: ContestedPairDeclaration;
  query: string;
}

const FILLER_BEFORE = ["今日はいい天気ですね。", "お昼ご飯は何を食べようか迷っています。"];

const FILLER_BETWEEN = ["最近見た映画の感想を話したいです。", "週末は友達と出かける予定です。"];

const FILLER_ASSISTANT = [
  "そうですね、良い一日になりそうです。",
  "軽めのものはいかがでしょうか。",
  "ぜひ聞かせてください。",
  "楽しんできてくださいね。",
];

const ORIGINAL_EXTERNAL_ID = "correction-demo-original-favorite-color";
const CORRECTION_EXTERNAL_ID = "correction-demo-corrected-favorite-color";

const ORIGINAL_TEXT = "私の好きな色は青です。";
/**
 * 訂正の発話。「後のほうが勝つ」から勝つのではなく、`contestedPair`/`resolution` が明示的に勝者として指定しているから勝つ。
 * 宣言を逆にすれば `original` が勝ち残る（`correction-demo.test.ts`）。
 */
const CORRECTION_TEXT = "訂正します。よく考えたら、好きな色は青ではなく赤でした。";

const QUERY_TEXT = "わたしの好きな色を覚えていますか?";

function buildTurns(): CorrectionTurn[] {
  const turns: CorrectionTurn[] = [];
  let index = 0;
  const push = (role: CorrectionTurn["role"], text: string) => {
    turns.push({ index: index++, role, text });
  };

  push("user", FILLER_BEFORE[0]!);
  push("assistant", FILLER_ASSISTANT[0]!);
  push("user", ORIGINAL_TEXT);
  push("assistant", "覚えておきますね。");
  push("user", FILLER_BEFORE[1]!);
  push("assistant", FILLER_ASSISTANT[1]!);
  push("user", FILLER_BETWEEN[0]!);
  push("assistant", FILLER_ASSISTANT[2]!);
  push("user", CORRECTION_TEXT);
  push("assistant", "承知しました。訂正を反映します。");
  push("user", FILLER_BETWEEN[1]!);
  push("assistant", FILLER_ASSISTANT[3]!);

  return turns;
}

/** 固定のシナリオ本体。同じ長さ・同じ発話で毎回同じ結果になる。 */
export const CORRECTION_SCENARIO: CorrectionScenario = {
  turns: buildTurns(),
  original: { externalId: ORIGINAL_EXTERNAL_ID, text: ORIGINAL_TEXT },
  correction: { externalId: CORRECTION_EXTERNAL_ID, text: CORRECTION_TEXT },
  contestedPair: {
    firstExternalId: ORIGINAL_EXTERNAL_ID,
    secondExternalId: CORRECTION_EXTERNAL_ID,
    winnerExternalId: CORRECTION_EXTERNAL_ID,
  },
  query: QUERY_TEXT,
};
