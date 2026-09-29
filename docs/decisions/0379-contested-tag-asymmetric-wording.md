# ADR 0379: 矛盾候補欄の文面を非対称にする（案1）。system 文への一文追記（案3）は切替可能な形で実装し、既定で使うかどうかはオーナー判断待ちとする（Issue #1430）

- **状態**: 案1（矛盾候補欄の非対称文面）は採用。案3（system への一文追記、切替可能）は実装済みだが、
  `examples/chat` の既定経路（CLI の `answer`・記録スクリプト等）でオン(既定 `true`)にするかどうかは
  **オーナー判断待ち** (2026-09-30)
- **日付**: 2026-09-30

> **⚠ 本文はクローンの委譲で動く担い手が書いた。オーナー本人の執筆ではない。**
> 投稿者名はオーナー本人を意味しない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> 案の選択（案1を実装し既定の描画にする、案2は採らない、案3は切替可能な形で実装するが既定は
> off のまま）はこの担い手が Issue #1430 の記述に沿って決めた。**C1/C2 のどちらを
> `examples/chat` の既定にするか（あるいはどちらも既定にしないか）はこの ADR では決めない
> ——オーナー側の判断を仰ぐ。**

⚠ **番号について**: [ADR 0179](./0179-adr-number-assigned-at-merge.md) のとおり、最終番号は
マージ直前に確定する。この時点で `0378` は別の並行 PR（Issue #933、PR #1431）が予約済みだった
ため `0379` を使う。

### 出所の凡例

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `vitest` / `tsc` / `tsx` / 実 OpenAI API を走らせて確かめた。
- **【受】** — Issue 本文・過去 ADR として受け取り、再導出していない（出所を明記する）。

断りの無い【現物】【実測】は、本作業の分岐元 `origin/main` = `ecc1782`（PR #1429 のマージ）の
木で、2026-09-30 に行った。

---

## 0. 対象範囲の確認（先に明記する）

**これは `examples/chat`（mnemora を「使う側」のサンプルアプリ）が、`packages/core` の
`RecalledMemory`（`companionOf`/`contestedWith`/`recordedAt` 等）を読んで、回答生成 LLM へ
渡すプロンプトの文言をどう組み立てるかという話である。`packages/*` のライブラリ API・型・
戻り値は1バイトも変えていない。** `@mnemora/core` の `recall()` が返す `RecalledMemory` の
形（`contestedWith?: MemoryId`、`recordedAt?: Date` 等）はそのまま——変わるのは、
`examples/chat/src/mnemora-path.ts` の `buildMnemoraPrompt`（回答プロンプトを組み立てる
純関数、`examples/chat` 側の実装）が、その `RecalledMemory` の集合から**どの文字列を
作るか**だけである。ライブラリを使う他の呼び出し側（`examples/chat` 以外の統合）は、
この ADR の影響を一切受けない。

## 1. 文脈

### Issue #1430 が報告した観測

[Issue #1430](https://github.com/takecchi/mnemora/issues/1430) は、PR #1429 の実測
（同日 2026-09-30、main `b84586b` 上）を報告している。要点:

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
「印を付けるかどうか」ではない。**この ADR は印を付けること自体は維持し、文面だけを
直す。**

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
（非対称文面を出す）——マネージャー指示どおり、`contestedWith` が一度でも成立していれば
新文面を優先する。

この変更は**opt-in のフラグを新設せずに、`buildMnemoraPrompt` 自体の描画規則を直接
書き換えた**——`contestedWith` を実際に使う呼び出し側（`claimKey.detectContested: true` を
渡す呼び出し）は、この PR がマージされた時点で自動的に新しい文面を受け取る。これは
「対称な文面が本物の訂正の回答を損ねる」という Issue #1430 の実測に対する**直接の
修正**であり、切り替えて確かめる性質の変更ではないと判断した（下記「測定」の C1/A' 対比が
根拠）。

### 決定2（案3・実装するが既定 off、切替可能）: system 文への一文追記は「実際に印が出たか」で on/off を決める

`examples/chat/src/answer-bench.ts` に次を足した:

```ts
export const CONTESTED_CORRECTION_GUIDANCE =
  "矛盾候補の印がある記憶どうしは、記録順の新しい方を現在の値として答えてください。";

export function resolveMnemoraAnswerSystemPrompt(
  mnemoraPromptBody: string,
  contestedCorrectionGuidance: boolean,
): string {
  if (contestedCorrectionGuidance && promptHasContestedCorrectionMarker(mnemoraPromptBody)) {
    return `${ANSWER_SYSTEM_PROMPT}${CONTESTED_CORRECTION_GUIDANCE}`;
  }
  return ANSWER_SYSTEM_PROMPT;
}
```

`runAnswerCase`/`runAnswerBench` に `contestedCorrectionGuidance`（既定 `false`）を足した
——**既存の呼び出し（`cli.ts` の `recordAnswer`/`runAnswer`、`record-answer-*.ts` 等）は
1つも変更していないので、実質的に何も変わらない。** 明示的に `true` を渡すのは、本 ADR の
測定用に新設したスクリプト（`examples/chat/src/scripts/measure-1430-contested-tag-direction.ts`）
の C2 条件だけである。

**「on/off はフラグそのものではなく、実際に案1の非対称文面が出たかどうかで決める」**
——`promptHasContestedCorrectionMarker`（`mnemora-path.ts`、`buildMnemoraPrompt` の出力に
「（訂正の可能性）」/「（訂正された可能性）」のどちらかの部分文字列が含まれるかを見るだけの
純関数）が `false` を返す回（＝非対称文面が1つも出なかった回。記録順が分からない、
印そのものが無い等）は、`contestedCorrectionGuidance: true` を渡していても system は
`ANSWER_SYSTEM_PROMPT` のまま変わらない。

区切りは**空白を挟まず**、`ANSWER_SYSTEM_PROMPT` の末尾の句点「。」の直後にそのまま
`CONTESTED_CORRECTION_GUIDANCE` を連結する——`ANSWER_SYSTEM_PROMPT` 自身が「…答えて
ください。根拠が無ければ…」という2文を空白無しで連結する書き方を採っており、それに
揃えた（実測した連結後の文字列は下の「測定」節のプロンプト抜粋を参照）。

**naive（全文経路）には適用しない。** naive のプロンプトは `recall()` に依らず
`[矛盾候補:]` を一度も含まないため、`contestedCorrectionGuidance: true` でも naive の
system は変わらない——両経路の system を完全に同一に保つ既存の規律（`answer-bench.ts`
§2.2 決定2）からの、この案3だけの意図的な逸脱である。

**この ADR は「C1（案1のみ）と C2（案1+案3）のどちらを `examples/chat` の既定経路
（CLI の `answer` コマンド・記録スクリプト等）で使うか」を決めない。** 下の測定は
C2 が C1 より一貫して良い結果を示したが、n=5・1日・gpt-4o-mini 限定の観測であり、
一般化の根拠にするには小さい。**オーナー側の判断を仰ぐ。**

### 決定3: 既定の経路は1バイトも変えない

- 印そのものが出ない recall（矛盾関係が無い）。
- `companionOf` だけが由来の recall（`contestedWith` を経由しない）。
- `contestedWith` 由来でも、記録順が片方でも分からない recall。

これらは `contradictionSegment` の新しい非対称化条件（決定1）に一つも当てはまらないため、
`buildMnemoraPrompt` の出力は**今までと1バイトも変わらない**。`resolveMnemoraAnswerSystemPrompt`
も、呼び出し側が `contestedCorrectionGuidance` を渡さない限り（既定 `false`）
`ANSWER_SYSTEM_PROMPT` のまま変わらない。下の「既定の経路が変わらないことの歯」節に、
これを固定した決定的な単体試験を列挙する。

## 3. 実装

- `examples/chat/src/mnemora-path.ts`
  - `contradictionSegment` が `order`（`ReadonlyMap<string, number>`、`recordedOrderById`
    の戻り値）を受け取るようにし、`contestedWith` 由来かどうかを判定する
    `isContestedCounterpart` を新設した。
  - `promptHasContestedCorrectionMarker`（export）を新設した——案3の on/off 判定と、
    単体試験の両方から使う。
- `examples/chat/src/answer-bench.ts`
  - `CONTESTED_CORRECTION_GUIDANCE`・`resolveMnemoraAnswerSystemPrompt`（export）を新設。
  - `runAnswerCase`/`runAnswerBench` に `contestedCorrectionGuidance`（既定 `false`）を
    末尾の任意引数として足した。
- `examples/chat/src/scripts/measure-1430-contested-tag-direction.ts`（新規）
  - #835 候補4のスクリプト（`measure-835-candidate4-answer-quality.ts`、PR #1429）と同じ
    対象6ケース・n=5・`ClaimKeyOptions` の骨組みを再利用し、C1/C2 の2条件を実 API で測る。
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
- `examples/chat/src/__tests__/issue-1430-contested-correction.test.ts`（新規）:
  `promptHasContestedCorrectionMarker`・`resolveMnemoraAnswerSystemPrompt` の単体試験。
  「フラグ true でも印が出なければ system は変わらない」「フラグ false なら印が出ていても
  変わらない」を固定している。
- 既存の `answer-bench.postgres.test.ts`・`cassette-coverage.test.ts`・
  `basis-lost-prompt-roundtrip.test.ts`・`answer-trials-material.test.ts`・
  `answer-trials-render.test.ts` は無変更のまま緑（下記「確かめたこと」参照）。

### 赤の確認（別 worktree、`origin/main` = `ecc1782`）

`git worktree add` で作った別 worktree に、**新しいテストファイルだけ**（実装の変更は
含めず）コピーして走らせた（`git checkout origin/main -- <path>` は使っていない）。

```
Test Files  2 failed (2)
     Tests  12 failed | 25 passed (37)
```

- `provenance-prompt-contract.test.ts`: 新設4件のうち非対称文面を期待する2件
  （`contested-with-asymmetric-both-recorded`・`contested-with-asymmetric-combined-origin`）
  が、`main` の対称な旧実装のままでは期待値と食い違って赤になった（`AssertionError:
  expected […] to deeply equal […]`、`「訂正された可能性」`等を含まない旧文面が返る）。
  残り2件（記録順が片方だけ・companion 由来）は `main` でも対称な旧文面のままなので緑
  だった——これは意図どおり（既定の経路は `main` でも変わらない）。
- `issue-1430-contested-correction.test.ts`: `promptHasContestedCorrectionMarker`・
  `resolveMnemoraAnswerSystemPrompt` が `main` にまだ存在しないため `TypeError: … is not
  a function` で10件が赤になった。

## 5. 測定【実測 2026-09-30】

⚠ **n=5・1日・gpt-4o-mini 限定の観測である。一般化はしない。** 対象は #835 候補4
（PR #1429）と同じ6ケース（訂正4件 + 誤検出2件）。claim key は3条件とも同じ
`{ enabled: true, detectContested: true, knownPredicatesFromStore: true }`。

- **A'**（旧文面・印あり、同日の対照）: 変更前の `main`（別 worktree、`ecc1782`）で、
  既存の `measure-835-candidate4-answer-quality.ts`（`MNEMORA_CANDIDATE4_CONDITION=with-tag`）
  をそのまま5回実行した。
- **C1**（案1のみ、`contestedCorrectionGuidance` を渡さない＝既定 `false`）。
- **C2**（案1＋案3、`contestedCorrectionGuidance: true`）。

### verdict（一次判定、pass/5）

| ケース | 種別 | A'（旧文面） | C1（新文面のみ） | C2（新文面+system） |
|---|---|---|---|---|
| `schedule-change-meeting-day` | 訂正 | **fail 5/5**（`"分かりません"`） | **pass 4/5・fail 1/5**（`"分かりません。"`） | **pass 5/5** |
| `negation-moved-city` | 訂正 | pass 5/5 | pass 5/5 | pass 5/5 |
| `schedule-change-deadline` | 訂正 | **fail 5/5**（`"…20日です。"`、期待は25日） | **pass 3/5・fail 2/5**（`"分かりません"`） | **pass 5/5** |
| `negation-moved-job` | 訂正 | pass 5/5 | pass 5/5 | pass 5/5 |
| `unknown-favorite-number` | 誤検出 | pass 5/5（`"分かりません"`、must-abstain） | pass 5/5 | pass 5/5 |
| `other-period-city-this-year` | 誤検出 | pass 5/5 | pass 5/5 | pass 5/5 |

**Issue #1430 が報告した `schedule-change-meeting-day` の fail 5/5 は、同日の A' 対照でも
そのまま再現した。** C1（非対称文面だけ）はこのケースを 4/5 まで回復させ、C2（非対称文面
+ system の一文）は 5/5（完全回復）にした。**`schedule-change-deadline`（PR #1429 時点では
両条件とも fail 5/5 だった別の訂正ケース）も、A' では今回も fail 5/5 のままだったが、
C1 は 3/5、C2 は 5/5 まで改善した**——このケースは元々「両条件で同じ理由（タグとは無関係の
可能性が高い）で fail する」と ADR 0377 追記が書いていたが、今回の C1/C2 の結果は、
少なくとも一部はタグの文面が効いていた可能性を示す（原因の完全な切り分けはしていない）。

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
ない）。C1 で 0/5 だった（一度も届かなかった）ことは、C1 のコード変更（`buildMnemoraPrompt`
の描画規則）とは無関係——`contested` 自体が成立しなかった回なので、非対称化条件の
判定にすら入っていない。もう一方の誤検出 `unknown-favorite-number` は3条件とも5/5で
安定して届き、3条件とも一貫して pass（must-abstain の「分かりません」）だった——**新文面・
system 追記のどちらも、この誤検出ケースの正しい棄権を崩さなかった。**

### 費用・呼び出し回数【実測 2026-09-30】

| 条件 | chat 呼び出し（n=5合計） | 費用（n=5合計） |
|---|---|---|
| A' | 140 | $0.008650 |
| C1 | 138 | $0.008651 |
| C2 | 139 | $0.008811 |
| **合計** | **417** | **$0.026112**（見積もり約 $0.027、停止基準 $0.055 の約47%） |

記録: `examples/chat/cassettes/answer.claim-key.issue1430-{legacy-with-tag,c1,c2}-{1..5}.json`
（新規15ファイル。既存のカセットは1バイトも変更していない）。

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

C2 の同じケースでは、system がさらに次のように連結される（`answer.claim-key.issue1430-c2-1.json`
実測）:

```
以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。矛盾候補の印がある記憶どうしは、記録順の新しい方を現在の値として答えてください。
```

（回答: `来週の定例会議は水曜日です。`）

## 6. 確かめたこと（実装側）

- `pnpm --filter @mnemora/example-chat exec tsc --noEmit -p tsconfig.json`: 緑。
- `pnpm --filter @mnemora/example-chat exec vitest run` で関連ファイル（
  `provenance-prompt-contract.test.ts`・`mnemora-path.test.ts`・
  `basis-lost-prompt-roundtrip.test.ts`・`answer-trials-material.test.ts`・
  `answer-trials-render.test.ts`・`provenance-trace.test.ts`・
  `answer-content-preservation.test.ts`・`cassette-coverage.test.ts`・
  `issue-1430-contested-correction.test.ts`）: 全緑（150件）。
- `answer-bench.postgres.test.ts`（本物の Postgres + pgvector）: 緑（3件）。
- `git diff --stat examples/chat/cassettes/` は新規ファイル15件の追加のみ
  （既存カセットへの変更0件）。

## 7. 確かめていないこと

- ⛔ n を増やしても C1/C2 の改善が同じ比率で保たれるか（本測定は n=5・1回のみ）。
- ⛔ 他の回答モデルでの挙動（gpt-4o-mini だけで測った）。
- ⛔ `schedule-change-deadline` が今回 C1/C2 で改善した原因が、本当に矛盾候補欄の文面
  （案1）なのか、それとも同日の別要因（claim key 抽出の揺れ等）なのか——切り分けていない。
- ⛔ 誤検出（U1 の対象）に印が届く回をもっと増やした場合の挙動——`other-period-city-this-year`
  は3条件とも一部の回でしか `contested` が成立しなかった。
- ⛔ C1 と C2 のどちらを `examples/chat` の既定にすべきか（決定2のとおり、この ADR では
  決めない）。

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
  （claim key・`detectContested` の経緯、#835）。
- [Issue #835](https://github.com/takecchi/mnemora/issues/835) U4（`[矛盾候補:]` に確度を
  載せるか。本 ADR の案1・案3はどちらも確度を明示せず載せない方向の実装である）。
