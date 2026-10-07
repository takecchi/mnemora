export interface ConversationTurn {
  index: number;
  role: "user" | "assistant";
  text: string;
}

export interface Conversation {
  turns: ConversationTurn[];
  userUtterances: ConversationTurn[];
  query: string;
}

export const FACT_STATEMENT = "私の好きな色は青です。誕生日は4月3日です。";
const FACT_ACK = "覚えておきますね。";
export const QUERY_TEXT = "ところで、わたしの好きな色を覚えていますか?";

const FILLER_USER_LINES = [
  "今日はいい天気ですね。",
  "お昼ご飯は何を食べようか迷っています。",
  "最近見た映画の感想を話したいです。",
  "週末は友達と出かける予定です。",
  "新しい趣味を始めようと思っています。",
  "仕事の進捗について相談したいことがあります。",
  "最近読んだ本がとても面白かったです。",
  "旅行の計画を立てています。",
  "運動不足を感じているので何か始めたいです。",
  "最近のニュースについてどう思いますか。",
  "料理のレシピを教えてほしいです。",
  "ペットの調子があまり良くないので心配です。",
];

const FILLER_ASSISTANT_LINES = [
  "そうですね、良い一日になりそうです。",
  "軽めのものはいかがでしょうか。",
  "ぜひ聞かせてください。",
  "楽しんできてくださいね。",
  "それは良い挑戦だと思います。",
  "詳しく教えていただけますか。",
  "どんな内容の本でしたか。",
  "どこへ行く予定ですか。",
  "軽い運動から始めるのがおすすめです。",
  "どのニュースのことでしょうか。",
  "得意な食材はありますか。",
  "早めに病院で診てもらうと安心です。",
];

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
      text: FILLER_USER_LINES[i % FILLER_USER_LINES.length]!,
    });
    turns.push({
      index: index++,
      role: "assistant",
      text: FILLER_ASSISTANT_LINES[i % FILLER_ASSISTANT_LINES.length]!,
    });
  }

  return {
    turns,
    userUtterances: turns.filter((t) => t.role === "user"),
    query: QUERY_TEXT,
  };
}
