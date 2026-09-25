/**
 * 決定的な合成会話（PR 本文「量の比較」の再現性の要）。
 *
 * 実在の会話ログを使わない代わりに、固定の乱数無し生成関数を置く——同じ長さを指定すれば
 * 誰が実行しても同じ会話・同じ文字数になる。長さを変えて数点測る、という PR の要求は
 * これが無いと再現できない。
 */

export interface ConversationTurn {
  index: number;
  role: "user" | "assistant";
  text: string;
}

export interface Conversation {
  /** 事実の表明 + filler の往復。naive path はこれを丸ごとプロンプトへ積む。 */
  turns: ConversationTurn[];
  /** mnemora path が observe() する対象（user の発話のみ。決めたことは README 参照）。 */
  userUtterances: ConversationTurn[];
  /** 終盤に置く、冒頭の事実を参照する質問。recall() の query に使う。 */
  query: string;
}

/** 冒頭で一度だけ表明される、後から参照される事実。すべての会話長で共通に固定する。 */
export const FACT_STATEMENT = "私の好きな色は青です。誕生日は4月3日です。";
const FACT_ACK = "覚えておきますね。";
export const QUERY_TEXT = "ところで、わたしの好きな色を覚えていますか?";

/**
 * filler の生成規則（Issue #340）。
 *
 * **以前は12文の固定配列を `i % 12` で巡回していた**——320往復（`fillerPairs=320`）の
 * 会話では同じ文が最大約27回重複する。本物の embedding は同じ文字列に対して
 * bit-for-bit 一致するベクトルを返すため、大量の完全重複が連想枠（`maxCount`）の
 * tie-break に紛れ込み、`turnCount=322` 行の `mnemoraChars` を非決定にした
 * （[ADR 0170](../../../docs/decisions/0170-association-search-tiebreak-nondeterminism.md) §3）。
 *
 * **直し方**: 話題（名詞句）× 述語（文型）の直積で、`fillerIndex` ごとに異なる文を
 * 機械的に生成する——`probe-set.ts` の haystack が同じ理由（巡回ではなく直積で
 * 一意性を作る）で既に採っている方式を、ここにも適用した。話題は
 * {@link FILLER_TOPICS}（20件）、述語は {@link FILLER_USER_PREDICATES} /
 * {@link FILLER_ASSISTANT_PREDICATES}（各20件）——直積は 20×20=400 通りで、
 * `DEFAULT_COMPARE_SEQUENCE`（`compare.ts`）の最大 `fillerPairs=320` を余裕を持って
 * 超える。**話題・述語の選定は、カセットを録る前・結果を見る前に決めた**——
 * 特定の会話長の誤差が小さくなるように文を選ぶことはしていない（Issue #340
 * のコメントが却下した PR #683 の「選んだことによる偏り」と同じ理由で避けた）。
 * assistant 側の filler も同じ方式で一意にした——`ingestConversation`
 * （`mnemora-path.ts`）は `userUtterances`（user 発話のみ）しか `observe()` しないため
 * assistant の重複はこのバグに関与しないが、対称な規則にしておくほうが「なぜ片方だけ
 * 一意にしたか」を説明する負担が無い。
 *
 * ### ⚠ 訂正: `fillerIndex` から (話題, 述語) を選ぶ順序（1回目の録音後に直した）
 *
 * 話題・述語の**内容**（何文字・どんな文か）は録音前に決めて以降変えていない。
 * **変えたのは、`fillerIndex` を (topicIndex, predicateIndex) に分解する順序（実装の
 * 都合で選んだ軸の速さ）だけである**——最初は話題を速く（`fillerIndex %
 * FILLER_TOPICS.length`）・述語を遅く回していた。1回目の録音（実 API）を検算した
 * ところ、この順序では `fillerPairs` が20増えるごとにしか述語が切り替わらず、
 * **1つの述語が20個の話題すべてに対して連続して使われる**ことが分かった。
 * 述語には「これは記憶に値する事実か」を本物の LLM が判定する上で強く効くものが
 * あり（例: 「〜に取り組んでみようと思っています。」はほぼ毎回抽出されるが、
 * 「〜について話したいです。」は一度も抽出されない——20話題全部で確認した）、
 * **述語が遅く変わる順序では、`fillerPairs` の小さい範囲がまるごと同じ述語だけに
 * 支配され、スコープ内件数が「しばらく増えない→段差で急に増える」という不自然な
 * 階段状になった**（`totalInScope` が `fillerPairs<=20` の全域で一定のまま、
 * `fillerPairs=40` で急増）。これは**内容の選び方の問題ではなく、列挙順序という
 * 実装細部の問題**だったため、話題・述語の文面には一切手を触れず、
 * `fillerLine()` の軸の速さだけを入れ替えた（述語を速く・話題を遅く）——
 * 述語が20個変わるほうが先に一巡するので、`fillerPairs` が小さい範囲でも
 * 抽出されやすい述語・されにくい述語が早期に混ざる。この訂正のために
 * カセットを録り直した（PR 本文の実測回数を参照）。
 */
const FILLER_TOPICS = [
  "天気",
  "昼ご飯",
  "映画",
  "週末の予定",
  "新しい趣味",
  "仕事の進捗",
  "読んだ本",
  "旅行の計画",
  "運動不足",
  "最近のニュース",
  "料理のレシピ",
  "ペットの体調",
  "好きな音楽",
  "庭仕事",
  "買い物",
  "部屋の片付け",
  "資格の勉強",
  "好きなスポーツ",
  "出身地の話",
  "新しい家電",
];

const FILLER_USER_PREDICATES: ((topic: string) => string)[] = [
  (t) => `${t}について話したいです。`,
  (t) => `${t}のことが気になっています。`,
  (t) => `${t}のことでちょっと悩んでいます。`,
  (t) => `${t}についてどう思いますか。`,
  (t) => `${t}のことを最近よく考えます。`,
  (t) => `${t}についてもう少し知りたいです。`,
  (t) => `${t}のことが少し心配です。`,
  (t) => `${t}について詳しく教えてほしいです。`,
  (t) => `${t}のことを話題にしたいです。`,
  (t) => `${t}に興味があります。`,
  (t) => `${t}のことをふと思い出しました。`,
  (t) => `${t}について意見を聞かせてください。`,
  (t) => `${t}のことがずっと気になっています。`,
  (t) => `${t}に取り組んでみようと思っています。`,
  (t) => `${t}についての考えを聞きたいです。`,
  (t) => `${t}のことを相談したいです。`,
  (t) => `${t}について質問してもいいですか。`,
  (t) => `${t}のことをもう一度考え直しています。`,
  (t) => `${t}について感想を伝えたいです。`,
  (t) => `${t}のことをずっと迷っています。`,
];

const FILLER_ASSISTANT_PREDICATES: ((topic: string) => string)[] = [
  (t) => `${t}について、ぜひ聞かせてください。`,
  (t) => `${t}のこと、詳しく教えてもらえますか。`,
  (t) => `${t}は気になりますね。`,
  (t) => `${t}について、私も気になっていました。`,
  (t) => `${t}のこと、一緒に考えましょう。`,
  (t) => `${t}について、もう少し詳しく知りたいです。`,
  (t) => `${t}は心配ですね、無理しないでください。`,
  (t) => `${t}について、喜んでお答えします。`,
  (t) => `${t}の話、興味深いですね。`,
  (t) => `${t}に興味を持たれたんですね。`,
  (t) => `${t}のこと、思い出してよかったですね。`,
  (t) => `${t}について、率直な意見をお伝えします。`,
  (t) => `${t}のこと、気になり続けているんですね。`,
  (t) => `${t}に取り組むの、応援しています。`,
  (t) => `${t}についての考え、聞かせてください。`,
  (t) => `${t}のご相談、承ります。`,
  (t) => `${t}について、どうぞ質問してください。`,
  (t) => `${t}のこと、考え直すのは大事ですね。`,
  (t) => `${t}の感想、楽しみにしています。`,
  (t) => `${t}のこと、迷うのも無理ないですね。`,
];

/** {@link FILLER_TOPICS} × 述語の直積で表現できる一意な filler の総数。 */
const FILLER_CAPACITY = FILLER_TOPICS.length * FILLER_USER_PREDICATES.length;

/**
 * `fillerIndex`（0始まり）から一意な filler 文を1つ選ぶ。
 *
 * `fillerIndex = predicateIndex * FILLER_TOPICS.length + topicIndex` という基数
 * `FILLER_TOPICS.length` の位取りにしてあるため、`fillerIndex` が
 * `[0, FILLER_CAPACITY)` の範囲にある限り (topicIndex, predicateIndex) の組は
 * 重複しない——直積のどの升目も、ちょうど1つの `fillerIndex` に対応する。
 */
function fillerLine(
  fillerIndex: number,
  predicates: readonly ((topic: string) => string)[],
): string {
  if (fillerIndex >= FILLER_CAPACITY) {
    throw new Error(
      `fillerLine: fillerIndex(${fillerIndex}) が生成できる一意な filler の上限` +
        `（${FILLER_CAPACITY} = ${FILLER_TOPICS.length}話題 × ${predicates.length}述語）を超えた。` +
        "FILLER_TOPICS か述語の数を増やすこと。",
    );
  }
  const predicate = predicates[fillerIndex % predicates.length]!;
  const topic = FILLER_TOPICS[Math.floor(fillerIndex / predicates.length) % FILLER_TOPICS.length]!;
  return predicate(topic);
}

/**
 * `fillerPairs` 組の filler な user/assistant 往復を、冒頭の事実表明の後に積んだ会話を作る。
 *
 * @param fillerPairs filler の往復数。0以上の整数。
 */
export function buildConversation(fillerPairs: number): Conversation {
  if (!Number.isInteger(fillerPairs) || fillerPairs < 0) {
    throw new Error(
      `buildConversation: fillerPairs は 0 以上の整数である必要がある（実際: ${fillerPairs}）`,
    );
  }

  const turns: ConversationTurn[] = [];
  let index = 0;
  turns.push({ index: index++, role: "user", text: FACT_STATEMENT });
  turns.push({ index: index++, role: "assistant", text: FACT_ACK });
  for (let i = 0; i < fillerPairs; i += 1) {
    turns.push({
      index: index++,
      role: "user",
      text: fillerLine(i, FILLER_USER_PREDICATES),
    });
    turns.push({
      index: index++,
      role: "assistant",
      text: fillerLine(i, FILLER_ASSISTANT_PREDICATES),
    });
  }

  return {
    turns,
    userUtterances: turns.filter((t) => t.role === "user"),
    query: QUERY_TEXT,
  };
}
