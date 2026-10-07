import type { RecalledMemory } from "@mnemora/core";

const SCORE = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 };

export interface ProvenancePromptCase {
  id: string;
  description: string;
  memories: RecalledMemory[];
  expectedLines: string[];
  expectedLegend?: boolean;
}

export const PROVENANCE_PROMPT_CASES: ProvenancePromptCase[] = [
  {
    id: "stated-with-speaker",
    description: "stated + 話者あり: 由来・話者・主題をすべて出す",
    memories: [
      {
        memoryId: "m-stated-speaker",
        digest: "好きな色は青",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: ["- [由来:stated] [話者:太郎] [主題:user-1] 好きな色は青"],
  },
  {
    id: "stated-speaker-null",
    description:
      "stated + 話者null: 「頼んだが分からなかった」ことを明示する（'user' 等で埋めない）",
    memories: [
      {
        memoryId: "m-stated-nullspeaker",
        digest: "何かを言った",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: null,
        subjectId: null,
        score: SCORE,
      },
    ],
    expectedLines: ["- [由来:stated] [話者:不明] [主題:なし] 何かを言った"],
  },
  {
    id: "inferred-has-no-speaker-field",
    description:
      "inferred: 話者欄そのものを出さない（'null'と'欄を持ちようが無い'の区別。推測で埋めない）",
    memories: [
      {
        memoryId: "m-inferred",
        digest: "青系を好むと推測される",
        retrievedVia: "ann",
        provenanceKind: "inferred",
        speaker: null,
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: ["- [由来:inferred] [主題:user-1] 青系を好むと推測される"],
  },
  {
    id: "reflected-no-subject",
    description: "reflected + subjectIdなし: 話者欄なし・主題は「なし」",
    memories: [
      {
        memoryId: "m-reflected",
        digest: "内省の結果",
        retrievedVia: "ann",
        provenanceKind: "reflected",
        speaker: null,
        subjectId: null,
        score: SCORE,
      },
    ],
    expectedLines: ["- [由来:reflected] [主題:なし] 内省の結果"],
  },
  {
    id: "consolidated-subject-lost",
    description:
      "consolidated + subjectIdがnull（統合でsubjectをまたいだケース）: 主題は「なし」であって、勝手な代表値を出さない",
    memories: [
      {
        memoryId: "m-consolidated",
        digest: "複数の発話を統合した要約",
        retrievedVia: "ann",
        provenanceKind: "consolidated",
        speaker: null,
        subjectId: null,
        score: SCORE,
      },
    ],
    expectedLines: ["- [由来:consolidated] [主題:なし] 複数の発話を統合した要約"],
  },
  {
    id: "imported-with-subject",
    description: "imported: 話者欄なし・主題は値があれば出す",
    memories: [
      {
        memoryId: "m-imported",
        digest: "インポートされた記憶",
        retrievedVia: "ann",
        provenanceKind: "imported",
        speaker: null,
        subjectId: "user-2",
        score: SCORE,
      },
    ],
    expectedLines: ["- [由来:imported] [主題:user-2] インポートされた記憶"],
  },
  {
    id: "contradiction-pair",
    description:
      "対向記憶（矛盾関係、companionOf）: 起点側・同伴取得側の両方に、相手の本文を埋め込んだ矛盾の印を対称に出す",
    memories: [
      {
        memoryId: "m-owner",
        digest: "休みは月曜",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
      },
      {
        memoryId: "m-companion",
        digest: "休みは火曜",
        retrievedVia: "mandatory_companion",
        companionOf: "m-owner",
        provenanceKind: "stated",
        speaker: "次郎",
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:太郎] [主題:user-1] [矛盾候補:「休みは火曜」] 休みは月曜",
      "- [由来:stated] [話者:次郎] [主題:user-1] [矛盾候補:「休みは月曜」] 休みは火曜",
    ],
  },
  {
    id: "contradiction-pair-owner-not-first",
    description:
      "対向記憶（順序を崩す）: 無関係な記憶を先頭に置き、owner/companion を index 1・2にずらす。" +
      "「先頭要素を相手だと取り違える」実装がここでだけ露見する——" +
      "'contradiction-pair'（owner が index 0）だけでは、companionOf を正しく辿らず" +
      "先頭要素を機械的に指す壊れた実装が、たまたま正解と同じ答えを出して見逃される",
    memories: [
      {
        memoryId: "m-unrelated",
        digest: "無関係な記憶",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "花子",
        subjectId: "user-9",
        score: SCORE,
      },
      {
        memoryId: "m-owner-2",
        digest: "会議は10時",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
      },
      {
        memoryId: "m-companion-2",
        digest: "会議は11時",
        retrievedVia: "mandatory_companion",
        companionOf: "m-owner-2",
        provenanceKind: "stated",
        speaker: "次郎",
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:花子] [主題:user-9] 無関係な記憶",
      "- [由来:stated] [話者:太郎] [主題:user-1] [矛盾候補:「会議は11時」] 会議は10時",
      "- [由来:stated] [話者:次郎] [主題:user-1] [矛盾候補:「会議は10時」] 会議は11時",
    ],
  },
  {
    id: "same-digest-different-speaker",
    description:
      "同文で別話者: digest が同一でも、各行は自分自身の話者をそのまま出す（マージ・重複排除しない）",
    memories: [
      {
        memoryId: "m-same-digest-1",
        digest: "元気です",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
      },
      {
        memoryId: "m-same-digest-2",
        digest: "元気です",
        retrievedVia: "lexical",
        provenanceKind: "stated",
        speaker: "次郎",
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:太郎] [主題:user-1] 元気です",
      "- [由来:stated] [話者:次郎] [主題:user-1] 元気です",
    ],
  },
  {
    id: "companion-counterpart-missing",
    description:
      "companionOf の相手が recall.memories に見つからない（想定外入力）: 本文を捏造せず、id と「本文未取得」を出す",
    memories: [
      {
        memoryId: "m-dangling",
        digest: "矛盾する主張",
        retrievedVia: "mandatory_companion",
        companionOf: "m-missing",
        provenanceKind: "stated",
        speaker: "三郎",
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:三郎] [主題:user-1] [矛盾候補:memoryId=m-missing（本文未取得）] 矛盾する主張",
    ],
  },
  {
    id: "temporal-both-present",
    description:
      "recordedAt/occurredAt が両方とも値を持つ（単独の memory）: recordedAt は記録順（1件なら1）、" +
      "occurredAt は別名でミリ秒精度ISOタグとして出す",
    memories: [
      {
        memoryId: "m-temporal-both",
        digest: "会議は10時から",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
        recordedAt: new Date("2026-01-05T09:00:00.123Z"),
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:太郎] [主題:user-1] " +
        "[記録順:1] [出来事時刻:2026-01-01T00:00:00.000Z] 会議は10時から",
    ],
    expectedLegend: true,
  },
  {
    id: "temporal-occurred-null",
    description:
      "occurredAt が null（出来事の時点が分からない）: 記録順はそのまま出し、" +
      "occurredAt は recordedAt の値で埋めずに「不明」と明示する",
    memories: [
      {
        memoryId: "m-temporal-occurred-null",
        digest: "予定は未定",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "次郎",
        subjectId: "user-1",
        score: SCORE,
        recordedAt: new Date("2026-01-05T09:00:00.123Z"),
        occurredAt: null,
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:次郎] [主題:user-1] [記録順:1] [出来事時刻:不明] 予定は未定",
    ],
    expectedLegend: true,
  },
  {
    id: "temporal-order-tie",
    description:
      "2件が同じ recordedAt（同一ミリ秒）: 記録順が同じ値に潰れず、recall.memories に" +
      "現れた元の順序で 1, 2 とタイブレークする（安定ソート）。occurredAt はそれぞれ" +
      "独立の値のまま——記録順と出来事時刻の欄を1つに畳まない",
    memories: [
      {
        memoryId: "m-tie-a",
        digest: "先に並んでいる方",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "花子",
        subjectId: "user-1",
        score: SCORE,
        recordedAt: new Date("2026-01-05T09:00:00.123Z"),
        occurredAt: null,
      },
      {
        memoryId: "m-tie-b",
        digest: "後に並んでいる方",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "花子",
        subjectId: "user-1",
        score: SCORE,
        recordedAt: new Date("2026-01-05T09:00:00.123Z"),
        occurredAt: new Date("2026-01-05T09:00:00.123Z"),
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:花子] [主題:user-1] [記録順:1] [出来事時刻:不明] 先に並んでいる方",
      "- [由来:stated] [話者:花子] [主題:user-1] [記録順:2] " +
        "[出来事時刻:2026-01-05T09:00:00.123Z] 後に並んでいる方",
    ],
    expectedLegend: true,
  },
  {
    id: "temporal-occurred-undefined",
    description:
      "occurredAt が undefined（頼んでいない・手組みの入力）: occurredAt 欄そのものを出さない。" +
      "recordedAt は値があれば記録順を出す",
    memories: [
      {
        memoryId: "m-temporal-occurred-undefined",
        digest: "本文のみ",
        retrievedVia: "ann",
        provenanceKind: "inferred",
        speaker: null,
        subjectId: null,
        score: SCORE,
        recordedAt: new Date("2026-01-05T09:00:00.123Z"),
      },
    ],
    expectedLines: ["- [由来:inferred] [主題:なし] [記録順:1] 本文のみ"],
    expectedLegend: true,
  },
  {
    id: "temporal-order-multi-out-of-array-order",
    description:
      "2件の recordedAt が異なり、かつ recall.memories の並び（配列の位置）と時系列の" +
      "前後が逆: 記録順は配列位置ではなく recordedAt の昇順で決まる。ADR 0309 以降は" +
      "タグの番号だけでなく、行そのものの表示順が記録順に入れ替わる" +
      "（配列では先に置いた方が、出力では後ろに回る）",
    memories: [
      {
        memoryId: "m-later",
        digest: "配列では先だが、記録は後",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
        recordedAt: new Date("2026-01-05T09:00:01.000Z"),
        occurredAt: null,
      },
      {
        memoryId: "m-earlier",
        digest: "配列では後だが、記録は先",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
        recordedAt: new Date("2026-01-05T09:00:00.000Z"),
        occurredAt: null,
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:太郎] [主題:user-1] [記録順:1] [出来事時刻:不明] 配列では後だが、記録は先",
      "- [由来:stated] [話者:太郎] [主題:user-1] [記録順:2] [出来事時刻:不明] 配列では先だが、記録は後",
    ],
    expectedLegend: true,
  },
  {
    id: "temporal-mixed-with-and-without-recorded-at",
    description:
      "同じ recall.memories の中に recordedAt を持つ行と持たない行が混在: 記録順を持たない行は" +
      "並べ替えの対象から外れ、元の配列位置に関わらず末尾に残る（先頭に回さない・他の順位で埋めない）" +
      "——recordedAt が無い行を先頭へ回す変異試験(b)がここでだけ赤くなる",
    memories: [
      {
        memoryId: "m-no-recorded-at",
        digest: "記録順を持たない行（配列では先頭）",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
      },
      {
        memoryId: "m-has-recorded-at",
        digest: "記録順を持つ行（配列では2番目）",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "次郎",
        subjectId: "user-1",
        score: SCORE,
        recordedAt: new Date("2026-01-05T09:00:00.000Z"),
        occurredAt: null,
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:次郎] [主題:user-1] [記録順:1] [出来事時刻:不明] 記録順を持つ行（配列では2番目）",
      "- [由来:stated] [話者:太郎] [主題:user-1] 記録順を持たない行（配列では先頭）",
    ],
    expectedLegend: true,
  },
  {
    id: "contested-with-natural-pair",
    description:
      "対向記憶（矛盾関係、contestedWith）: companionOf/mandatory_companion を経由せず、" +
      "両方とも ann で自然に候補に入った場合も、両側に対称な矛盾候補印を出す" +
      "（Issue #691 続き、ADR 0335）",
    memories: [
      {
        memoryId: "m-natural-a",
        digest: "休みは月曜",
        retrievedVia: "ann",
        contestedWith: "m-natural-b",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
      },
      {
        memoryId: "m-natural-b",
        digest: "休みは火曜",
        retrievedVia: "ann",
        contestedWith: "m-natural-a",
        provenanceKind: "stated",
        speaker: "次郎",
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:太郎] [主題:user-1] [矛盾候補:「休みは火曜」] 休みは月曜",
      "- [由来:stated] [話者:次郎] [主題:user-1] [矛盾候補:「休みは月曜」] 休みは火曜",
    ],
  },
  {
    id: "contested-with-partner-missing",
    description:
      "contestedWith の相手が recall.memories に見つからない（core の契約上は本来起きないが、" +
      "companion-counterpart-missing と同じく描画関数自身の防御を見る）: 本文を捏造せず、" +
      "id と「本文未取得」を出す",
    memories: [
      {
        memoryId: "m-contested-with-dangling",
        digest: "矛盾する主張（contestedWith版）",
        retrievedVia: "ann",
        contestedWith: "m-cw-missing",
        provenanceKind: "stated",
        speaker: "四郎",
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:四郎] [主題:user-1] [矛盾候補:memoryId=m-cw-missing（本文未取得）] 矛盾する主張（contestedWith版）",
    ],
  },
  {
    id: "contested-with-absent-no-mark",
    description:
      "contestedWith 欄が無い場合（非 contested、または contested でも相手が recall 結果に" +
      "含まれず core がこの欄を書かなかった場合のどちらか——RecalledMemory 単体では" +
      "区別できない）は矛盾候補の印を出さない",
    memories: [
      {
        memoryId: "m-no-contested-with",
        digest: "矛盾の印が無い記憶",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "五郎",
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: ["- [由来:stated] [話者:五郎] [主題:user-1] 矛盾の印が無い記憶"],
  },
  {
    id: "basis-lost-inferred",
    description:
      "basisLost: true の inferred（根拠の記憶が失われた推論）は、矛盾候補欄と同じ書き方の " +
      "[根拠:失われた] を出し、根拠が残っている inferred と区別する（Issue #972、ADR 0342）",
    memories: [
      {
        memoryId: "m-basis-lost",
        digest: "青系を好むと推測される",
        retrievedVia: "ann",
        provenanceKind: "inferred",
        basisLost: true,
        speaker: null,
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: ["- [由来:inferred] [主題:user-1] [根拠:失われた] 青系を好むと推測される"],
  },
  {
    id: "basis-kept-inferred-no-mark",
    description:
      "basisLost が無い inferred（根拠が残っている）は、欄そのものを出さない（従来と1バイトも変わらない）",
    memories: [
      {
        memoryId: "m-basis-kept",
        digest: "青系を好むと推測される",
        retrievedVia: "ann",
        provenanceKind: "inferred",
        speaker: null,
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: ["- [由来:inferred] [主題:user-1] 青系を好むと推測される"],
  },
  {
    id: "basis-lost-with-contradiction",
    description: "矛盾候補欄と根拠欄が両方あるときは、矛盾候補 → 根拠 の順に並ぶ",
    memories: [
      {
        memoryId: "m-basis-lost-contested",
        digest: "推論された主張",
        retrievedVia: "ann",
        contestedWith: "m-basis-lost-other",
        provenanceKind: "inferred",
        basisLost: true,
        speaker: null,
        subjectId: "user-1",
        score: SCORE,
      },
      {
        memoryId: "m-basis-lost-other",
        digest: "対立する主張",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "六郎",
        subjectId: "user-1",
        score: SCORE,
      },
    ],
    expectedLines: [
      "- [由来:inferred] [主題:user-1] [矛盾候補:「対立する主張」] [根拠:失われた] 推論された主張",
      "- [由来:stated] [話者:六郎] [主題:user-1] [矛盾候補:「推論された主張」] 対立する主張",
    ],
  },
  {
    id: "contested-with-asymmetric-both-recorded",
    description:
      "contestedWith の対で、両側が recordedAt を持つ（Issue #1430）: 新しい側は" +
      "「…より後の記録（訂正の可能性）」、古い側は「…が後に記録された（訂正された可能性）」",
    memories: [
      {
        memoryId: "m-cw-older",
        digest: "定例会議は金曜日",
        retrievedVia: "ann",
        contestedWith: "m-cw-newer",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
        recordedAt: new Date("2026-01-05T09:00:00.000Z"),
      },
      {
        memoryId: "m-cw-newer",
        digest: "定例会議は水曜日に変更",
        retrievedVia: "ann",
        contestedWith: "m-cw-older",
        provenanceKind: "stated",
        speaker: "太郎",
        subjectId: "user-1",
        score: SCORE,
        recordedAt: new Date("2026-01-05T10:00:00.000Z"),
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:太郎] [主題:user-1] " +
        "[矛盾候補:記録順2の「定例会議は水曜日に変更」が後に記録された（訂正された可能性）] " +
        "[記録順:1] 定例会議は金曜日",
      "- [由来:stated] [話者:太郎] [主題:user-1] " +
        "[矛盾候補:記録順1の「定例会議は金曜日」より後の記録（訂正の可能性）] " +
        "[記録順:2] 定例会議は水曜日に変更",
    ],
    expectedLegend: true,
  },
  {
    id: "contested-with-order-known-only-one-side",
    description:
      "contestedWith の対で、片方しか recordedAt を持たない: 記録順が片方でも分からないので、" +
      "非対称にはせず、従来どおりの対称な文面（相手の digest だけ）のまま",
    memories: [
      {
        memoryId: "m-cw-partial-a",
        digest: "予定は火曜",
        retrievedVia: "ann",
        contestedWith: "m-cw-partial-b",
        provenanceKind: "stated",
        speaker: "花子",
        subjectId: "user-2",
        score: SCORE,
        recordedAt: new Date("2026-01-06T00:00:00.000Z"),
      },
      {
        memoryId: "m-cw-partial-b",
        digest: "予定は水曜",
        retrievedVia: "ann",
        contestedWith: "m-cw-partial-a",
        provenanceKind: "stated",
        speaker: "花子",
        subjectId: "user-2",
        score: SCORE,
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:花子] [主題:user-2] [矛盾候補:「予定は水曜」] [記録順:1] 予定は火曜",
      "- [由来:stated] [話者:花子] [主題:user-2] [矛盾候補:「予定は火曜」] 予定は水曜",
    ],
    expectedLegend: true,
  },
  {
    id: "contested-with-companion-order-known-but-old-wording",
    description:
      "companionOf だけが由来（contestedWith を経由しない）の対は、両側が recordedAt を" +
      "持っていても非対称にしない——非対称化は contestedWith 由来の対だけに限る",
    memories: [
      {
        memoryId: "m-comp-owner-order",
        digest: "休みは月曜",
        retrievedVia: "ann",
        provenanceKind: "stated",
        speaker: "次郎",
        subjectId: "user-3",
        score: SCORE,
        recordedAt: new Date("2026-01-07T00:00:00.000Z"),
      },
      {
        memoryId: "m-comp-companion-order",
        digest: "休みは火曜",
        retrievedVia: "mandatory_companion",
        companionOf: "m-comp-owner-order",
        provenanceKind: "stated",
        speaker: "三郎",
        subjectId: "user-3",
        score: SCORE,
        recordedAt: new Date("2026-01-07T01:00:00.000Z"),
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:次郎] [主題:user-3] [矛盾候補:「休みは火曜」] [記録順:1] 休みは月曜",
      "- [由来:stated] [話者:三郎] [主題:user-3] [矛盾候補:「休みは月曜」] [記録順:2] 休みは火曜",
    ],
    expectedLegend: true,
  },
  {
    id: "contested-with-asymmetric-combined-origin",
    description:
      "同じ相手が companionOf と contestedWith の両方で来る（片方が companionOf を持ち、" +
      "もう片方が contestedWith を持つ）: contested 扱いになり、非対称文面が出る",
    memories: [
      {
        memoryId: "m-combo-a",
        digest: "会議は10時",
        retrievedVia: "ann",
        contestedWith: "m-combo-b",
        provenanceKind: "stated",
        speaker: "花子",
        subjectId: "user-4",
        score: SCORE,
        recordedAt: new Date("2026-01-08T00:00:00.000Z"),
      },
      {
        memoryId: "m-combo-b",
        digest: "会議は11時に変更",
        retrievedVia: "mandatory_companion",
        companionOf: "m-combo-a",
        provenanceKind: "stated",
        speaker: "花子",
        subjectId: "user-4",
        score: SCORE,
        recordedAt: new Date("2026-01-08T01:00:00.000Z"),
      },
    ],
    expectedLines: [
      "- [由来:stated] [話者:花子] [主題:user-4] " +
        "[矛盾候補:記録順2の「会議は11時に変更」が後に記録された（訂正された可能性）] " +
        "[記録順:1] 会議は10時",
      "- [由来:stated] [話者:花子] [主題:user-4] " +
        "[矛盾候補:記録順1の「会議は10時」より後の記録（訂正の可能性）] " +
        "[記録順:2] 会議は11時に変更",
    ],
    expectedLegend: true,
  },
];
