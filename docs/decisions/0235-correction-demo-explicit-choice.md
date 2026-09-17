# ADR 0235: 訂正の相手は `examples/chat` でも人が指名する — `findCorrectionCandidates` を本番コードの経路に立てる（Issue #369 (C) / 北極星 項目5）

- **状態**: 草案（`docs/decisions/README.md` は触っていない——ADR 0137 決定2。索引はマージする側が直前に再生成する）
- **日付**: 2026-09-18

**⚠ 各主張の出所を分ける**（ADR 0232 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git`/`node`/`vitest`/`psql` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

[ADR 0232](./0232-correction-candidates-returned-not-chosen.md) は
`Runtime.findCorrectionCandidates`（Issue #369 (C)「訂正の口」）を着地させたが、
自ら「この ADR が着地させないもの」にこう書いていた【現物】:

> ⛔ **本番コードからこの口を呼ぶ経路が無い。** `examples/chat/src/correction-demo.ts`
> は今日も相手を `correction-scenario.ts` の `contestedPair` に**ハードコードしている**。
> ⟹ [Issue #284](https://github.com/takecchi/mnemora/issues/284) が導入した規律
> （本番コードから呼ぶ経路が無ければ「在る」と数えない）に照らすと、
> **この PR だけでは北極星 項目5 は立たない。**

⟹ この ADR は、その経路を実際に立てる。**同時に、ADR 0232 が「引き受けた負債」に
名指しした危険をそのまま再現しないこと**が要件になる:

> 🔴 **候補を返すだけなので、採用者が黙って1位を採れば、測定が示した危険はそのまま残る。**
> **採用側が候補[0] を機械的に採る実装を書けば、深い誤爆 75% はそのまま再現する。**

⟹ **問いは「経路を立てること」と「[0]を機械的に採らないこと」の両方を同時に満たせるか**
であり、この ADR はその形と、それを保証する歯を記録する。

---

## 決定

⭕ **採る**: `examples/chat/src/correction-demo.ts`（`runCorrectionDemo`）に、
**発見の段**と**選択の段**の2段を新設する。

1. **発見の段**: `runtime.findCorrectionCandidates(ctx, { text: scenario.correction.text,
excludeMemoryIds: [correctionId] })` を必ず1回呼ぶ。訂正の発話自身を自己除外する。
   ⛔ 書き込まない・LLM を呼ばない（`findCorrectionCandidates` 自身の契約、ADR 0232 の
   まま——このデモは新しい契約を1つも足していない）。
2. **選択の段**: 訂正の相手を、呼び出し側が `CorrectionChoice { chosenExternalId }` として
   **明示的に指名する**。台本シナリオ（CLI・DB 歯）では
   `scenario.contestedPair.firstExternalId` をそのまま渡す——**これは「機械が選んだ」の
   ではなく「人が前もって選んで台本に書いた」判断である**、という区別を型と doc コメントで
   見えるようにする。
   - 指名された相手が発見の段の候補一覧に**居れば**、その `recallRank` を結果に持たせて
     `markContested`/`recall`/`resolveContested`/`recall` の一巡へ進む
     （`outcome: "resolved"`）。
   - **居なければ、書き込まずに `outcome: "choice_not_in_candidates"` を返して止まる。**
   - **`choice` が渡されなければ、候補を提示するだけで `outcome: "awaiting_choice"` を
     返して止まる。** ⟹ ADR 0232 の B群の危険（棄権率 0/8）を可視化する経路そのもの。

⛔ **採らない**: 候補（`FindCorrectionCandidatesResult.candidates`）から相手を導出する
コードパス。候補は「提示」と「指名が候補に居るかどうかの照合」にしか使わない。

---

## なぜ「人が選ぶ」形にしたか

**根拠は ADR 0232 が実測した数字そのものであり、この ADR が新しく測ったものではない**
【受、ADR 0232 より】:

| 量                                         | 値                                                             |
| ------------------------------------------ | -------------------------------------------------------------- |
| A群（訂正すべき相手が実在する15件）hit@1   | 15/15 = 100.0%                                                 |
| 🔴 B群（⛔ 訂正してはいけない8件）棄権率   | **0/8 = 0.0%**                                                 |
| 🔴 B群 深い誤爆（守るべき事実を1位に置く） | **6/8 = 75.0%**                                                |
| 🔴 スコア閾値                              | **A と B を分離しない**（B の最大 0.90815 > A の最小 0.87558） |

⟹ `findCorrectionCandidates` を呼ぶだけでは「相手が実在しないときに手を止められるか」が
解決しない——**呼び出し側が候補の並びをそのまま信じて `markContested` へ渡せば、
ADR 0232 の危険がこの経路でもそのまま再現する。** この ADR が「人が指名する」形を
採ったのは、**この危険を経路の外へ追い出せないから**であり、それ以外の理由ではない。

⚠ **この ADR は B群の75%を下げる措置を何も持たない。** 持っているのは
「機械が候補[0]を採ってしまう実装を、この経路には書かない」という保証だけである
（下の「歯」節）。

---

## `candidates[0]` を採らないことを、どの歯がどう保証しているか

`examples/chat/src/__tests__/correction-demo.test.ts` の describe
**「🔴🔴 採用者の指名が候補1位ではないケース: candidates[0]実装なら赤くなる歯」**
（it: 「指名(originalId)は候補2位。候補1位のdecoyはmarkContested/resolveContestedの
引数に一度も現れない」）が本体である。

**組み方**: `findCorrectionCandidates` の偽の戻り値を、候補1位が decoy
（「訂正してはいけない、守るべき既存の記憶」を模したもの）・候補2位が指名された相手
（`original`）になるよう組む。`choice` には `original` の externalId を渡す。

**検査していること**: `markContested`/`resolveContested` の引数に**指名された相手の
memoryId だけ**が現れ、**decoy の memoryId は一度も現れない**こと。
`result.chosenRecallRank` が `2`（候補1位ではない）であることも合わせて見る。

⚠ **この歯は DB を要求しない。**偽 Runtime は状態を持たないため、「decoy が active の
まま残った」ことを DB レベルで確かめてはいない——検査しているのは
「decoy の id が書き込み口の引数に一度も現れない」ことであり、`examples/chat` の
書き込み口（`markContested`/`resolveContested`）を偽物に置き換えている以上、
これが実測できる範囲である。

---

## 🔴 歯が噛むことを示した【実測】— 変異試験

**変異は `cp` で退避・復元した**（⛔ `git checkout` は使っていない。退避先
`/tmp/correction-demo.ts.orig`）。

### 変異1（不採用・記録のみ）: 選択の段そのものを候補[0]に丸ごと差し替える

最初に試した変異は「`chosenId` の計算そのものを
`discovery.candidates[0]?.memoryId ?? byExternalId[choice.chosenExternalId]` に
差し替える」という広い変異だった。**赤くなった歯は2本**（優先の歯に加えて
「choice はあるが指名先が候補一覧に居ない」歯）。⟹ **1本だけが赤くなることを確認できず、
不採用**——この変異は「候補[0]が既に候補一覧に含まれる」ケースで
`choice_not_in_candidates` を誤って `resolved` に倒してしまい、無関係な歯まで壊した。
**この変異試験は「どの歯が何を守っているか」の切り分けに使えなかった**ため、記録だけ残す。

### 変異2（採用）: 書き込み直前の id だけを候補[0]に差し替える

`runCorrectionDemo` の `markContested(ctx, chosenId, correctionId)` /
`resolveContested(ctx, chosenId, correctionId, …)` の**2箇所だけ**、
`chosenId` を `discovery.candidates[0]!.memoryId` に差し替えた
（選択の段の検証ロジック・`awaiting_choice`/`choice_not_in_candidates` の分岐・
`chosenRecallRank` の計算は一切変えていない）。

【実測】`pnpm --filter @mnemora/example-chat exec vitest run src/__tests__/correction-demo.test.ts`

|              | 変異前    | 変異後                                                                                                              |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------------------- |
| 全体         | 20 passed | **1 failed, 19 passed**                                                                                             |
| 赤くなった歯 | —         | 🔴🔴 「指名(originalId)は候補2位。候補1位のdecoyはmarkContested/resolveContestedの引数に一度も現れない」**1本だけ** |
| 他の19本     | 緑        | **緑のまま**（`choice はあるが指名先が候補一覧に居ない` を含め、全て緑）                                            |

失敗内容(抜粋、実測ログそのまま):

```
AssertionError: expected [ …(2) ] to deeply equal [ …(2) ]
- Expected
+ Received
  [
-   "correction-demo-original-favorite-color-memid",
+   "decoy-memid-should-remain-untouched",
    "correction-demo-corrected-favorite-color-memid",
  ]
```

**同じ変異を当てたまま `correction-demo.postgres.test.ts` も走らせた**——3本とも緑のまま
だった。これは想定どおりである: 台本シナリオ（`CORRECTION_SCENARIO`）の発見の段は候補が
1件しか無く（decoy が居ない）、`candidates[0]` は元々 `chosenId` と一致するため、
この変異はここでは無害化される。**⟹ 「候補[0]を機械的に採ってしまう実装」を捕まえる
歯は、`correction-demo.test.ts` の decoy 付きフィクスチャだけが持つ。**
`correction-demo.postgres.test.ts` にこの危険を捕まえる責任を負わせていない。

**`cp` で復元した後**、`correction-demo.test.ts`（20件）・`correction-demo.postgres.test.ts`
（3件）の両方を再実行し、全件緑に戻ることを実測した。`git status --porcelain` で
差分が無いことも確認した。

---

## 設計で選んだこと

### 1. `CorrectionChoice` は「記録済みの人の判断」であって「機械の推薦」ではない

型と doc コメントで明示する。台本シナリオでは `scenario.contestedPair.firstExternalId`
を渡すが、これは `contestedPair` 自体が「呼び出し側が既に決めていることを前提にする」
（ADR 0134 決定2）という既存の設計と同じ強さで扱う。

### 2. `outcome` は3値（`resolved`/`awaiting_choice`/`choice_not_in_candidates`）

`awaiting_choice` は「選ばなければ何も起きない」ことを型で表現する。
`choice_not_in_candidates` は「指名した相手を mnemora 自身の recall が見失った」場合に
書き込みへ進まない安全弁であり、`findCorrectionCandidates` の
`excludeMemoryIds`/`limit`/既存の score threshold の効果をそのまま反映する
（この ADR が新しい閾値を作っていない、という ADR 0232 の決定を継承する）。

### 3. `recallRank` は素通しする

`CorrectionCandidate.recallRank`（ADR 0232、詰め直さない）をそのまま
`CorrectionDemoResult.chosenRecallRank` に運ぶ。北極星の問い3
「なぜそれを選んだのかを、後から説明できるか」への応答——「人が選んだものが recall の
何位だったか」を後から説明できる。

### 4. `winnerId` の決め方は変えていない

「誰が相手か」（選択の段、この ADR が新設）と「どちらが勝つか」
（`scenario.contestedPair.winnerExternalId`、ADR 0150 決定1のまま）を分けて持つ。
この ADR が触るのは前者だけである。

### 5. CLI (`correction` サブコマンド) は台本の判断を明示的に渡す

`examples/chat/src/cli.ts` の `runCorrection()` は
`{ chosenExternalId: CORRECTION_SCENARIO.contestedPair.firstExternalId }` を明示的に渡す。
`outcome !== "resolved"` になった場合は `process.exitCode = 1` にして止める
（`checkCorrectionDemo`/`checkCorrectionOmission` は `outcome !== "resolved"` の結果に
呼ぶと例外を投げるため、CLI 側で先に分岐する）。

---

## 🔴 この ADR が着地させないもの

- ⛔ **B群の深い誤爆 75% を下げる措置は何も無い。** この ADR が変えたのは
  「誰が最終的な書き込みの引数を決めるか」（人）だけであり、候補のスコア・並び自体は
  ADR 0232 のままである。
- ⛔ **実運用で人が正しく選べる保証はしていない。** 台本シナリオの `choice` は
  「記録済みの、あらかじめ分かっている正解」であり、実際の UI で人がどれだけ正しく
  候補から相手を選べるかは測っていない——**この ADR が保証するのは「機械が[0]を
  勝手に採らない」ことだけであり、「人が正しく選ぶ」ことではない。**
- ⛔ **`findCorrectionCandidates` の誤爆率・棄権率を守る門は無い。** ADR 0232 の
  「引き受けた負債2」と同じ立場——この PR もベンチ（門）を追加していない。
- **候補一覧に複数件出た場合の UI/UX（どう見せるか）は範囲外。** `formatCorrectionDemo`
  はテキストで印字するだけであり、実際の採用側アプリケーションでの提示方法は
  この ADR の範囲ではない。

---

## ⛔ 確かめられなかったこと

1. **decoy が DB 上で実際に `active` のまま残ることは、DB を使う歯では確認していない。**
   `correction-demo.test.ts` の優先の歯は偽 Runtime を使っており、
   「decoy の id が書き込み口の引数に一度も現れない」ことまでしか実測できない
   （上の「歯」節の注記のとおり）。`correction-demo.postgres.test.ts` はこの変異を
   検出する設計になっていない（台本シナリオに decoy が無いため）。
2. **実 API・実 embedding での候補の並びは測っていない。** `correction` サブコマンドは
   `deterministic` provider で走る（`cli.ts` の doc コメントのまま、ADR 0232 の測定と
   同じ層ではない——ADR 0232 は `local` embedding + 自前の Postgres で測ったが、
   `correction-demo.ts` の実行は `deterministic` で足りるという既存の判断を継承している）。
3. **CLI からの実行で `choice_not_in_candidates` に実際に倒れるケースは、意図的に
   作った歯以外では踏んでいない。** 台本シナリオでは常に候補に指名が含まれる
   （デモ実行で実測: 候補1件、指名は候補の #2位として見つかった）。

⚠ **一般化しないこと**: この ADR が保証するのは「この経路が候補[0]を機械的に採る形に
なっていない」ことだけであり、「訂正の相手選びが安全になった」ことではない。

---

## これが覆るとしたら

- **ADR 0232 の「これが覆るとしたら」節と同じ条件**（実 API の抽出で測り直し、B群の
  深い誤爆が大きく下がったとき等）が満たされ、「機械が選ぶ」形を再検討する場合。
- **候補が複数件出る場面で、人が候補一覧を見ずに済ませたくなる要求が実際に出てきたとき**
  ——そのときは「候補を機械的に選ばない」というこの ADR の芯そのものを再検討する
  必要がある。

## 採らなかった案

### 1. 選択を `winnerId` と同じ欄に混ぜる

⛔ **採らない。** 「誰が相手か」と「どちらが勝つか」は独立した判断であり
（前者はこの ADR が新設、後者は ADR 0150 決定1）、混ぜると「相手を指名したら自動的に
指名した側が勝つ」という誤った規則を読み手に想像させる。

### 2. `choice` が無いときにエラーを投げる

⛔ **採らない。** ADR 0232 の B群の危険（棄権しない）を可視化するには、
「候補は出るが、選ばれなければ何も起きない」という**正常系の1つ**として扱う必要がある。
例外にすると、この経路が持つべき「止まる」という性質が「壊れた」という性質に
すり替わってしまう。
