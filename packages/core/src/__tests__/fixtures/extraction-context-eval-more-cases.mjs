// Issue #704 の続き。マネージャー判断（ADR 0299 追記節「5」）が指示した独立評価の
// 追加分——PR #709（`extraction-context-eval-coverage-cases.mjs`、eval-e1/f1/g1/h1）が
// 4カテゴリを1件ずつしか埋めていなかったところを、同じカテゴリの中でさらに広げる。
//
// ⚠ これは「実装を見て調整した開発ケース」ではない。カテゴリと期待値・根拠は、
// Issue #704 本文・ADR 0299・`buildExtractionPrompt` がプロンプトへ与えている指示文
// （「入力JSONのobservationだけを抽出対象にしてください」「分からない対象を補わないで
// ください」「相対日付はoccurredAtとtimeZoneが両方ある場合だけ…暦日に具体化し」等、
// extraction.ts 内の system 文面そのもの）だけから導いた。**この実装（extraction.ts）は
// 1バイトも変えない。**
//
// 既存の eval-a1〜d4（`extraction-context-eval-cases.mjs`）・eval-e1/f1/g1/h1
// （`extraction-context-eval-coverage-cases.mjs`）とは、tenantId
// （`context-eval-more`）・文面・話題を変えてある（同じ入力の使い回しはしていない）。
//
// 各ケースは5回ずつ録音する（`scripts/record-extraction-context-eval-more.mjs`）。
// 3回中0〜1回ではなく5回中の成功数で判定するのは、既存2本のスクリプトの流儀
// （eval-a1〜d4: 各1回、eval-e1〜h1: 各3回）よりさらにばらつきを見る解像度を上げる
// ための、この作業固有の指示（マネージャーからの依頼）による。
//
// ⛔ このファイルは録音後に書き換えない——期待値・入力を結果に合わせて直すことはしない。
// 直したくなった点は commit せず、報告に書く。
//
// 判定はここでは行わない。ここは「入力・期待値・根拠」の定義だけを持つ。
// 判定（機械的な包含/非包含/日付正規表現）は
// `packages/core/src/__tests__/extraction-context-eval-more.test.ts` が、録音済みの
// `extraction-context-eval-more-recorded.json` に対して行う。

const RECORDED_AT = "2026-04-15T00:00:00.000Z";
const TENANT_ID = "context-eval-more";

/** @type {import('./extraction-context-eval-more-cases.d.mts').MoreEvalCase[]} */
export const moreEvalCases = [
  // --- i: 文脈付き参照。互いに独立した対象種別を4本（時刻・日付・数量・場所）。---
  {
    id: "eval-i1-time-reference-variant",
    category: "i-context-reference",
    rationale:
      "文脈付き参照（対象=時刻）。eval-a2-meeting-time-reference（既存カセット、19時・" +
      "「それで大丈夫です」）とは言い回し・時刻の値を変えてある。契約テストの守備範囲外の" +
      "相対日付（『明日』等）を提案文に混ぜると、時刻の参照解決という単一の観点に" +
      "日付解決の混同が入るため、あえて相対日付を含まない文にした。「15時」は担当者の" +
      "発話にしかなく、田中自身の発話には現れない——田中の記憶に残るなら、それは" +
      "文脈からの参照解決の結果でしかありえない。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "それで結構です",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [{ speaker: "担当者", text: "次回の商談は15時からでいかがでしょうか？" }],
    },
    expect: {
      includes: ["15時"],
      excludes: [],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-i2-absolute-date-reference",
    category: "i-context-reference",
    rationale:
      "文脈付き参照（対象=日付）。相対日付（k系）とは違い、担当者の発話が既に確定した" +
      "絶対日付（4月20日）を提案している——occurredAt/timeZoneからの計算は要らず、" +
      "文脈からその日付をそのまま拾えるかだけを見る。dateMatch は月/日の表記ゆれ" +
      "（『4月20日』『4-20』等）を許容する正規表現にしてあり、年の要求はしない" +
      "（担当者の発話自体が年を言っていないため、モデルに年を捏造させたくない）。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "大丈夫です",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [{ speaker: "担当者", text: "納品日は4月20日でよろしいですか？" }],
    },
    expect: {
      includes: [],
      excludes: [],
      dateMatch: /4(?:月|-)0?20(?!\d)/,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-i3-quantity-reference",
    category: "i-context-reference",
    rationale:
      "文脈付き参照（対象=数量）。店員が具体的な数量（3人分）を提案し、田中が同意する。" +
      "対象の種類が「場所」（eval-a1、既存カセット）でも「時刻」（eval-a2、既存カセット）でも" +
      "なく「数量」であるとき、同じ参照解決の指示（『直前の提案への明示的な同意・選択は、" +
      "選択した具体的内容を対象話者の記憶として残してください』）がどこまで機能するかを見る。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "はい、それでお願いします",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [{ speaker: "店員", text: "本日のランチは3人分でよろしいですか？" }],
    },
    expect: {
      includes: ["3人分"],
      excludes: [],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-i4-location-reference-variant",
    category: "i-context-reference",
    rationale:
      "文脈付き参照（対象=場所）。eval-a1-restaurant-reference（既存カセット、『さくら亭』・" +
      "飲食店名）とは違い、ここでは社内の部屋名（第二会議室）を対象にする——固有名詞の" +
      "種類（店名 vs 社内の部屋番号付き名称）が変わっても同じ参照解決が機能するかを見る。" +
      "eval-h1/l系（長い文脈での場所参照、会議室B・正面玄関）とは文脈の長さ・話題が" +
      "異なる短い文脈での場所参照であることに注意——l系との対比は「短い文脈でも" +
      "場所参照自体は解決できるか」の基準点になる。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "はい、そこで",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [
        { speaker: "担当者", text: "打ち合わせは3階の第二会議室でよろしいですか？" },
      ],
    },
    expect: {
      includes: ["第二会議室"],
      excludes: [],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },

  // --- j: 曖昧な参照。二択のどちらも確定しないことが正しい2本（時刻・数量）。---
  {
    id: "eval-j1-ambiguous-time-two-candidates",
    category: "j-ambiguous-reference",
    rationale:
      "曖昧な参照（対象=時刻の二択）。eval-e1-ambiguous-two-candidates（既存カセット、" +
      "店名の二択）と同じ形を時刻に適用する。担当者が『14時か16時、どちらか』という" +
      "互いに排他的な二択を提示し、田中は候補を特定しない一般的な了承だけを返す。" +
      "ADR 0299 のプロンプト指示『分からない対象を補わないでください』に従うなら、" +
      "田中の記憶はどちらか一方の時刻に確定的に決め打ちしてはならない——2つの時刻の" +
      "どちらも、確定した記憶として単独で残らないことを期待値とする。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "承知しました",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [
        { speaker: "担当者", text: "14時か16時、どちらか空いている方でご案内します" },
      ],
    },
    expect: {
      includes: [],
      excludes: ["14時", "16時"],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-j2-ambiguous-quantity-two-candidates",
    category: "j-ambiguous-reference",
    rationale:
      "曖昧な参照（対象=数量の二択）。同じ形を数量（部屋の定員）に適用する。担当者が" +
      "『2名様か4名様、どちらか』という二択を提示し、田中は特定しない了承だけを返す。" +
      "eval-i3（数量の一択・確定できるケース）と対にして読むと、『提案が一つに定まって" +
      "いるか、二択のままか』という条件の違いだけで挙動が変わるかを見分けられる。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "承知しました",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [
        { speaker: "担当者", text: "2名様か4名様、どちらかのお部屋になります" },
      ],
    },
    expect: {
      includes: [],
      excludes: ["2名", "4名"],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },

  // --- k: 複雑な日時表現。週またぎ変種・期間・繰り返しを1本ずつ。---
  {
    id: "eval-k1-week-after-next-monday-crossing-month",
    category: "k-complex-relative-date",
    rationale:
      "複雑な日時（『来週の火曜』の変種: 再来週 + 月またぎ）。" +
      "eval-f1-complex-relative-date-next-week-tuesday（既存カセット、来週の火曜、" +
      "月をまたがない）に対し、ここでは (a) 『来週』ではなく『再来週』、(b) 曜日は" +
      "火曜でなく月曜、(c) 意図的に月をまたぐ、の3点を変える。occurredAt のJST暦日は" +
      "2026-04-29（水）——ISO週（月曜始まり）で数えると、今週は 04-27(月)〜05-03(日)、" +
      "来週は 05-04(月)〜05-10(日)、再来週は 05-11(月)〜05-17(日)である" +
      "（`date -d` 相当の曜日計算で確認済み: 2026-04-27/05-04/05-11 はいずれも月曜）。" +
      "よって『再来週の月曜日』は一意に 2026-05-11 に定まり、しかも当日（4月）とは" +
      "違う月（5月）へまたぐ。relativeDates（extraction.ts）が計算するのは昨日・今日・" +
      "明日・明後日の4つの固定オフセットだけであり、この解決は契約テストの射程外——" +
      "モデル自身の暦計算に委ねられる。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "再来週の月曜日に歯医者の予約を入れました",
      occurredAt: "2026-04-29T00:30:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [],
    },
    expect: {
      includes: [],
      excludes: [],
      dateMatch: /2026(?:年|-)0?5(?:月|-)0?11(?!\d)/,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-k2-date-range-across-month",
    category: "k-complex-relative-date",
    rationale:
      "複雑な日時（期間: 『3日から5日まで』）。eval-k1/eval-f1が単発の1日を解決する" +
      "のに対し、ここでは開始日・終了日の2点を同時に正しく解決できるかを見る。" +
      "occurredAt のJST暦日は 2026-05-20（水）——『来月』は暦月として一意に6月であり、" +
      "『来月3日から5日まで』は 2026-06-03（水）から 2026-06-05（金）までに定まる" +
      "（曜日は `date -d` 相当の計算で確認済み。範囲の正しさそのものには関係しないが、" +
      "根拠として記録する）。dateMatch は先読み2つで構成する: 1つ目は開始日" +
      "（2026年6月3日相当）、2つ目は終了日（5日相当）。終了日側は『6月5日』のような" +
      "完全形だけでなく、日本語の範囲表現でよくある月の省略（『6月3日から5日まで』の" +
      "ように2つ目の日付だけ月を書かない contraction）も一致させる——2つ目の月の" +
      "省略は日本語として自然な書き方であり、それを理由に『解決できていない』と" +
      "誤って判定したくないため。ただし2つ目は必ず『日』または ISO のハイフンが" +
      "隣接した『5』だけを見る（無関係な『5』を拾わないよう、桁数の衝突" +
      "（例: 13日・15日）は前後の非数字境界で弾く）。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "来月3日から5日まで大阪へ出張します",
      occurredAt: "2026-05-20T00:30:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [],
    },
    expect: {
      includes: [],
      excludes: [],
      dateMatch:
        /(?=[\s\S]*2026(?:年|-)0?6(?:月|-)0?3(?!\d))(?=[\s\S]*(?:6(?:月|-))?0?5(?:日)?(?!\d))/,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-k3-recurring-weekly",
    category: "k-complex-relative-date",
    rationale:
      "複雑な日時（繰り返し: 『毎週水曜』）。単発の暦日には解決しようがない表現であり、" +
      "正しい振る舞いは『特定の1つの暦日』へ勝手に丸めず、繰り返しという性質" +
      "（曜日）そのものを保持することだと考える——d系（文脈なし・情報不足時は捏造" +
      "しない）と構造的に同じ原則（不明・不定な部分を勝手に確定しない）を、" +
      "『情報が無い』ではなく『情報の形が単一の日付ではない』という別の理由から見る。" +
      "機械判定は『水曜』という曜日情報が残ることだけを検査する——単一の暦日を" +
      "全く出力しないことまでは要求しない（『次回は◯月◯日』のような補足自体は" +
      "指示に反するとまでは言えないため、dateMustNotMatch は使わない）。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "毎週水曜日にヨガ教室に通っています",
      occurredAt: "2026-04-15T00:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [],
    },
    expect: {
      includes: ["水曜"],
      excludes: [],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },

  // --- l: 長い文脈。eval-h1-long-context-distant-reference（既存カセット、8件中2件目、
  //        0/3で系統的未達）の変種を3本。件数・対象の位置・話題を変え、どれが長さに、
  //        どれが位置に効いているかを切り分ける組み方にする。---
  {
    id: "eval-l1-length8-position3-budget",
    category: "l-long-context-variant",
    rationale:
      "長い文脈の変種1: 件数はeval-h1と同じ8件（schema上限）のまま、対象の位置だけを" +
      "2件目→3件目へ1つ後ろへずらす。話題も『会議室の確定』（h1）から『予算の確定』へ" +
      "変える。件数を固定して位置だけを動かした対（本ケース・eval-l2）の中では" +
      "『同じ8件で、位置が3件目 vs 6件目でどちらが難しいか』を切り分けられる。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "それでお願いします",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [
        { speaker: "鈴木", text: "来月のイベント、予算はどれくらいですか？" },
        { speaker: "佐藤", text: "備品費も入れて相談中です" },
        { speaker: "assistant", text: "予算は50万円で確定します" },
        { speaker: "鈴木", text: "承知しました、ありがとうございます" },
        { speaker: "佐藤", text: "会場はもう押さえてありますか" },
        { speaker: "assistant", text: "会場は来週中に確保します" },
        { speaker: "鈴木", text: "楽しみですね" },
        { speaker: "assistant", text: "他に確認したいことはありますか？" },
      ],
    },
    expect: {
      includes: ["50万円"],
      excludes: [],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-l2-length8-position6-product-name",
    category: "l-long-context-variant",
    rationale:
      "長い文脈の変種2: 件数はeval-h1・eval-l1と同じ8件のまま、対象の位置をさらに" +
      "後ろ（6件目、末尾寄り）へ動かす。話題も『新商品名の決定』へ変える。" +
      "eval-l1（8件・3件目）と件数を揃えてあるため、この2本を比べれば『件数が同じ" +
      "とき、対象が末尾に近いほど拾いにくくなるか』という位置の効果だけを見られる" +
      "（長さの効果と混同しない）。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "それでお願いします",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [
        { speaker: "佐藤", text: "新商品の件、進捗どうですか" },
        { speaker: "鈴木", text: "候補名を3つ出しています" },
        { speaker: "assistant", text: "良い候補ですね、決めましょうか" },
        { speaker: "佐藤", text: "そうですね、そろそろ決めたいです" },
        { speaker: "鈴木", text: "デザインの方はほぼ完成しています" },
        { speaker: "assistant", text: "新商品の名称は『そよ風』に決定します" },
        { speaker: "佐藤", text: "いいですね、決まってよかったです" },
        { speaker: "鈴木", text: "発表が楽しみです" },
      ],
    },
    expect: {
      includes: ["そよ風"],
      excludes: [],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },
  {
    id: "eval-l3-length4-position1-meeting-point",
    category: "l-long-context-variant",
    rationale:
      "長い文脈の変種3: 件数をeval-h1/l1/l2の8件から4件へ大きく減らし、対象の位置を" +
      "先頭（1件目）に置く。話題は『集合場所の確定』。eval-h1（8件・2件目、0/3で" +
      "系統的未達）と比べると、件数（8→4）と位置（2件目→1件目）の両方が同時に" +
      "変わるため単独の要因分離にはならないが、『件数を大きく減らし、対象を最も" +
      "有利な位置（先頭）に置いてもなお h1 と同じように拾えないか』を見る基準点になる" +
      "——ここでも拾えなければ、位置よりも『対象が直近の発話でないこと』自体、あるいは" +
      "『後続に無関係な発話が続くこと』が効いている可能性を示唆する。eval-l1/l2" +
      "（件数8で固定して位置だけを動かした対）と合わせて読むことで、件数の効果と" +
      "位置の効果をある程度切り分けられる。",
    input: {
      subjectId: "tanaka",
      speaker: "田中",
      text: "それでお願いします",
      occurredAt: "2026-04-10T09:00:00.000Z",
      timeZone: "Asia/Tokyo",
      contextMessages: [
        { speaker: "assistant", text: "集合場所は正面玄関にします" },
        { speaker: "佐藤", text: "了解です、ありがとうございます" },
        { speaker: "鈴木", text: "今日は暑いですね" },
        { speaker: "佐藤", text: "本当に、真夏日ですね" },
      ],
    },
    expect: {
      includes: ["正面玄関"],
      excludes: [],
      dateMatch: null,
      dateMustNotMatch: null,
    },
  },
];

export const MORE_EVAL_TENANT_ID = TENANT_ID;
export const MORE_EVAL_RECORDED_AT = RECORDED_AT;
