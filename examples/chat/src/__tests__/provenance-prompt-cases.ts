import type { RecalledMemory } from "@mnemora/core";

/**
 * Issue #691 のケース定義（実装より前に固定する）。
 *
 * `buildMnemoraPrompt`（`../mnemora-path.ts`）が、`RecalledMemory` の
 * `provenanceKind`（由来）・`speaker`（話者）・`subjectId`（主題）・
 * `companionOf`/`retrievedVia`（矛盾関係）を回答プロンプトへどう表現するかを、
 * **実装より先に**言葉で決める（`provenance-prompt-contract.test.ts` がこの定義を
 * 読んで期待値と照合する）。
 *
 * ## 決めたこと
 *
 * 1. **欠落値を推測しない**（Issue #691 完了条件1）。`speaker`/`subjectId` が
 *    `null`（＝頼んだが無かった）のとき、他の値（例: `"user"`）で埋めない。
 *    かといって欄ごと消すと「頼んだのに答えが無かった」のか「そもそも頼んでいない」のか
 *    読み手が区別できなくなる（ADR 0257 の考え方の裏返し）——**明示的な「不明」/「なし」の
 *    印を出す**ことで、null（探したが無かった）を可視化する。
 * 2. **「null」と「その kind はこの欄を持ちようが無い」は別の表現にする**
 *    （`RecalledMemory.speaker` の docstring、ADR 0289）。
 *    `provenanceKind !== "stated"` のとき、`speaker` は必ず `null` だが、
 *    これは「話者を頼んだが分からなかった」のではなく「推論/統合/内省/インポートには
 *    そもそも話者という概念が無い」——**この2つを同じ「不明」表示で潰すと、
 *    AI の推論に話者が付いているかのような誤読を招く**（北極星の問い4「AI の推論と
 *    ユーザーが言った事実を区別する」）。⟹ `stated` 以外では話者欄そのものを**出さない**。
 *    `stated` で `null` のときだけ「話者:不明」を出す。
 * 3. `subjectId` はどの `provenanceKind` でも欄を持ちうる（Memory 自身の
 *    `subjectId` をそのまま引き継ぐだけで、kind に依存しない、ADR 0289）ので、
 *    **常に欄を出し**、`null` のときは「主題:なし」で明示する。
 * 4. **矛盾関係**は `RecalledMemory` 単体では非対称にしか表現できない
 *    （`retrievedVia: "mandatory_companion"` + `companionOf` を持つのは
 *    「同伴取得された側」だけで、争いの起点になった側にはそれを指す欄が無い、
 *    `docs/recall.md` §8）。**プロンプトの読み手（回答生成モデル）にとっては
 *    どちらが起点かは重要ではなく、「これら2件は対立している」ことが重要**なので、
 *    `buildMnemoraPrompt` は `recall.memories` 全体を見て、`companionOf` の
 *    向き先・向かれ元の両方に対称に矛盾の印を付ける。印の中身は
 *    相手の `memoryId` ではなく **相手の digest 本文**を埋め込む——回答モデルは
 *    id を name-a memory-idの対応表として持たないため、id を出しても対応が
 *    取れない。本文があれば「この2つの主張は対立している」がその場で読める。
 * 5. 相手が `recall.memories` に見つからない（budget 等で対になるはずの片方だけが
 *    渡された、想定外の入力）場合は、本文を**捏造しない**——`memoryId` と
 *    「本文未取得」という印だけを出す。
 *
 * ## `recordedAt`/`occurredAt`（Issue #691 の子、Issue #702、ADR 0298）
 *
 * 6. **`recordedAt`（取り込んだ壁時計の時刻）と `occurredAt`（出来事自身の時刻）は
 *    別の名前で出す**——`occurredAt` が `null`（出来事の時点が分からない・述べられて
 *    いない）でも `recordedAt` の値で埋めない（`RecalledMemory.occurredAt` の
 *    docstring「2つの時計は意味が違う」・ADR 0298「決めなかったこと」）。
 * 7. 🔴 **`recordedAt` は生の ISO 8601 では出さない。`recall.memories` 全体を
 *    `recordedAt` の昇順で並べ替えた順位（1, 2, …）を `[記録順:N]` として出す**
 *    ——実 API（gpt-4o-mini）での dev 対照で、生の ISO タイムスタンプを行末に
 *    付けると `schedule-change-meeting-day`（「金曜→水曜に変更」の訂正が後続する
 *    ケース）の正答率が 5/5 → 1/5 に落ちることを実測した（他の描画候補「並べ替え+
 *    注記1行」も同じく 1/5）。**記録順の番号に置き換えると 5/5 のまま**——
 *    数値の大小関係のほうが、ISO 文字列の日時比較よりモデルが読み取りやすいと
 *    考えられる（詳細・数値は ADR 0295 の追記、PR #698 本文参照）。
 *    `recordedAt` が `undefined`（手組みの `RecalledMemory` 等、そもそも欄を渡さな
 *    かった呼び出し側）の要素は順位付けの対象から外し、記録順の欄そのものを出さない。
 *    同じ `recordedAt`（同一ミリ秒）の要素は、`recall.memories` に現れた元の順序で
 *    タイブレークする（安定ソート——毎回同じ番号になることを保証する）。
 * 8. `occurredAt` は3値ある: `undefined`（頼んでいない・欄を出さない）／`null`
 *    （頼んだが無かった・「不明」と明示する——`speaker` の「null」と同じ扱い）／
 *    `Date`（値がある・ISO 8601 で出す）。**こちらは ISO のままでよい**——dev 対照は
 *    `occurredAt` が常に `null`（`ingestConversation` が渡さない）の下でしか測って
 *    いないため、`occurredAt` に値がある場合の描画が同じ問題を持つかは未評価のまま
 *    残る（PR 本文「未評価の範囲」）。
 * 9. `recordedAt`（記録順）と `occurredAt` が同じ時刻を指していても、2つの欄を
 *    1つに畳まない（読み手が「たまたま同じ」と「同じ欄」を区別できなくなるのを
 *    避ける）。
 *
 * ## 行の並べ替え・凡例（ADR 0304、`order-legend` 描画。旧: `[記録順:N]` タグだけを
 * 添えて配列順のまま出す描画）
 *
 * 10. 🔴 **`recall.memories` を `recordedAt` の昇順に並べ替えて出す。** 生の ISO
 *     タイムスタンプ（案A）でも、配列順のまま `[記録順:N]` タグだけ添える描画
 *     （旧実装）でもなく、**行そのものの表示順を記録順に差し替える**——
 *     `schedule-change-meeting-day`（「金曜→水曜」の訂正）を材料にした n=15 の
 *     dev 対照で、この描画（`order-sorted-legend`）が 13/15 と、旧描画の揺れ幅
 *     （8/15）に対して安定して高かった（他の dev 5件はどの描画でも 15/15）。
 *     数値・採らなかった候補は ADR 0304 に集約する。**`recordedAt` を持たない行は
 *     並べ替えの対象から外し、元の配列順のまま末尾に残す**（欠落値を推測しない、
 *     Issue #691 完了条件1と同じ規律の適用——「記録順が無い」ことを「先頭」でも
 *     「末尾以外のどこか」でもなく、末尾かつ元順のままとして扱う）。
 * 11. **少なくとも1行が `[記録順:N]` を持つとき（＝並べ替えが実際に起きたとき）だけ**、
 *     本文の先頭に凡例1行 `(記録順: 数が大きいほど後に記録された。行は記録の古い順に
 *     並べてある)` を出す。1件も記録順を持たない（`recordedAt` を誰も渡していない）
 *     呼び出しでは、並べ替えが起きていないので「並べてある」と書かない。
 * 12. ⚠ **`recall.memories` が元々持っていたスコア順（`docs/recall.md` §2）は、
 *     この並べ替えで失われる。**`buildMnemoraPrompt` の出力文字列だけを見る
 *     呼び出し側は、もうスコア順を復元できない——スコア順が要るなら
 *     `recall.memories` 自体（並べ替えていない）を見ること。
 *
 * ## この定義が実装前であることの確認
 *
 * `provenance-prompt-contract.test.ts` は、このケース集合を読んで
 * `buildMnemoraPrompt` の実際の出力と1行ずつ比較する。本コミットの時点では
 * `buildMnemoraPrompt` はまだ digest だけを箇条書きにする実装のままなので、
 * 次のコミット（テストを足すコミット）は **赤**になることが期待される。
 *
 * **2026-09（`recordedAt`/`occurredAt` を足す回）**: 末尾5件（`temporal-*`）を
 * 追加した時点でも同じ規律を守る——このコミットの時点では
 * `buildMnemoraPrompt`/`renderRecalledMemoryLine` はまだ `recordedAt`/`occurredAt` を
 * 描画しないので、この5件だけが赤になることが期待される（既存9件は無関係のまま緑）。
 *
 * **2026-09（ADR 0304、`order-legend` 描画への切り替え）**: 上の10〜12を実装へ
 * 反映した時点で、`temporal-*` の5件だけが再び赤になった
 * （`pnpm exec vitest run src/__tests__/provenance-prompt-contract.test.ts` の実測、
 * 5 failed | 11 passed——凡例行が追加された分と、`temporal-order-multi-out-of-array-order`
 * の行順が入れ替わった分）。この5件の `expectedLines`/`expectedLegend` を新しい
 * 出力に合わせて更新した——**由来・話者・主題・矛盾関係だけを見る既存9件
 * （recordedAt を渡していない）は無関係のまま緑だった。**
 */

const SCORE = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 };

export interface ProvenancePromptCase {
  id: string;
  description: string;
  /** この会話ターンで recall が返した memories（`recall()` が返す元の順序どおり）。 */
  memories: RecalledMemory[];
  /**
   * `buildMnemoraPrompt` が返す本文のうち、digest 箇条書き部分の期待行——
   * **表示順**（ADR 0304 の並べ替え後。`recordedAt` を持たない行は `memories` の
   * 元順のまま末尾に残る）。
   */
  expectedLines: string[];
  /**
   * 凡例行 `ORDER_LEGEND_LINE`（`../mnemora-path.js`）が本文の先頭に出るはずなら
   * `true`。省略時 `false`——1件も `recordedAt` を持たないケースでは出ない
   * （ADR 0304 決定「少なくとも1行が記録順を持つときだけ」）。
   */
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
      "前後が逆: 記録順は配列位置ではなく recordedAt の昇順で決まる。ADR 0304 以降は" +
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
];
