/**
 * 意味的関連性の probe set。gold の質問は gold の事実と内容語を共有しない（擬似 embedding は語彙的な重なりしか持たないので、
 * 本物の埋め込みでしか引けない）。`lexicalControl: true` の1件だけ語彙が重なる対照群。
 * distractor は「同じ話題・違う主語/値」で、gold より上に来たら Recall@10 が緑でも中身は外れている。
 */
export interface Probe {
  id: string;
  fact: string;
  query: string;
  distractor: string;
  lexicalControl?: boolean;
}

export const PROBES: Probe[] = [
  {
    id: "color",
    fact: "私の好きな色は青です。誕生日は4月3日です。",
    query: "ところで、わたしの好きな色を覚えていますか?",
    distractor: "妹の好きな色は緑です。",
    lexicalControl: true,
  },
  {
    id: "pet",
    fact: "私は猫を2匹飼っています。",
    query: "うちのペットについて何か知っていますか?",
    distractor: "同僚は犬を3匹飼っています。",
  },
  {
    id: "exercise",
    fact: "毎朝5時に起きてジョギングをしています。",
    query: "私の運動の習慣はどんなものでしたか?",
    distractor: "父は毎晩ウォーキングをしています。",
  },
  {
    id: "diet",
    fact: "牛乳を飲むとお腹を壊します。",
    query: "私が避けたほうがいい食べ物はありますか?",
    distractor: "妻は卵アレルギーがあります。",
  },
  {
    id: "family",
    fact: "弟は札幌に住んでいます。",
    query: "私の家族はどこで暮らしていますか?",
    distractor: "姉は福岡で働いています。",
  },
  {
    id: "language",
    fact: "TypeScript より Rust のほうが好みです。",
    query: "私が一番気に入っているプログラミング言語は何ですか?",
    distractor: "同僚は Go を推しています。",
  },
  {
    id: "travel",
    fact: "来月、京都へ出張します。",
    query: "次の遠出の行き先はどこでしたか?",
    distractor: "先月は大阪へ出張しました。",
  },
];

/**
 * `scenario.ts` の filler（世間話）は使えない。実 API では `{"memories":[]}` が返り、干し草が消える。代わりに、本物の LLM が
 * 記憶として抽出する事実の表明を、3軸の直積で決定的に生成する。巡回だと同じ文が繰り返され、擬似 embedding が同一ベクトルになって
 * 順位付けの試験にならない。
 */
const HAYSTACK_TIME_CONTEXT = [
  "今日、",
  "昨日、",
  "先週、",
  "今週末に、",
  "午前中に、",
  "仕事の後で、",
  "休憩時間に、",
  "ふと思い立って、",
] as const;

const HAYSTACK_SUBJECT = [
  "市役所での住民票の再発行",
  "電子レンジの修理",
  "本棚に並べる参考書の購入",
  "玄関まわりの片付け",
  "溜まっていた郵便物の仕分け",
  "年末年始の飾り付けの準備",
  "自転車のパンク修理",
  "冷蔵庫の中の整理",
  "新しいボールペンとノートの購入",
  "洗濯機のフィルター掃除",
] as const;

const HAYSTACK_PREDICATE = [
  "を今日済ませました。",
  "を来週の予定に入れました。",
  "の見積もりを取りました。",
  "がようやく終わりました。",
  "を先延ばしにしていましたが着手しました。",
  "について調べているところです。",
  "を業者に依頼しました。",
  "を明日までに片付けるつもりです。",
] as const;

/** `DEFAULT_TICK_LIMIT` より大きい値にしてある。既定の `tick()` を1回呼ぶだけでは51件目以降が埋め込まれないまま残ることを、この benchmark 自身が踏んで見せるため。 */
export const DEFAULT_HAYSTACK_SIZE = 60;

export function buildHaystackUtterance(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `buildHaystackUtterance: index は 0 以上の整数である必要がある(実際: ${index})`,
    );
  }
  const subject = HAYSTACK_SUBJECT[index % HAYSTACK_SUBJECT.length]!;
  const predicate =
    HAYSTACK_PREDICATE[Math.floor(index / HAYSTACK_SUBJECT.length) % HAYSTACK_PREDICATE.length]!;
  const timeContext =
    HAYSTACK_TIME_CONTEXT[
      Math.floor(index / (HAYSTACK_SUBJECT.length * HAYSTACK_PREDICATE.length)) %
        HAYSTACK_TIME_CONTEXT.length
    ]!;
  return `${timeContext}${subject}${predicate}`;
}

/**
 * probe ごとの話題語。`PROBES` から自動導出しない（文全体の部分文字列一致にすると、「私」のような語まで話題語になり、
 * 検査として機能しない）。`PROBES` に probe を足したら、ここにも足すこと。
 */
export const PROBE_TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  color: ["色", "青", "緑"],
  pet: ["猫", "犬", "ペット"],
  exercise: ["ジョギング", "運動", "ウォーキング"],
  diet: ["牛乳", "お腹", "食べ物", "アレルギー", "卵"],
  family: ["弟", "姉", "兄", "妹", "父", "母", "家族", "札幌", "福岡", "住んで"],
  language: ["TypeScript", "Rust", "Go", "プログラミング言語"],
  travel: ["出張", "京都", "大阪", "旅行", "遠出"],
};

const ALL_TOPIC_KEYWORDS: string[] = Object.values(PROBE_TOPIC_KEYWORDS).flat();

export interface TopicKeywordViolation {
  index: number;
  text: string;
  keyword: string;
}

export function findTopicKeywordViolations(utterances: readonly string[]): TopicKeywordViolation[] {
  const violations: TopicKeywordViolation[] = [];
  utterances.forEach((text, index) => {
    for (const keyword of ALL_TOPIC_KEYWORDS) {
      if (text.includes(keyword)) {
        violations.push({ index, text, keyword });
      }
    }
  });
  return violations;
}

/** `"anchor"` を足しても既存の呼び出しの挙動は変わらない（どの集合も anchor を生成せず、`switch (u.kind)` も無い）。 */
export type ProbeUtteranceKind = "gold" | "distractor" | "haystack" | "anchor";

export interface ProbeUtterance {
  externalId: string;
  text: string;
  kind: ProbeUtteranceKind;
  probeId?: string;
}

/** `gold-<id>` の externalId 規約。`retrieval-quality.ts` の系譜追跡がこれに依存する。 */
export function goldExternalId(probeId: string): string {
  return `gold-${probeId}`;
}

export function distractorExternalId(probeId: string): string {
  return `distractor-${probeId}`;
}

export function haystackExternalId(index: number): string {
  return `filler-${String(index).padStart(4, "0")}`;
}

/**
 * 全 probe の gold/distractor + 共有の haystack を1本の会話に組む。haystack は probe 共通の1本にし、probe ごとには作らない
 * （probe ごとに別テナントにすると、実 API を probe 数倍叩くことになり、複数の話題が同じスコープに同居する状況も検査できなくなる）。
 * gold の直後に同じ probe の distractor を置く（生成時刻がほぼ同時になり、順位差は decay/freshness ではなく類似度由来だと言える）。
 */
export function buildProbeSetConversation(
  haystackSize: number = DEFAULT_HAYSTACK_SIZE,
): ProbeUtterance[] {
  const utterances: ProbeUtterance[] = [];
  for (const probe of PROBES) {
    utterances.push({
      externalId: goldExternalId(probe.id),
      text: probe.fact,
      kind: "gold",
      probeId: probe.id,
    });
    utterances.push({
      externalId: distractorExternalId(probe.id),
      text: probe.distractor,
      kind: "distractor",
      probeId: probe.id,
    });
  }

  const haystackTexts: string[] = [];
  for (let i = 0; i < haystackSize; i += 1) {
    haystackTexts.push(buildHaystackUtterance(i));
  }
  const violations = findTopicKeywordViolations(haystackTexts);
  if (violations.length > 0) {
    throw new Error(
      "buildProbeSetConversation: haystack が probe の話題語と重なっている " +
        `(${violations.length}件): ${JSON.stringify(violations.slice(0, 5))}`,
    );
  }
  haystackTexts.forEach((text, i) => {
    utterances.push({ externalId: haystackExternalId(i), text, kind: "haystack" });
  });

  return utterances;
}
