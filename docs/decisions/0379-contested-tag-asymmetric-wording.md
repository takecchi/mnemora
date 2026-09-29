# ADR 0379: 矛盾候補欄の文面を記録順で非対称にし（案1）、実際に非対称文面が出た回だけ system 文に読み方の一文を足す（案3）。C2（案1＋案3、既定オン）を採用する（Issue #1430）

- **状態**: 採用: C2（案1＋案3、既定オン） (2026-09-30（JST）)
- **日付**: 2026-09-30（JST）

> **⚠ 本文はクローンの委譲で動く担い手が書いた。オーナー本人の執筆ではない。**
> 投稿者名はオーナー本人を意味しない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> 案の選択（案1を実装し既定の描画にする、案2は採らない、案3は既定オンで実装する、
> C1 ではなく C2 を採用する）は、実装を委譲された担い手が Issue #1430 の記述と
> この ADR の初稿を確認したオーナー側の指示に沿って決めた。

⚠ **番号について**: [ADR 0179](./0179-adr-number-assigned-at-merge.md) のとおり、最終番号は
マージ直前に確定する。この時点で `0378` は別の並行 PR（Issue #933、PR #1431）が予約済みだった
ため `0379` を使う。索引（`docs/decisions/README.md`）もマージする側がマージ直前に生成する
（[ADR 0137](./0137-adr-index-generated-from-source.md)）——この PR では触れていない。

### 出所の凡例

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `vitest` / `tsc` / `tsx` / 実 OpenAI API を走らせて確かめた。
- **【受】** — Issue 本文・過去 ADR として受け取り、再導出していない（出所を明記する）。

断りの無い【現物】【実測】は、本作業の分岐元 `origin/main` = `ecc1782`（PR #1429 のマージ）の
木で行った。

**⚠ 日付は JST（`Asia/Tokyo`）である。** 実 API の測定（下記「測定」節）は、記録した
カセットの `recordedAt`（UTC、【実測】）で見ると `2026-09-29T16:07〜17:32Z` に収まる——
これは JST では `2026-09-30 01:07〜02:32` であり、比較の基準にした PR #1429・
ADR 0377 の追記（いずれも JST 基準で「2026-09-30」と書いている）と同じ日である。
⟹ この ADR も日付を変えず「2026-09-30（JST）」と明記する。

---

## 0. 対象範囲の確認（先に明記する）

**これは `examples/chat`（mnemora を「使う側」のサンプルアプリ）が、`packages/core` の
`RecalledMemory`（`companionOf`/`contestedWith`/`recordedAt` 等）を読んで、回答生成 LLM へ
渡すプロンプトの文言をどう組み立てるかという話である。`packages/*` のライブラリ API・型・
戻り値は1バイトも変えていない。** `@mnemora/core` の `recall()` が返す `RecalledMemory` の
形（`contestedWith?: MemoryId`、`recordedAt?: Date` 等）はそのまま——変わるのは、
`examples/chat/src/mnemora-path.ts` の `buildMnemoraPrompt`/`buildMnemoraPromptDetail`
（回答プロンプトを組み立てる純関数、`examples/chat` 側の実装）が、その `RecalledMemory` の
集合から**どの文字列を作るか**、そして `examples/chat/src/answer-bench.ts` が**どの
system 文を選ぶか**だけである。ライブラリを使う他の呼び出し側（`examples/chat` 以外の
統合）は、この ADR の影響を一切受けない。

## 1. 文脈

### Issue #1430 が報告した観測

[Issue #1430](https://github.com/takecchi/mnemora/issues/1430) は、PR #1429 の実測
（2026-09-30（JST）、main `b84586b` 上）を報告している。要点:

- opt-in の `claimKey.detectContested`（[ADR 0324](./0324-claim-key-opt-in-detection.md)）で
  本物の訂正が `contested` になると、`buildMnemoraPrompt` は両側の記憶に対称な
  `[矛盾候補:「<相手の digest>」]` を付ける（[ADR 0295](./0295-answer-prompt-provenance-rendering.md)
  決定6、[ADR 0335](./0335-recalled-memory-contested-with.md)）。
- `schedule-change-meeting-day`（「来週の定例会議は金曜日にある」→「定例会議が水曜日に
  移動した」という本物の訂正）で、この印が付いた条件（(A) 印あり）は実 API（gpt-4o-mini）
  で5回とも「分かりません」になった。印が付かない条件（(B) 印なし）は5回とも正答
  （「水曜日です。」）だった。
- 記録順（`[記録順:N]`）から見れば後の記憶（記録順4）が訂正であることは読み取れるのに、
  両側に**対称な**印が付くことで、モデルが「根拠が無ければ『分かりません』」側に倒れた、
  という【推測】が添えられていた。

Issue は3つの案を並べていた（選ぶのは担当とオーナー、という留保付き）:

1. 印の文面を非対称にする（新しい側「訂正の可能性」・古い側「後に訂正された可能性」）。
2. 訂正として扱える対には印を付けず、supersede に寄せる。
3. 回答の system 文に、印の読み方を足す（「矛盾候補の印がある場合は、記録順の新しい方を
   現在の値として答え…」）。文面そのものは変えない。

### なぜ案2を採らないか

案2（同じ claim key・両方 `stated`・記録順が明確なら、`contested` ではなく訂正
（`superseded`）として自動的に扱う）は、[ADR 0185](./0185-contradiction-detection-path.md)
決定4 とぶつかる。決定4 は北極星の問い4（「AI の推論と、ユーザーが言った事実を区別している
か」）を根拠に、**LLM が付ける claim key の一致は推論であり、推論を根拠にユーザーが言った
事実を自動的に消してはならない**——だから自動検出が書けるのは `active → contested` まで
であり、`contested → superseded` は今日どおり `resolveContested` を明示的に呼んだときだけ、
と決めている。案2は「claim key が一致し記録順が明確なら自動的に superseded 扱いにする」
という形で、この決定4 が禁じた自動昇格を（`packages/core` の状態遷移こそ変えなくても）
`examples/chat` 側の見せ方として実質的に行うことになる——**推論による claim key 一致を
根拠に、片方の主張を「もう無かったこと」のように見せる**点は、決定4 が守ろうとした線を
またぐ。⟹ **この ADR は案2を採らない。**

### #691 の合意（維持する）

[ADR 0335](./0335-recalled-memory-contested-with.md) はオーナーの決定
（ask_human 327fd89b、2026-09-25T21:11Z）として「矛盾候補の印を付ける」ことを既に決めている
——contested な対には印を付けるべきだ、という結論そのものは #1430 でも覆っていない。
Issue #1430 が問題にしたのは「印の**付け方**（対称・無条件の同じ文面）」であって、
「印を付けるかどうか」ではない。**この ADR は印を付けること自体は維持し、文面と
system の読み方の指示を直す。**

## 2. 決定

### 決定1（案1・採用）: `contestedWith` 由来の対で、両側の記録順が分かるときだけ、矛盾候補欄の文面を非対称にする

`examples/chat/src/mnemora-path.ts` の `contradictionSegment` を変更した。**対象は
`contestedWith`（どちらの向きでも）由来の相手で、かつ `m` と相手の双方が `recordedOrderById`
の順位を持つ対だけ**——それ以外（`companionOf` だけが由来、または記録順が片方でも
分からない）は、**今までの対称な文面（`「<相手の digest>」`）のまま1バイトも変えない。**

新しい文面:

- **自分が新しい側**（自分の記録順 > 相手の記録順）:
  `[矛盾候補:記録順{相手の記録順}の「{相手digest}」より後の記録（訂正の可能性）]`
- **自分が古い側**（自分の記録順 < 相手の記録順）:
  `[矛盾候補:記録順{相手の記録順}の「{相手digest}」が後に記録された（訂正された可能性）]`

相手が `recall.memories` に見つからない（想定外の入力）場合は、新旧どちらの由来でも
`memoryId=<id>（本文未取得）`のまま——本文を捏造しない規律（ADR 0295 決定7）は変えない。
相手が複数ある場合の `／` 連結、companion 由来の印との共存（矛盾候補欄1つにまとめる）も
今までの形のまま保つ。

**同じ相手が `companionOf` と `contestedWith` の両方で来た場合は `contested` 扱い**
（非対称文面を出す）——`contestedWith` が一度でも成立していれば新文面を優先する。

この変更は**opt-in のフラグを新設せずに、矛盾候補欄の描画規則を直接書き換えた**——
`contestedWith` を実際に使う呼び出し側（`claimKey.detectContested: true` を渡す呼び出し）
は、この PR がマージされた時点で自動的に新しい文面を受け取る。これは「対称な文面が本物の
訂正の回答を損ねる」という Issue #1430 の実測に対する**直接の修正**であり、切り替えて
確かめる性質の変更ではないと判断した（下記「測定」の C1/A' 対比が根拠）。

### 決定2（案3・採用、既定オン）: system 文への一文追記は、実際に非対称文面が出た回だけ行う。判定は構造で見る

`examples/chat/src/answer-bench.ts` に次を足した:

```ts
export const CONTESTED_CORRECTION_GUIDANCE =
  "矛盾候補の印がある記憶どうしは、記録順の新しい方を現在の値として答えてください。";

export function resolveMnemoraAnswerSystemPrompt(
  hasContestedCorrectionWording: boolean,
  contestedCorrectionGuidance: boolean,
): string {
  if (contestedCorrectionGuidance && hasContestedCorrectionWording) {
    return `${ANSWER_SYSTEM_PROMPT}${CONTESTED_CORRECTION_GUIDANCE}`;
  }
  return ANSWER_SYSTEM_PROMPT;
}
```

`runAnswerCase`/`runAnswerBench` の `contestedCorrectionGuidance` の**既定を `true` にした**
（Issue #1430、本 ADR の決定「C2 を採用」）。既存の呼び出し（`cli.ts` の
`recordAnswer`/`runAnswer`、`record-answer-*.ts` 等）は1つも呼び出しコード自体を
変更していない——ただし既定が変わったことで、これらの呼び出しも今後は
`contestedCorrectionGuidance: true` 相当で動く。**それでも、非対称文面が実際に出ない
回（下記「既定の経路が変わらないことの歯」参照）は system が今までと1バイトも
変わらない。**

**判定は「実際に印が出たか」を、文字列ではなく構造で見る。** 当初の実装（本 ADR の
初稿、C1/C2 の実 API 測定時点）は `promptHasContestedCorrectionMarker`（できあがった
プロンプト文字列を「（訂正の可能性）」等の部分文字列で走査する関数）を使っていたが、
**この判定関数は削除した。** 代わりに、`buildMnemoraPrompt` と並ぶ
`buildMnemoraPromptDetail(recall): { body: string; hasContestedCorrectionWording: boolean }`
を新設した——`body` は `buildMnemoraPrompt` の出力と1バイトも変わらず（`buildMnemoraPrompt`
自体は `buildMnemoraPromptDetail(recall).body` を返すだけの薄いラッパーになった。**公開
シグネチャ・出力は変えていない**）、`hasContestedCorrectionWording` は矛盾候補欄の描画
（`contradictionSegment`）が非対称文面の分岐を**実際に選んだかどうか**を、行ごと・欄ごとに
集約した構造の値である。`digest` の本文にたまたま「（訂正の可能性）」という文字列が
紛れ込んでいても、`hasContestedCorrectionWording` はその影響を受けない
（`issue-1430-contested-correction.test.ts` の decoy 歯で固定、下記「既定の経路が
変わらないことの歯」参照）。`resolveMnemoraAnswerSystemPrompt` はこの構造の値だけを見て
system を決め、プロンプト文字列そのものを一切読まない。

区切りは**空白を挟まず**、`ANSWER_SYSTEM_PROMPT` の末尾の句点「。」の直後にそのまま
`CONTESTED_CORRECTION_GUIDANCE` を連結する——`ANSWER_SYSTEM_PROMPT` 自身が「…答えて
ください。根拠が無ければ…」という2文を空白無しで連結する書き方を採っており、それに
揃えた（実測した連結後の文字列は下の「測定」節のプロンプト抜粋を参照）。

**naive（全文経路）には適用しない。** naive のプロンプトは `recall()` に依らず
`[矛盾候補:]` を一度も含まないため、`contestedCorrectionGuidance: true` でも naive の
system は変わらない——両経路の system を完全に同一に保つ既存の規律（`answer-bench.ts`
§2.2 決定2）からの、この案3だけの意図的な逸脱である。

### 決定「C1 ではなく C2 を採用する」

初稿（本 ADR の 2026-09-30（JST）時点の最初のバージョン）は、C1（案1のみ）と C2
（案1＋案3）のどちらを既定にするかをオーナー判断待ちとしていた。**オーナー側の指示を
受け、C2 を採用する。** 下の「測定」節のとおり、C2 は C1 よりも一貫して verdict が
良かった（`schedule-change-meeting-day` 5/5・`schedule-change-deadline` 5/5、C1 は
それぞれ 4/5・3/5）。

**この決定の射程は狭い**——次の3点を明記する:

1. **n=5・1日・gpt-4o-mini だけの観測であり、一般化していない。** 他の回答モデル・
   より大きい n での再現は確かめていない。
2. **`schedule-change-deadline` の改善が、矛盾候補欄の文面（案1）によるものか、
   その日の claim key 抽出の揺れによるものかは切り分けていない。** 参考: 同じ
   ケースは、PR #1429 が測った (B)（印なし）条件でも **fail 5/5** だった
   （両条件とも同じ理由で誤ると当時判断されていた。[ADR 0377](./0377-claim-key-contested-detection-excludes-same-observation-siblings.md)
   追記〔2026-09-30〕参照）——今回 C1/C2 で改善したことは、文面の効果を示唆する
   一方、単独では原因を確定できない。
3. **`other-period-city-this-year`（誤検出2件のうち、この日たまたま `contested` が
   成立した方）は、案3を実際に試せた回が少ない。** 印が届いた回数（n=5中）は
   A' 2/5・C1 0/5・C2 3/5——3条件とも「届いた回」と「届かなかった回」が混在しており、
   案3の効果をこのケースについて十分な回数で確かめられていない。

## 3. 実装

- `examples/chat/src/mnemora-path.ts`
  - `contradictionSegment` が `order`（`ReadonlyMap<string, number>`、`recordedOrderById`
    の戻り値）を受け取るようにし、`contestedWith` 由来かどうかを判定する
    `isContestedCounterpart` を新設した。`contradictionSegment` は文字列だけでなく
    `hasAsymmetricWording`（構造のフラグ）も返すようになった。
  - `renderRecalledMemoryLine` も同様に、行の文字列と `hasAsymmetricWording` を対で
    返すようになった。
  - `buildMnemoraPromptDetail(recall): { body: string; hasContestedCorrectionWording:
    boolean }`（export）を新設。`buildMnemoraPrompt(recall): string` は
    `buildMnemoraPromptDetail(recall).body` を返すだけの後方互換ラッパーになった——
    **公開シグネチャ・出力は1バイトも変えていない。**
  - `promptHasContestedCorrectionMarker`（部分文字列で見る旧判定関数）は**削除した**。
    どこからも参照していない。
- `examples/chat/src/answer-bench.ts`
  - `CONTESTED_CORRECTION_GUIDANCE`・`resolveMnemoraAnswerSystemPrompt`（export、
    `hasContestedCorrectionWording: boolean` を受け取るシグネチャに変更）。
  - `runAnswerCase`/`runAnswerBench` の `contestedCorrectionGuidance` の既定を
    `true` にした。呼び出し側は `buildMnemoraPromptDetail` を呼び、
    `.hasContestedCorrectionWording` を `resolveMnemoraAnswerSystemPrompt` に渡す。
- `examples/chat/src/scripts/measure-1430-contested-tag-direction.ts`
  - #835 候補4のスクリプト（`measure-835-candidate4-answer-quality.ts`、PR #1429）と同じ
    対象6ケース・n=5・`ClaimKeyOptions` の骨組みを再利用し、C1/C2 の2条件を実 API で
    測定した（測定は完了しており、以降このスクリプトを再実行する予定は無い）。
    `promptHasContestedCorrectionMarker` の削除に合わせて、診断ログの一部を
    `systemExtended`（構造の判定結果をそのまま表す）だけに整理した。
- `packages/*` は1バイトも変更していない。

## 4. 既定の経路が変わらないことの歯

- `examples/chat/src/__tests__/provenance-prompt-cases.ts`: 既存18件の `contested-with-*`
  ケースはいずれも `recordedAt` を渡していないため、新しい非対称化条件（決定1）に
  当てはまらず、対称な旧文面のままであることを確かめている（変更していない）。新設4件
  （`contested-with-asymmetric-both-recorded`・`contested-with-order-known-only-one-side`・
  `contested-with-companion-order-known-but-old-wording`・
  `contested-with-asymmetric-combined-origin`）で、非対称化の条件を満たすとき／満たさない
  ときの両方を Fake の `RecalledMemory` で固定した。
- `examples/chat/src/__tests__/provenance-prompt-contract.test.ts`: 上のケース集合を読んで
  `buildMnemoraPrompt` の実際の出力と1行ずつ厳密一致で比較する（既存の歯、無変更）。
- `examples/chat/src/__tests__/issue-1430-contested-correction.test.ts`（構造の判定に
  合わせて全面的に書き直した）:
  - `buildMnemoraPromptDetail(recall).hasContestedCorrectionWording` が、印なし・
    `companionOf` だけが由来・記録順が片方でも分からない contested のいずれでも
    `false` のままであることを固定。
  - **🔴 digest の本文にたまたま「（訂正の可能性）」／「（訂正された可能性）」という
    文字列が紛れ込んでいても、矛盾関係が無い（または companionOf だけが由来の対称な
    矛盾候補と共存している）場合は `hasContestedCorrectionWording` が `false` のまま**
    ——`body`（プロンプト文字列）には確かにその文字列が含まれることを先に確認した上で、
    判定が部分文字列の走査に戻っていないことを固定する。
  - `buildMnemoraPrompt(recall)` が `buildMnemoraPromptDetail(recall).body` と1バイトも
    変わらないことを固定。
  - `resolveMnemoraAnswerSystemPrompt` が、`hasContestedCorrectionWording`/
    `contestedCorrectionGuidance` の4通りの組み合わせすべてで期待どおりの system を
    返すことを固定（既定 `true` のときに印が無ければ足さないケースを含む）。
- `examples/chat/src/__tests__/issue-1430-cassette-replay.test.ts`: 本 ADR の初稿の
  測定で録った C1/C2 カセットから、非対称文面を含む回答プロンプトをそれぞれ1件取り出し、
  `parseMnemoraPromptBody`→`recordedRenderer` で再構成した上で `llmCassetteKey` で
  元の記録と同じ鍵が引けることを確かめる（DB/API 不要）。**この歯はカセットの生の
  バイト列だけを見るので、今回の構造化リファクタリングの影響を受けずそのまま緑のまま
  保たれる**——【実測】どおり、無変更で緑だった。
- 既存の `answer-bench.postgres.test.ts`・`cassette-coverage.test.ts`・
  `basis-lost-prompt-roundtrip.test.ts`・`answer-trials-material.test.ts`・
  `answer-trials-render.test.ts` は無変更のまま緑（下記「確かめたこと」参照）。

### 赤の確認（別 worktree、直前のコミット基準）

初稿（本 ADR の最初のバージョンを含むコミット）に対して、**今回の変更点**
（`hasContestedCorrectionWording` が構造の値であること・`contestedCorrectionGuidance`
の既定が `true` であること）を狙った新しい歯だけを別 worktree にコピーして確かめた
（`git checkout origin/main -- <path>` は使っていない）。この worktree は本ブランチの
直前のコミット（C1/C2 実測を含む初回コミット、`promptHasContestedCorrectionMarker` が
部分文字列判定で `contestedCorrectionGuidance` の既定が `false` だった時点）を基準にした
——**今回の変更（構造化・既定オン化）だけを狙って赤を確認するため**、Issue #1430 全体が
まだ無い `origin/main` ではなく、この基準を選んだ。

【実測 2026-09-30（JST）】`pnpm --filter @mnemora/example-chat exec vitest run
src/__tests__/issue-1430-contested-correction.test.ts` の結果:

```
Test Files  1 failed (1)
     Tests  11 failed | 2 passed (13)
```

赤くなった11件のうち、`buildMnemoraPromptDetail` を呼ぶ8件（`hasContestedCorrectionWording`
の全ケース・後方互換ラッパーの歯）は

```
TypeError: buildMnemoraPromptDetail is not a function
```

で落ちた（この時点のコミットには `buildMnemoraPromptDetail` が無く、旧来の
`buildMnemoraPrompt`/`promptHasContestedCorrectionMarker` しか無いため）。
`resolveMnemoraAnswerSystemPrompt` を呼ぶ3件は

```
TypeError: promptBody.includes is not a function
  ❯ promptHasContestedCorrectionMarker src/mnemora-path.ts:518:21
  ❯ resolveMnemoraAnswerSystemPrompt src/answer-bench.ts:404:38
```

で落ちた（この時点のシグネチャが `resolveMnemoraAnswerSystemPrompt(mnemoraPromptBody:
string, contestedCorrectionGuidance: boolean)` のままであり、新しい歯が渡す `boolean`
第1引数を文字列として扱おうとして `promptHasContestedCorrectionMarker` 内部で例外に
なったもの）。残り2件（`resolveMnemoraAnswerSystemPrompt(true, false)`・
`resolveMnemoraAnswerSystemPrompt(false, false)`、どちらも第2引数＝
`contestedCorrectionGuidance` 相当の位置に `false` を渡すケース）は**たまたま緑になった**
——旧実装の `if (contestedCorrectionGuidance && promptHasContestedCorrectionMarker(...))`
が、第2引数が `false` のとき短絡評価で `promptHasContestedCorrectionMarker` を一度も
呼ばずに `ANSWER_SYSTEM_PROMPT` を返すため、期待値と偶然一致した。**この2件が緑なのは
実装が正しいからではなく、短絡評価がこの2ケースだけ例外を踏まずに済んだからである**
——赤の確認として意味があるのは残りの11件であり、この2件の「緑」を「この時点でも
部分的に正しい」根拠として読まないこと。

## 5. 測定【実測 2026-09-30（JST）】

⚠ **n=5・1日・gpt-4o-mini 限定の観測である。一般化はしない。** 対象は #835 候補4
（PR #1429）と同じ6ケース（訂正4件 + 誤検出2件）。claim key は3条件とも同じ
`{ enabled: true, detectContested: true, knownPredicatesFromStore: true }`。

- **A'**（旧文面・印あり、同日の対照）: 変更前の `main`（別 worktree、`ecc1782`）で、
  既存の `measure-835-candidate4-answer-quality.ts`（`MNEMORA_CANDIDATE4_CONDITION=with-tag`）
  をそのまま5回実行した。
- **B**（印なし）: 新たには回していない。PR #1429（[ADR 0377](./0377-claim-key-contested-detection-excludes-same-observation-siblings.md)
  追記〔2026-09-30〕）の結果を再利用する——全件 pass だったが、`schedule-change-deadline`
  だけは fail 5/5 だった（A' と同じ誤り方）。
- **C1**（案1のみ、`contestedCorrectionGuidance: false` を明示）。
- **C2**（案1＋案3、`contestedCorrectionGuidance: true`。**この ADR が採用する条件**）。

### verdict（一次判定、pass/5）

| ケース | 種別 | B（印なし、PR #1429） | A'（旧文面、同日対照） | C1（新文面のみ） | C2（新文面+system、採用） |
|---|---|---|---|---|---|
| `schedule-change-meeting-day` | 訂正 | pass 5/5 | **fail 5/5**（`"分かりません"`） | **pass 4/5・fail 1/5**（`"分かりません。"`） | **pass 5/5** |
| `negation-moved-city` | 訂正 | pass 5/5 | pass 5/5 | pass 5/5 | pass 5/5 |
| `schedule-change-deadline` | 訂正 | **fail 5/5**（`"…20日です。"`、期待は25日） | **fail 5/5**（同じ誤り） | **pass 3/5・fail 2/5**（`"分かりません"`） | **pass 5/5** |
| `negation-moved-job` | 訂正 | pass 5/5 | pass 5/5 | pass 5/5 | pass 5/5 |
| `unknown-favorite-number` | 誤検出 | pass 5/5 | pass 5/5（`"分かりません"`、must-abstain） | pass 5/5 | pass 5/5 |
| `other-period-city-this-year` | 誤検出 | pass 5/5 | pass 5/5 | pass 5/5 | pass 5/5 |

**Issue #1430 が報告した `schedule-change-meeting-day` の fail 5/5 は、同日の A' 対照でも
そのまま再現した。** C1（非対称文面だけ）はこのケースを 4/5 まで回復させ、C2（採用条件、
非対称文面 + system の一文）は 5/5（完全回復）にした。**`schedule-change-deadline` は
B（印なし）・A'（旧文面）のどちらでも fail 5/5 だった**——つまり「印が無くても」「対称な
印があっても」誤り続けていたケースであり、C1 が 3/5・C2 が 5/5 まで改善したことは、
矛盾候補欄の文面（案1）が効いた可能性を示す一方、**同じ日に生じた claim key 抽出の揺れ
（このケースの `contested` 成立の仕方が回によって違った可能性）による偶然の改善の可能性も
排除できていない**——原因は切り分けていない。

### 矛盾候補の印が実際に回答プロンプトへ届いた回数（n=5中）

| ケース | A' | C1 | C2 |
|---|---|---|---|
| `schedule-change-meeting-day` | 5/5 | 5/5 | 5/5 |
| `negation-moved-city` | 5/5 | 5/5 | 5/5 |
| `schedule-change-deadline` | 5/5 | 5/5 | 5/5 |
| `negation-moved-job` | 5/5 | 5/5 | 5/5 |
| `unknown-favorite-number` | 5/5 | 5/5 | 5/5 |
| `other-period-city-this-year` | 2/5 | 0/5 | 3/5 |

`other-period-city-this-year`（誤検出2件のうち、この日たまたま `contested` が成立した方）
は、3条件とも「届いた回」と「届かなかった回」が混在する——**同じ入力・同じ
`ClaimKeyOptions` でも、claim key 抽出は LLM 呼び出しであり run ごとに揺れる**（決定的では
ない）。C1 で 0/5 だった（一度も届かなかった）ことは、C1 のコード変更（矛盾候補欄の描画
規則）とは無関係——`contested` 自体が成立しなかった回なので、非対称化条件の判定にすら
入っていない。**C2 でも 3/5 しか届いておらず、案3（system 追記）をこのケースについて
十分な回数で試せていない。** もう一方の誤検出 `unknown-favorite-number` は3条件とも5/5で
安定して届き、3条件とも一貫して pass（must-abstain の「分かりません」）だった——**新文面・
system 追記のどちらも、この誤検出ケースの正しい棄権を崩さなかった。**

### 費用・呼び出し回数【実測 2026-09-30（JST）】

| 条件 | chat 呼び出し（n=5合計） | 費用（n=5合計） |
|---|---|---|
| A' | 140 | $0.008650 |
| C1 | 138 | $0.008651 |
| C2 | 139 | $0.008811 |
| **合計** | **417** | **$0.026112**（見積もり約 $0.027、停止基準 $0.055 の約47%） |

記録: `examples/chat/cassettes/answer.claim-key.issue1430-{legacy-with-tag,c1,c2}-{1..5}.json`
（新規15ファイル。既存のカセットは1バイトも変更していない）。この決定（C2 採用）の確定に
あたり、追加の実 API 呼び出しは行っていない——本節の数値は上の測定（2026-09-30（JST））の
再掲である。

### C1 のプロンプト抜粋（`answer.claim-key.issue1430-c1-1.json`、`schedule-change-meeting-day`）

```
system:
以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。

user:
(記録順: 数が大きいほど後に記録された。行は記録の古い順に並べてある)
- [由来:stated] [話者:user] [主題:なし] [矛盾候補:記録順4の「定例会議が水曜日に移動した。金曜日は都合が悪くなった。」が後に記録された（訂正された可能性）] [記録順:1] [出来事時刻:不明] 来週の定例会議は金曜日にある
- [由来:stated] [話者:user] [主題:なし] [記録順:2] [出来事時刻:不明] 最近読んだ本がとても面白かったです。
- [由来:stated] [話者:user] [主題:なし] [記録順:3] [出来事時刻:不明] 旅行の計画を立てている
- [由来:stated] [話者:user] [主題:なし] [矛盾候補:記録順1の「来週の定例会議は金曜日にある」より後の記録（訂正の可能性）] [記録順:4] [出来事時刻:不明] 定例会議が水曜日に移動した。金曜日は都合が悪くなった。
(索引: スコープ内 4 件のうち 4 件を提示)

質問: 来週の定例会議は何曜日ですか?

回答: 水曜日です。
```

C2（採用条件）の同じケースでは、system がさらに次のように連結される
（`answer.claim-key.issue1430-c2-1.json` 実測）:

```
以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。矛盾候補の印がある記憶どうしは、記録順の新しい方を現在の値として答えてください。
```

（回答: `来週の定例会議は水曜日です。`）

## 6. 確かめたこと（実装側）

- `pnpm --filter @mnemora/example-chat exec tsc --noEmit -p tsconfig.json`: 緑。
- `pnpm --filter @mnemora/example-chat exec vitest run` で関連ファイル（
  `provenance-prompt-contract.test.ts`・`mnemora-path.test.ts`・
  `basis-lost-prompt-roundtrip.test.ts`・`answer-trials-material.test.ts`・
  `answer-trials-render.test.ts`・`cassette-coverage.test.ts`・`answer-bench.test.ts`・
  `issue-1430-contested-correction.test.ts`・`issue-1430-cassette-replay.test.ts`）: 全緑。
- `answer-bench.postgres.test.ts`（本物の Postgres + pgvector）: 緑
  ——`contestedCorrectionGuidance` の既定が `true` になっても、対象ケース
  （`ANSWER_CASE_SET_DEV[0]`、claim key opt-in 無し）は非対称文面が構造として出ないため、
  naive/mnemora の system が完全に同一であるという既存の assertion（§2.2 決定2）は
  そのまま成立する。
- `git diff --stat examples/chat/cassettes/` は新規ファイル15件の追加のみ
  （既存カセットへの変更0件）。
- `git diff --stat -- packages/` は空（`packages/*` は1バイトも変更していない）。

## 7. 確かめていないこと

- ⛔ n を増やしても C1/C2 の改善が同じ比率で保たれるか（本測定は n=5・1回のみ）。
- ⛔ 他の回答モデルでの挙動（gpt-4o-mini だけで測った）。
- ⛔ `schedule-change-deadline` が C1/C2 で改善した原因が、本当に矛盾候補欄の文面
  （案1）なのか、それとも同日の別要因（claim key 抽出の揺れ等）なのか——**切り分けて
  いない**。B（印なし）でも fail 5/5 だったことから、印の有無だけでは説明できない
  何らかの要因があることは分かるが、それが案1の文面なのか別要因なのかは確定していない。
- ⛔ 誤検出（U1 の対象）に印が届く回をもっと増やした場合の挙動——`other-period-city-this-year`
  は3条件とも一部の回でしか `contested` が成立せず、**案3を試せた回が特に少ない
  （C2 でも 3/5）**。
- ⛔ C2 を既定にしたことで、`contestedCorrectionGuidance` を明示的に渡していない他の
  実運用経路（CLI の `answer` コマンド等）が、本測定の対象6ケース以外でどう振る舞うか
  ——本 ADR は対象6ケースの範囲でしか確かめていない。

## 8. 関連

- [Issue #1430](https://github.com/takecchi/mnemora/issues/1430)（本 ADR の対象）。
- [Issue #691](https://github.com/takecchi/mnemora/issues/691)、[ADR 0335](./0335-recalled-memory-contested-with.md)
  （オーナー決定 ask_human 327fd89b「矛盾候補の印を付ける」——この決定は維持する）。
- [ADR 0185](./0185-contradiction-detection-path.md) 決定4（案2を採らない理由）。
- [ADR 0295](./0295-answer-prompt-provenance-rendering.md) 決定6・決定7（矛盾候補欄の元の
  描画規則。決定6に本 ADR への参照を追記した）。
- [ADR 0309](./0309-answer-prompt-order-legend-and-cassette-migration.md)（`order-legend`
  描画、`[記録順:N]` タグ）。
- [ADR 0324](./0324-claim-key-opt-in-detection.md)・[ADR 0326](./0326-claim-key-known-predicates.md)・
  [ADR 0329](./0329-claim-key-known-predicates-from-store.md)・
  [ADR 0377](./0377-claim-key-contested-detection-excludes-same-observation-siblings.md)
  （claim key・`detectContested` の経緯、#835。特に ADR 0377 追記〔2026-09-30〕の B 条件
  結果を本 ADR の測定表に再利用した）。
- [ADR 0137](./0137-adr-index-generated-from-source.md)・[ADR 0179](./0179-adr-number-assigned-at-merge.md)
  （ADR 索引・番号確定はマージする側の作業。本 PR では触れていない）。
- [Issue #835](https://github.com/takecchi/mnemora/issues/835) U4（`[矛盾候補:]` に確度を
  載せるか。本 ADR の案1・案3はどちらも確度を明示せず載せない方向の実装である）。
