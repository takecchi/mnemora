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
 * ## この定義が実装前であることの確認
 *
 * `provenance-prompt-contract.test.ts` は、このケース集合を読んで
 * `buildMnemoraPrompt` の実際の出力と1行ずつ比較する。本コミットの時点では
 * `buildMnemoraPrompt` はまだ digest だけを箇条書きにする実装のままなので、
 * 次のコミット（テストを足すコミット）は **赤**になることが期待される。
 */

const SCORE = { decay: 1, tagMatch: 1, freshness: 1, strength: 1, total: 1 };

export interface ProvenancePromptCase {
  id: string;
  description: string;
  /** この会話ターンで recall が返した memories（順序どおり）。 */
  memories: RecalledMemory[];
  /** `buildMnemoraPrompt` が返す本文のうち、digest 箇条書き部分の期待行（memories と同じ順）。 */
  expectedLines: string[];
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
];
