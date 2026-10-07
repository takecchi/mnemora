import type { ProbeUtterance } from "./probe-set.js";
import { DEFAULT_HAYSTACK_SIZE, buildHaystackUtterance } from "./probe-set.js";

/**
 * 識別子・固有名詞を含む probe set。`./probe-set.js` と狙いが逆で、query に識別子そのものを含め、
 * distractor は「同じ書式・違う識別子」にする（gold より上に来たら、書式は合うが対象が違うものを返している）。
 * カセットではなく `@mnemora/local-embedding` を使うのは、カセットの鍵が入力文字列の SHA-256 で、probe を足すたびに録り直しが要るため。
 * 12件の標本から、識別子一般の成功率は統計的に主張しない（ADR 0033 §3）。
 */
export interface IdentifierProbe {
  id: string;
  category: "person" | "channel" | "system" | "project-code" | "ticket";
  fact: string;
  query: string;
  distractor: string;
}

export const IDENTIFIER_PROBES: IdentifierProbe[] = [
  {
    id: "project-code-a",
    category: "project-code",
    fact: "PROJ-1234 の要件定義は来週までに終わらせる予定です。",
    query: "PROJ-1234 の要件定義はいつ終わりますか?",
    distractor: "PROJ-5678 の要件定義はまだ着手していません。",
  },
  {
    id: "project-code-b",
    category: "project-code",
    fact: "PROJ-9021 の予算は300万円で承認されました。",
    query: "PROJ-9021 の予算はいくらで承認されましたか?",
    distractor: "PROJ-9042 の予算は500万円で承認されました。",
  },
  {
    id: "project-code-c",
    category: "project-code",
    fact: "PROJ-3101 の要件レビューは金曜日に予定されています。",
    query: "PROJ-3101 の要件レビューはいつ予定されていますか?",
    distractor: "PROJ-3102 の要件レビューは月曜日に予定されています。",
  },
  {
    id: "project-code-d",
    category: "project-code",
    fact: "PROJ-3201 の担当ベンダーは株式会社アルファです。",
    query: "PROJ-3201 の担当ベンダーはどこですか?",
    distractor: "PROJ-3202 の担当ベンダーは株式会社ベータです。",
  },
  {
    id: "project-code-e",
    category: "project-code",
    fact: "PROJ-3301 のキックオフは来月の第1営業日です。",
    query: "PROJ-3301 のキックオフはいつですか?",
    distractor: "PROJ-3302 のキックオフは今月の最終営業日です。",
  },
  {
    id: "project-code-f",
    category: "project-code",
    fact: "PROJ-3401 のリリース判定会議は品質保証部が主催します。",
    query: "PROJ-3401 のリリース判定会議はどこが主催しますか?",
    distractor: "PROJ-3402 のリリース判定会議は開発部が主催します。",
  },
  {
    id: "ticket-a",
    category: "ticket",
    fact: "TICKET-48213 はログイン画面が表示されない不具合の報告です。",
    query: "TICKET-48213 はどんな不具合の報告でしたか?",
    distractor: "TICKET-48214 はログアウトができない不具合の報告です。",
  },
  {
    id: "ticket-b",
    category: "ticket",
    fact: "INC-77021 は本番環境の障害チケットで、対応者は山田さんです。",
    query: "INC-77021 の対応者は誰ですか?",
    distractor: "INC-77022 はステージング環境の障害チケットで、対応者は伊藤さんです。",
  },
  {
    id: "ticket-c",
    category: "ticket",
    fact: "TICKET-51001 は決済画面でエラーが出るという不具合の報告です。",
    query: "TICKET-51001 はどんな不具合の報告でしたか?",
    distractor: "TICKET-51002 は検索結果が表示されないという不具合の報告です。",
  },
  {
    id: "ticket-d",
    category: "ticket",
    fact: "TICKET-51101 は優先度「高」でサポートチームに割り当てられています。",
    query: "TICKET-51101 の優先度は何ですか?",
    distractor: "TICKET-51102 は優先度「低」でサポートチームに割り当てられています。",
  },
  {
    id: "ticket-e",
    category: "ticket",
    fact: "INC-81001 は本番データベースの障害チケットで、対応者は加藤さんです。",
    query: "INC-81001 の対応者は誰ですか?",
    distractor: "INC-81002 は検証環境の障害チケットで、対応者は木村さんです。",
  },
  {
    id: "ticket-f",
    category: "ticket",
    fact: "INC-81101 は深夜帯に発生した障害チケットで、現在は復旧済みです。",
    query: "INC-81101 は現在どういう状態ですか?",
    distractor: "INC-81102 は日中に発生した障害チケットで、現在も調査中です。",
  },
  {
    id: "system-a",
    category: "system",
    fact: "社内システム SYS-AT01(勤怠管理)の管理者は佐藤さんです。",
    query: "SYS-AT01 の管理者は誰ですか?",
    distractor: "社内システム SYS-EX02(経費精算)の管理者は鈴木さんです。",
  },
  {
    id: "system-b",
    category: "system",
    fact: "社内システム SYS-HR07(人事評価)は今月末にメンテナンス予定です。",
    query: "SYS-HR07 はいつメンテナンス予定ですか?",
    distractor: "社内システム SYS-CR09(顧客管理)は来月末にメンテナンス予定です。",
  },
  {
    id: "system-c",
    category: "system",
    fact: "社内システム SYS-PM11(プロジェクト管理)の管理者は田中さんです。",
    query: "SYS-PM11 の管理者は誰ですか?",
    distractor: "社内システム SYS-PM12(プロジェクト管理・旧版)の管理者は松本さんです。",
  },
  {
    id: "system-d",
    category: "system",
    fact: "社内システム SYS-LG21(ログ収集)は毎晩0時にバッチ処理が走ります。",
    query: "SYS-LG21 のバッチ処理はいつ走りますか?",
    distractor: "社内システム SYS-LG22(ログ集計・旧版)は毎朝6時にバッチ処理が走ります。",
  },
  {
    id: "system-e",
    category: "system",
    fact: "社内システム SYS-BI31(経営ダッシュボード)の管理者は情報システム部です。",
    query: "SYS-BI31 の管理者はどこですか?",
    distractor: "社内システム SYS-BI32(経営ダッシュボード・旧版)の管理者は経営企画部です。",
  },
  {
    id: "system-f",
    category: "system",
    fact: "社内システム SYS-DW41(データ基盤)は来週金曜にメンテナンス予定です。",
    query: "SYS-DW41 はいつメンテナンス予定ですか?",
    distractor: "社内システム SYS-DW42(データ基盤・検証環境)は来週月曜にメンテナンス予定です。",
  },
  {
    id: "channel-a",
    category: "channel",
    fact: "#proj-alpha チャンネルは新商品開発チームの連絡用です。",
    query: "#proj-alpha チャンネルは何のためのものですか?",
    distractor: "#proj-beta チャンネルは旧商品保守チームの連絡用です。",
  },
  {
    id: "channel-b",
    category: "channel",
    fact: "#team-fizz は東京オフィスの雑談チャンネルです。",
    query: "#team-fizz はどこのオフィスの雑談チャンネルですか?",
    distractor: "#team-buzz は大阪オフィスの雑談チャンネルです。",
  },
  {
    id: "channel-c",
    category: "channel",
    fact: "#incident-2024-08 は8月に起きた障害の振り返り専用チャンネルです。",
    query: "#incident-2024-08 は何のための専用チャンネルですか?",
    distractor: "#incident-2024-09 は9月に起きた障害の振り返り専用チャンネルです。",
  },
  {
    id: "channel-d",
    category: "channel",
    fact: "#proj-iota チャンネルは基盤刷新プロジェクトの連絡用です。",
    query: "#proj-iota チャンネルは何のためのものですか?",
    distractor: "#proj-kappa チャンネルは基盤刷新プロジェクトの後継検討用です。",
  },
  {
    id: "channel-e",
    category: "channel",
    fact: "#team-plugh は福岡オフィスの雑談チャンネルです。",
    query: "#team-plugh はどこのオフィスの雑談チャンネルですか?",
    distractor: "#team-xyzzy は名古屋オフィスの雑談チャンネルです。",
  },
  {
    id: "channel-f",
    category: "channel",
    fact: "#incident-2025-01 は1月に起きた障害の振り返り専用チャンネルです。",
    query: "#incident-2025-01 は何のための専用チャンネルですか?",
    distractor: "#incident-2025-02 は2月に起きた障害の振り返り専用チャンネルです。",
  },
  {
    id: "person-a",
    category: "person",
    fact: "従業員番号 EMP-1042 の担当者は経理部の高橋さんです。",
    query: "従業員番号 EMP-1042 の担当者は誰ですか?",
    distractor: "従業員番号 EMP-1043 の担当者は総務部の渡辺さんです。",
  },
  {
    id: "person-b",
    category: "person",
    fact: "従業員番号 EMP-2088 の担当者は開発部の中村さんです。",
    query: "従業員番号 EMP-2088 の担当者は誰ですか?",
    distractor: "従業員番号 EMP-2089 の担当者は営業部の小林さんです。",
  },
  {
    id: "person-c",
    category: "person",
    fact: "Slack ハンドル @yamada.taro は経理部の山田太郎さんのアカウントです。",
    query: "Slack ハンドル @yamada.taro は誰のアカウントですか?",
    distractor: "Slack ハンドル @yamada.jiro は総務部の山田次郎さんのアカウントです。",
  },
  {
    id: "person-d",
    category: "person",
    fact: "従業員番号 EMP-3301 の担当者は法務部の斎藤さんです。",
    query: "従業員番号 EMP-3301 の担当者は誰ですか?",
    distractor: "従業員番号 EMP-3302 の担当者は広報部の橋本さんです。",
  },
  {
    id: "person-e",
    category: "person",
    fact: "従業員番号 EMP-4401 の担当者は情報システム部の石井さんです。",
    query: "従業員番号 EMP-4401 の担当者は誰ですか?",
    distractor: "従業員番号 EMP-4402 の担当者は品質保証部の清水さんです。",
  },
  {
    id: "person-f",
    category: "person",
    fact: "Slack ハンドル @kobayashi.ichiro は開発部の小林一郎さんのアカウントです。",
    query: "Slack ハンドル @kobayashi.ichiro は誰のアカウントですか?",
    distractor: "Slack ハンドル @kobayashi.jiro は営業部の小林次郎さんのアカウントです。",
  },
];

/**
 * probe ごとの識別子。`./probe-set.js` の `PROBE_TOPIC_KEYWORDS` と同じ理由で、`IDENTIFIER_PROBES` から
 * 自動導出せず人手で書き出す。probe を足したらここにも足すこと。
 */
export const IDENTIFIER_TOPIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "project-code-a": ["PROJ-1234", "PROJ-5678"],
  "project-code-b": ["PROJ-9021", "PROJ-9042"],
  "project-code-c": ["PROJ-3101", "PROJ-3102"],
  "project-code-d": ["PROJ-3201", "PROJ-3202"],
  "project-code-e": ["PROJ-3301", "PROJ-3302"],
  "project-code-f": ["PROJ-3401", "PROJ-3402"],
  "ticket-a": ["TICKET-48213", "TICKET-48214"],
  "ticket-b": ["INC-77021", "INC-77022"],
  "ticket-c": ["TICKET-51001", "TICKET-51002"],
  "ticket-d": ["TICKET-51101", "TICKET-51102"],
  "ticket-e": ["INC-81001", "INC-81002"],
  "ticket-f": ["INC-81101", "INC-81102"],
  "system-a": ["SYS-AT01", "SYS-EX02"],
  "system-b": ["SYS-HR07", "SYS-CR09"],
  "system-c": ["SYS-PM11", "SYS-PM12"],
  "system-d": ["SYS-LG21", "SYS-LG22"],
  "system-e": ["SYS-BI31", "SYS-BI32"],
  "system-f": ["SYS-DW41", "SYS-DW42"],
  "channel-a": ["#proj-alpha", "#proj-beta"],
  "channel-b": ["#team-fizz", "#team-buzz"],
  "channel-c": ["#incident-2024-08", "#incident-2024-09"],
  "channel-d": ["#proj-iota", "#proj-kappa"],
  "channel-e": ["#team-plugh", "#team-xyzzy"],
  "channel-f": ["#incident-2025-01", "#incident-2025-02"],
  "person-a": ["EMP-1042", "EMP-1043"],
  "person-b": ["EMP-2088", "EMP-2089"],
  "person-c": ["@yamada.taro", "@yamada.jiro"],
  "person-d": ["EMP-3301", "EMP-3302"],
  "person-e": ["EMP-4401", "EMP-4402"],
  "person-f": ["@kobayashi.ichiro", "@kobayashi.jiro"],
};

const ALL_IDENTIFIER_KEYWORDS: string[] = Object.values(IDENTIFIER_TOPIC_KEYWORDS).flat();

export interface IdentifierKeywordViolation {
  index: number;
  text: string;
  keyword: string;
}

/**
 * haystack の各文が `IDENTIFIER_PROBES` の識別子を偶然含んでいないかを見る。`./probe-set.js` の
 * `findTopicKeywordViolations` はキーワード集合を内部に固定していて呼べないため、独立に実装する。
 */
export function findIdentifierTopicKeywordViolations(
  utterances: readonly string[],
): IdentifierKeywordViolation[] {
  const violations: IdentifierKeywordViolation[] = [];
  utterances.forEach((text, index) => {
    for (const keyword of ALL_IDENTIFIER_KEYWORDS) {
      if (text.includes(keyword)) {
        violations.push({ index, text, keyword });
      }
    }
  });
  return violations;
}

// 密な haystack: `sparse` は同じ書式の競合が distractor 1件しか無く、「近傍に来て埋もれる」状況を表せないので足した。
// 件数と識別子の値は測定前に固定した。結果を見てから難しくするために書き直さない。

export type IdentifierHaystackKind = "sparse" | "dense";

interface DenseIdentifierFamily {
  id: string;
  count: number;
  identifierAt: (n: number) => string;
  sentenceFor: (identifier: string) => string;
}

/**
 * `IDENTIFIER_PROBES` が使う書式ファミリーごとに、probe が使っていない値で干し草を作る。
 * 値域が重ならないことは、`buildIdentifierProbeSetConversation` が実行時にも再検査する。
 */
const DENSE_IDENTIFIER_FAMILIES: readonly DenseIdentifierFamily[] = [
  {
    id: "project-code",
    count: 8,
    identifierAt: (n) => `PROJ-${2001 + n}`,
    sentenceFor: (id) => `${id} の進捗確認ミーティングは来週に設定されました。`,
  },
  {
    id: "ticket",
    count: 8,
    identifierAt: (n) => `TICKET-${60001 + n}`,
    sentenceFor: (id) => `${id} は担当者未定のまま一次受付だけ済んでいます。`,
  },
  {
    id: "incident",
    count: 8,
    identifierAt: (n) => `INC-${90001 + n}`,
    sentenceFor: (id) => `${id} は影響範囲の調査が完了し、復旧対応に移りました。`,
  },
  {
    id: "system",
    count: 6,
    identifierAt: (n) => `SYS-QA${String(n + 1).padStart(2, "0")}`,
    sentenceFor: (id) => `社内システム ${id} は来期にバージョンアップが予定されています。`,
  },
  {
    id: "employee",
    count: 6,
    identifierAt: (n) => `EMP-${5001 + n}`,
    sentenceFor: (id) => `従業員番号 ${id} は先月付けで部署異動になりました。`,
  },
  {
    id: "proj-channel",
    count: 6,
    identifierAt: (n) => `#proj-${["gamma", "delta", "epsilon", "zeta", "eta", "theta"][n % 6]}`,
    sentenceFor: (id) => `${id} チャンネルには週次の定例議事録が投稿されています。`,
  },
  {
    id: "team-channel",
    count: 6,
    identifierAt: (n) => `#team-${["quux", "corge", "grault", "garply", "waldo", "fred"][n % 6]}`,
    sentenceFor: (id) => `${id} チャンネルは他部署合同の情報共有に使われています。`,
  },
  {
    id: "incident-channel",
    count: 6,
    identifierAt: (n) => `#incident-2024-${String(n + 1).padStart(2, "0")}`,
    sentenceFor: (id) => `${id} は該当月に発生した軽微な障害の記録用チャンネルです。`,
  },
  {
    id: "handle",
    count: 6,
    identifierAt: (n) =>
      `@${
        [
          "suzuki.saburo",
          "tanaka.shiro",
          "sato.goro",
          "ito.rokuro",
          "watanabe.shichiro",
          "nakamura.hachiro",
        ][n % 6]
      }`,
    sentenceFor: (id) => `Slack ハンドル ${id} は最近入社したメンバーのアカウントです。`,
  },
];

export const DEFAULT_DENSE_HAYSTACK_SIZE: number = DENSE_IDENTIFIER_FAMILIES.reduce(
  (sum, f) => sum + f.count,
  0,
);

export function buildDenseIdentifierHaystackUtterance(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `buildDenseIdentifierHaystackUtterance: index は0以上の整数である必要がある(実際: ${index})`,
    );
  }
  let remaining = index;
  for (const family of DENSE_IDENTIFIER_FAMILIES) {
    if (remaining < family.count) {
      const identifier = family.identifierAt(remaining);
      return family.sentenceFor(identifier);
    }
    remaining -= family.count;
  }
  throw new Error(
    `buildDenseIdentifierHaystackUtterance: index ${index} が総件数 ` +
      `${DEFAULT_DENSE_HAYSTACK_SIZE} を超えている`,
  );
}

/** `./probe-set.js` の `gold-<id>` と衝突しないよう別の prefix を使う（テナントを跨いだ誤集計を防ぐ）。 */
export function identifierGoldExternalId(probeId: string): string {
  return `identifier-gold-${probeId}`;
}

export function identifierDistractorExternalId(probeId: string): string {
  return `identifier-distractor-${probeId}`;
}

export function identifierHaystackExternalId(index: number): string {
  return `identifier-filler-${String(index).padStart(4, "0")}`;
}

/**
 * 全 identifier probe の gold/distractor + 共有の haystack を1本の会話に組む。
 * 既定は `"sparse"` で、引数を渡さない既存の呼び出しの挙動は変えない。どちらの kind でも識別子の重なり検査は必ず通す。
 */
export function buildIdentifierProbeSetConversation(
  haystackSize?: number,
  haystackKind: IdentifierHaystackKind = "sparse",
): ProbeUtterance[] {
  const utterances: ProbeUtterance[] = [];
  for (const probe of IDENTIFIER_PROBES) {
    utterances.push({
      externalId: identifierGoldExternalId(probe.id),
      text: probe.fact,
      kind: "gold",
      probeId: probe.id,
    });
    utterances.push({
      externalId: identifierDistractorExternalId(probe.id),
      text: probe.distractor,
      kind: "distractor",
      probeId: probe.id,
    });
  }

  const resolvedSize =
    haystackSize ??
    (haystackKind === "dense" ? DEFAULT_DENSE_HAYSTACK_SIZE : DEFAULT_HAYSTACK_SIZE);
  const buildUtterance =
    haystackKind === "dense" ? buildDenseIdentifierHaystackUtterance : buildHaystackUtterance;

  const haystackTexts: string[] = [];
  for (let i = 0; i < resolvedSize; i += 1) {
    haystackTexts.push(buildUtterance(i));
  }
  const violations = findIdentifierTopicKeywordViolations(haystackTexts);
  if (violations.length > 0) {
    throw new Error(
      `buildIdentifierProbeSetConversation: haystack(${haystackKind}) が識別子 probe の` +
        `識別子と重なっている(${violations.length}件): ${JSON.stringify(violations.slice(0, 5))}`,
    );
  }
  haystackTexts.forEach((text, i) => {
    utterances.push({ externalId: identifierHaystackExternalId(i), text, kind: "haystack" });
  });

  return utterances;
}
