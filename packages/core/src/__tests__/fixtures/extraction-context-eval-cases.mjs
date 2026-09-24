// Issue #689 独立意味評価のケース定義。
//
// ⚠ これは「実装を見て調整した開発ケース」ではない。このファイルは
// Issue #689 本文の完了条件だけを読んで書き、commit してから
// `scripts/record-extraction-context-eval.mjs` で実 API を1回叩いて録音した
// （録音後にこのファイルの期待値・入力を結果に合わせて直していない — git 履歴の
// commit 順序がそれを示す: このファイルの commit が先、録音の commit が後）。
//
// 開発ケース（`extraction-context-recorded.json`、id: reference / relative-date /
// other-speaker）とは文面・話題を変えている。tenantId も別にしてある
// （`context-eval-independent`）。
//
// 判定はここでは行わない。ここは「入力・期待値・根拠」の定義だけを持つ。
// 判定（機械的な包含/非包含/日付正規表現）は
// `packages/core/src/__tests__/extraction-context-eval.test.ts` が、録音済みの
// `extraction-context-recorded.eval.json` に対して行う。
//
// Issue #689 の完了条件からの引用（本文そのまま）:
//   - 「文脈内の他人の発話を当該話者の stated として取り込まない。」→ category "c"
//   - 「文脈不足なら対象や日時を捏造しない。」→ category "d"
//   - 「会話の参照先・話者・観測日時が抽出に渡らず、「それでお願いします」「明日」の
//      意味を確定できない。」（問題節）→ category "a"（参照先）・"b"（観測日時）

/** @typedef {{ speaker?: string; text: string }} ContextMessage */

/**
 * @typedef {object} EvalCase
 * @property {string} id
 * @property {"a-contextual-reference"|"b-relative-date"|"c-other-speaker"|"d-no-context-no-fabrication"} category
 * @property {string} rationale
 * @property {object} input
 * @property {string} input.subjectId
 * @property {string} input.speaker
 * @property {string} input.text
 * @property {string|null} input.occurredAt ISO string、null なら observation.occurredAt を省略する
 * @property {string|null} input.timeZone null なら extractionContext.timeZone を省略する（extractionContext
 *   自体は常に存在させる。省略時と空の違いは ADR 0299 のケース4「文脈なし」と同じ ── `{}` も
 *   明示的な有効化として扱う）
 * @property {ContextMessage[]|null} input.contextMessages null なら extractionContext.messages を省略する。
 *   [] なら空配列として明示する（b系: 相対日時だけを見たいので参照文脈は無くす）。値があれば
 *   その配列をそのまま使う
 * @property {object} expect
 * @property {string[]} expect.includes すべて digest+content 結合文字列に含まれること
 * @property {string[]} expect.excludes すべて digest+content 結合文字列に含まれないこと
 * @property {RegExp|null} expect.dateMatch マッチすること（解決された暦日が出典されていること）
 * @property {RegExp|null} expect.dateMustNotMatch マッチしないこと（捏造された暦日が無いこと）
 */

const RECORDED_AT = "2026-04-15T00:00:00.000Z";
const TENANT_ID = "context-eval-independent";

// 「文脈なし」ケースで捏造されていないかを確認するための、他ケース由来の固有名詞の
// ブロックリスト（d4 で使う。d1/d2 は対になる a1/a2 の固有名詞だけを個別に禁止する）。
const FABRICATION_BLOCKLIST = ["さくら亭", "19時", "19:00", "青葉", "会議室", "レストラン", "ホテル"];

/** @type {EvalCase[]} */
export const evalCases = [
  {
    id: "eval-a1-restaurant-reference",
    category: "a-contextual-reference",
    rationale:
      "Issue #689 問題節: 会話の参照先が抽出に渡らないと「それでお願いします」の対象を確定できない。" +
      "店員が提案した店名を、田中の「そこにしましょう」という同意の対象として抽出できるかを見る。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "そこにしましょう",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [{ speaker: "店員", text: "予約はさくら亭でよろしいですか？" }],
    },
    expect: { includes: ["さくら亭"], excludes: [], dateMatch: null, dateMustNotMatch: null },
  },
  {
    id: "eval-a2-meeting-time-reference",
    category: "a-contextual-reference",
    rationale:
      "Issue #689 問題節、同上（参照先の解決）。assistant が提案した時刻を、田中の「それで大丈夫です」の" +
      "対象として抽出できるかを見る。開発ケース a1 とは対象の種類（場所ではなく時刻）を変えてある。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "それで大丈夫です",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [{ speaker: "assistant", text: "次のミーティングは19時からでいいですか？" }],
    },
    expect: { includes: ["19時"], excludes: [], dateMatch: null, dateMustNotMatch: null },
  },
  {
    id: "eval-b1-relative-date-jst",
    category: "b-relative-date",
    rationale:
      "Issue #689 問題節: 観測日時が抽出に渡らないと「明日」の意味を確定できない。" +
      "occurredAt 2026-03-14T15:30Z は Asia/Tokyo では 2026-03-15。UTCのまま数えると1日誤る。" +
      "「明日」の正しい解決先は2026-03-16。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "明日は歯医者に行きます",
      occurredAt: "2026-03-14T15:30:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [],
    },
    expect: {
      includes: [],
      excludes: [],
      dateMatch: /2026(?:年|-)0?3(?:月|-)0?16(?!\d)/,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-b2-relative-date-ny-boundary",
    category: "b-relative-date",
    rationale:
      "同上（観測日時）。開発ケースは Asia/Tokyo（UTCより進む）だけを見ていたので、ここは" +
      "America/New_York（UTCより遅れる、夏時間 UTC-4）で逆方向の日付境界を見る。" +
      "occurredAt 2026-06-30T02:00Z は America/New_York では 2026-06-29（UTC日付とは別の日）。" +
      "「明後日」の正しい解決先は2026-07-01。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "明後日に飛行機で出発します",
      occurredAt: "2026-06-30T02:00:00.000Z",
      timeZone: "America/New_York",
      contextMessages: [],
    },
    expect: {
      includes: [],
      excludes: [],
      dateMatch: /2026(?:年|-)0?7(?:月|-)0?1(?!\d)/,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-c1-other-speaker-drink",
    category: "c-other-speaker",
    rationale:
      "Issue #689 完了条件（本文そのまま）: 「文脈内の他人の発話を当該話者の stated として" +
      "取り込まない」。鈴木の発話（ビール）が、田中（ワイン）の記憶に混入しないかを見る。" +
      "開発ケース other-speaker とは話題（コーヒー/紅茶→ビール/ワイン）を変えてある。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "私はワイン派です",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [{ speaker: "鈴木", text: "僕はビール党だよ" }],
    },
    expect: { includes: ["ワイン"], excludes: ["ビール"], dateMatch: null, dateMustNotMatch: null },
  },
  {
    id: "eval-c2-other-speaker-rhythm",
    category: "c-other-speaker",
    rationale:
      "同上（話者違いの取り込み禁止）。同僚の発話（朝型）が、田中（夜型）の記憶に混入しないか。" +
      "話題（生活リズム）・文構造（「私は◯◯です」を2人が言う）をc1から変えてある。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "私は夜型人間です",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [{ speaker: "同僚", text: "私は朝型人間です" }],
    },
    expect: { includes: ["夜型"], excludes: ["朝型"], dateMatch: null, dateMustNotMatch: null },
  },
  {
    id: "eval-d1-no-context-contrast-of-a1",
    category: "d-no-context-no-fabrication",
    rationale:
      "Issue #689 完了条件（本文そのまま）: 「文脈不足なら対象や日時を捏造しない」。" +
      "eval-a1 と同一の発話・話者・観測日時で、context だけを空にした対照。" +
      "「さくら亭」は文脈からしか得られない固有名詞なので、それが出れば捏造の証拠になる。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "そこにしましょう",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: null,
    },
    expect: { includes: [], excludes: ["さくら亭"], dateMatch: null, dateMustNotMatch: null },
  },
  {
    id: "eval-d2-no-context-contrast-of-a2",
    category: "d-no-context-no-fabrication",
    rationale:
      "同上。eval-a2 と同一の発話・話者・観測日時で、context だけを空にした対照。" +
      "「19時」は文脈からしか得られない情報なので、それが出れば捏造の証拠になる。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "それで大丈夫です",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: null,
    },
    expect: { includes: [], excludes: ["19時", "19:00"], dateMatch: null, dateMustNotMatch: null },
  },
  {
    id: "eval-d3-missing-timezone-no-date-fabrication",
    category: "d-no-context-no-fabrication",
    rationale:
      "同上（日時の捏造禁止）。occurredAt はあるが timeZone が無いため、契約上" +
      "observedLocalDate/relativeDates は null になる（暦計算はコード側の契約テストで別途保証済み）。" +
      "ここではモデル自身が、渡されていない暦日を本文から独自に作文して補わないかを見る。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "明日健診に行きます",
      occurredAt: "2026-05-01T09:00:00.000Z",
      timeZone: null,
      contextMessages: null,
    },
    expect: {
      includes: [],
      excludes: [],
      dateMatch: null,
      dateMustNotMatch: /\d{4}(?:年|-)\d{1,2}(?:月|-)\d{1,2}/,
    },
  },
  {
    id: "eval-d4-bare-consent-no-context-no-occurredat",
    category: "d-no-context-no-fabrication",
    rationale:
      "同上（対象・日時どちらの捏造も禁止）。context も occurredAt も無い、最も情報の少ない" +
      "同意発話。他ケースで使った固有名詞のブロックリストが混入していないか、暦日が" +
      "作文されていないかを見る。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "了解しました、そちらでお願いします",
      occurredAt: null,
      timeZone: null,
      contextMessages: null,
    },
    expect: {
      includes: [],
      excludes: FABRICATION_BLOCKLIST,
      dateMatch: null,
      dateMustNotMatch: /\d{4}(?:年|-)\d{1,2}(?:月|-)\d{1,2}/,
    },
  },
];

export const EVAL_TENANT_ID = TENANT_ID;
export const EVAL_RECORDED_AT = RECORDED_AT;
