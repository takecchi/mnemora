# ADR 0238: 訂正の相手を選んだ根拠を、イベントに残す — `meta.note` と `RecallResult.explain` の両方から辿れるようにする（Issue #369 チェックボックス / 北極星 問い3）

- **状態**: 草案（`docs/decisions/README.md` は触っていない——ADR 0137 決定2。索引はマージする側が直前に再生成する）
- **日付**: 2026-09-18

**⚠ 各主張の出所を分ける**（ADR 0232/0235 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git`/`node`/`vitest`/`psql` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

[ADR 0235](./0235-correction-demo-explicit-choice.md) は `examples/chat/src/correction-demo.ts` に
「発見の段」（`findCorrectionCandidates`）と「選択の段」（`CorrectionChoice`）を立て、
北極星 項目5・Issue #369 (C) の経路を本番コードへ着地させた。

だが Issue #369 のチェックボックスのうち、次の1つは未着手のまま残っていた【現物】:

> - [ ] 選んだ根拠（スコア・順位・**候補の数**・どちらへ倒したか）を **`memory_events.meta.note`**
>       と `RecallResult.explain` の**両方**から辿れるようにする（項目3）

**【現物】** ADR 0235 が着地させた時点の `correction-demo.ts` は、`runtime.markContested`/
`runtime.resolveContested` を `opts`（4番目/5番目の引数）無しで呼んでいた
（`rg -n "opts\.reason" examples/chat/src/correction-demo.ts` が0件だった）。⟹ 候補一覧・
その順位・件数・どちらへ倒したかは、その場の標準出力（`formatCorrectionDemo`）と
`CorrectionDemoResult`（プロセス内のメモリ上の値）にしか残らず、**`memory_events` を
後から読み返しても、この訂正がなぜその相手を選んだ結果なのかが一切分からない**状態だった。

⟹ この ADR は、その欠落を埋める。同時に、これが単なる体裁の穴埋めではなく、
**ADR 0232 が「引き受けた負債1」に名指しした危険への検出手段である**ことを、
下の「なぜこの記録が歯の一種か」節に書く。

---

## 🔴 なぜこの記録が「歯の一種」なのか

ADR 0232 は実測でこう書いていた【受、ADR 0232 より】:

> 🔴 **候補を返すだけなので、採用者が黙って1位を採れば、測定が示した危険はそのまま残る。**
> **採用側が候補[0] を機械的に採る実装を書けば、深い誤爆 75% はそのまま再現する。**

ADR 0235 は `correction-demo.ts` の**今日の実装**をその形から外した——`choice` は
`discovery.candidates` の並びから一切導かれず、呼び出し側（台本・将来は人）が明示的に
指名する。この事実は `correction-demo.test.ts` の「🔴🔴 採用者の指名が候補1位ではない」歯
（decoy を候補1位に置く）が実測どおり守っている。

**だが「いま外れている」ことと「これからも外れている」ことは別の主張である。** 型・doc
コメント・テストがどれだけ今日の実装を縛っていても、将来の変更（リファクタ・機能追加・
別の担い手による書き換え）が `choice` の代わりに `discovery.candidates[0]` を静かに使う形へ
戻ることを、コード自体は構造として禁止していない——`CorrectionChoice` は単なる
`{ chosenExternalId: string }` であり、それがどこから来た値かを型は知らない。

⟹ **この ADR が足すのは、「候補が何件あって、そのうち何位のものを実際に選んだか」を
`memory_events.meta.note` へ毎回書き込む、という記録そのものである。** これ自体は
危険を下げる措置ではない（ADR 0235 の「引き受けた負債」節がそう書いた通り、この ADR も
それを変えない）。**しかし記録が積み上がれば、後から誰かが `memory_events` を横断的に
読んだときに、`chosenRecallRank` の分布が見える。** もし将来の実装変更が
`candidates[0]` を機械的に採る形へ後退すれば、`chosenRecallRank` は恒常的に `1` に
収束するはずである——**それは、コードレビューでは見逃されても、運用中のログからは
見える形の異常である。** ⟹ **この記録は、それ自体が「退行を検出する手段」という意味で
歯の一種である。** テストのように実行時に落ちるわけではないが、北極星の問い3
「なぜそれを選んだのかを、後から説明できるか」に対する応答を、実行時ログという
別のレイヤーに置く。

---

## 決定

⭕ **採る**: `examples/chat/src/correction-demo.ts`（`runCorrectionDemo`）が
`runtime.markContested`/`runtime.resolveContested` を呼ぶとき、**両方に**
`opts.reason`（`MarkContestedOptions.reason`/`ResolveContestedOptions.reason`。
`packages/core/src/runtime.ts` で確認済み——どちらも `memory_events.meta.note` へ
追記される既存の欄であり、この ADR は `packages/core` を1行も変更しない）を渡す。

`reason` の中身は `buildCorrectionReason()`（`correction-demo.ts` 新設のプライベート関数）
が組む、次の形の1行の文字列である:

```
chosenRecallRank=2 / candidates=2 / recallId=correction-candidates-recall / winner=correction
```

- `chosenRecallRank=<n>` — 指名された相手が `discovery.candidates` の何位だったか
  （`CorrectionCandidate.recallRank`、詰め直していない生の順位——ADR 0232 の規約のまま）。
- `candidates=<n>` — `discovery.candidates.length`。**Issue #369 チェックボックスが
  名指しした「候補の数」**。
- `recallId=<id>` — `discovery.recallId`。**`RecallResult.explain` への橋**（下の節参照）。
- `winner=original|correction` — `scenario.contestedPair.winnerExternalId`
  （ADR 0150 決定1のまま）が指す側。どちらへ倒したかを、`resolveContested` の
  `resolution.winnerId` だけでなく `markContested` の時点の記録からも読めるようにする。

`markContested`/`resolveContested` には**同じ文字列**を渡す——「片方だけ埋める」を
避けるため（下の歯・実測参照）。

⛛ **採らない**: `score.total`（`CorrectionCandidate.score.total`）を `reason` に載せること。
理由は下の「設計で選んだこと」節。

---

## 🔴「両方から辿れる」をどう満たしたか

- **`memory_events.meta.note` 側** — 上の決定がそのまま満たす。
- **`RecallResult.explain` 側** — `meta.note` に載る `recallId` を
  `Runtime.getRecall(ctx, recallId)`（`packages/core/src/recall.ts` の `RecallRecord`、
  `explain: { stages: StageTrace[] }` を持つ）へ渡すと、その recall の内訳が引ける
  （`Runtime.getRecall` の doc コメント、ADR 0161）。**この ADR は `packages/core` を
  1バイトも変更していない**——`findCorrectionCandidates` が内部で呼ぶ `recall()` は
  もとから段6「記録」（`docs/recall.md` §2、必須の段）で `recalls` へ永続化しており、
  `discovery.recallId` はもとから存在した値である。この ADR が新設したのは
  「その `recallId` を `meta.note` という別の場所からも引ける形にする」ことだけである。

⟹ **`meta.note` の `recallId` が、2つの記録（イベントログと recall ログ）をつなぐ橋になる。**

**🔴 橋が実際に渡れることを、歯で実測した**（下の「歯」節・「変異試験」節）:
`correction-demo.postgres.test.ts` の中で、実際に書き込まれた `meta.note` から正規表現で
`recallId` を取り出し、`handle.runtime.getRecall(ctx, bridgedRecallId)` を呼んで
`record.explain.stages` が配列として返ることを確認している【実測、下記】。

---

## 設計で選んだこと

### 1. `score.total` は載せない

⛔ **採らない。** ADR 0232 が実測した通り、スコアの閾値は A群（訂正すべき）と B群
（訂正してはいけない）を分離しない（B群の最大 0.90815 > A群の最小 0.87558）——
**スコアは「なぜこの候補を選んだか」の理由になっていない。** この記録に生スコアを
載せると、後から読む側（人）に「スコアが高かったから選ばれた」という誤った説明を
与えてしまう。載せるのは、この経路が実際に守っている契約
（`candidates[0]` を機械的に採らない）を後から検証できる最小の情報
——候補の件数・選んだ候補の順位・どちらへ倒したか・recall への橋——だけである。

⚠ **ただしチェックボックスの逐語は「スコア・順位・候補の数・どちらへ倒したか」であり、
スコアも名指しされている。** ⟹ スコアを `meta.note` に載せない以上、**「橋の先から引ける」が
成り立っていなければ逐語の4つのうち1つが欠ける。** スコアの実際の値は、`recallId` を辿って
`RecallRecord.returnedMemories`（`RecallRecordMemory.score: ScoreBreakdown` を持つ）から読む
——`meta.note` 自体に重複させないという判断である（ADR 0155 決定1「同じことを言う道を
2つ作らない」と同じ形）。

🔴 **【実測】この「引ける」は主張で済ませず、歯で測っている。** `correction-demo.postgres.test.ts`
が、`meta.note` から取り出した `recallId` を `getRecall` へ渡し、`returnedMemories.breakdownCaptured`
が `true` であること・**指名した候補の `memoryId` が `memories` に居ること**・その
`score.total` が数値であることを、本物の Postgres に対して確かめる。⟹ ⭐ **「橋が在る」ではなく
「橋を渡ってスコアに着いた」を測っている。** 空振りでないことも変異で確かめた（下記の表）。

### 2. `markContested` と `resolveContested` に同じ文字列を渡す

⛔ **採らない案**: 2つの操作で異なる `reason`（例えば `markContested` には
「発見時点」の情報だけ、`resolveContested` には「決着」の情報も足す）を作る。
**採った理由**: `winnerId` は `markContested` を呼ぶ時点で既に `scenario.contestedPair`
から分かっている値であり（ADR 0150 決定1、順序規則ではなく宣言）、2つの呼び出しの間で
何も新しい情報が増えていない。**別の文字列を作ると、後から2つの `meta.note` を比較したときに
「何が変わったのか」を説明する責務が増える**——変わっていないなら、同じ文字列を使うのが
最も単純である。

### 3. `ExampleRuntimeHandle` に `eventStore` を足す（`packages/core`/`packages/postgres` は変更しない）

`correction-demo.postgres.test.ts` が「実際に届いたか」を実 DB から読み戻すには、
`EventStore.list()` を呼ぶ経路が要る。`runtime-factory.ts` の `createExampleRuntime` は
既に `memoryStore`/`tenantSettingsStore`/`embeddingProvider`/`pool` を「もともと公開の
クラスだったが、これまで返り値に含めていなかっただけ」という理由で追加してきた
（`ExampleRuntimeHandle` の各欄の doc コメント参照）。`eventStore`（`PostgresEventStore`）も
同じ理由・同じ形で追加する——**additive** であり、既存の呼び出し側（`answer-bench.ts` 等）は
分割代入で個別のキーを見ているだけなので壊れない（【実測】`pnpm --filter @mnemora/example-chat
run typecheck` が通ることで確認済み、下記）。

---

## 🔴 歯が噛むことを示した【実測】— 変異試験

**変異は `cp` で退避・復元した**（⛔ `git checkout` は使っていない。退避先
`/tmp/correction-demo.ts.orig`）。

### 歯（この ADR が新設したもの）

1. `correction-demo.test.ts` の describe「🔴 選んだ根拠が opts.reason 経由で
   markContested/resolveContested へ渡る(Issue #369)」— 偽 Runtime を使い、
   `opts.reason` の中身と、`markContested`/`resolveContested` の両方に同じ文字列が
   渡ることを見る。DB を要求しない。
2. `correction-demo.postgres.test.ts` の既存の1本目の it を拡張——本物の Postgres に
   対して実行後、`handle.eventStore.list(ctx, { memoryId: result.originalId })` で
   `memory_events` を読み戻し、`meta.reason === "contested"`/`"contested_resolved"`
   の各行の `meta.note` に、期待した4つの要素（`recallId`/`chosenRecallRank`/
   `candidates`/`winner`）が実際に**残っている**ことを見る。さらに `meta.note` から
   正規表現で取り出した `recallId` を `runtime.getRecall()` に渡し、
   `explain.stages` が配列として引けることまで見る（橋の実測）。
   ⭐ **さらに、橋の先で `returnedMemories.breakdownCaptured === true` であること・
   指名した候補の `memoryId` が `memories` に居ること・その `score.total` が数値である
   ことまで見る**——チェックボックスの逐語に在る「スコア」が `meta.note` に載っていない以上、
   **スコアに実際に着けることを測らなければ逐語の4つのうち1つが未実測のまま残る**ため。

### 変異1: `markContested` への `opts` 渡しを丸ごと落とす

`markResult = await runtime.markContested(ctx, chosenId, correctionId, { reason: correctionReason })`
を `markResult = await runtime.markContested(ctx, chosenId, correctionId)` に戻した。

【実測】`pnpm --filter @mnemora/example-chat exec vitest run src/__tests__/correction-demo.test.ts`

|              | 変異前    | 変異後                                                                                                                                                                        |
| ------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全体         | 21 passed | **1 failed, 20 passed**                                                                                                                                                       |
| 赤くなった歯 | —         | 「候補2位を指名したケース: reason に recallId・chosenRecallRank(=2)・candidates件数・winner が載り、markContested と resolveContested の両方に同じ reason が渡る」**1本だけ** |
| 他の20本     | 緑        | **緑のまま**                                                                                                                                                                  |

失敗内容（実測ログそのまま、抜粋）:

```
AssertionError: expected undefined to be defined
 ❯ src/__tests__/correction-demo.test.ts:471:45
    expect(calls.markContestedOpts?.reason).toBeDefined();
```

### 変異2: `chosenRecallRank` を `reason` から落とす

`buildCorrectionReason` の戻り値から `chosenRecallRank=${chosenRecallRank} / ` の部分を
削り、`candidates=… / recallId=… / winner=…` だけにした。

【実測】ユニット歯（`correction-demo.test.ts`）:

|              | 変異前    | 変異後                                                          |
| ------------ | --------- | --------------------------------------------------------------- |
| 全体         | 21 passed | **1 failed, 20 passed**                                         |
| 赤くなった歯 | —         | 同じ1本（`chosenRecallRank=2` を含む、という assertion で失敗） |
| 他の20本     | 緑        | **緑のまま**                                                    |

【実測】DB の歯（`correction-demo.postgres.test.ts`）を**同じ変異を当てたまま**実行:

|              | 変異前   | 変異後                                                                                                                 |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| 全体         | 3 passed | **1 failed, 2 passed**                                                                                                 |
| 赤くなった歯 | —        | 「markContested で対になった2件は recall で隣接して出て、resolveContested(supersede) 後は古いほうが消える」**1本だけ** |
| 他の2本      | 緑       | **緑のまま**                                                                                                           |

失敗内容（実測ログそのまま、抜粋）:

```
AssertionError: expected 'candidates=1 / recallId=a438e3b1-f465…' to contain 'chosenRecallRank=2'
Expected: "chosenRecallRank=2"
Received: "candidates=1 / recallId=a438e3b1-f465-43df-8bd5-d549eef45dbf / winner=correction"
```

⟹ **「渡した」だけでなく「実 DB に残った」ことも同じ変異で赤くなる**——ユニット歯（引数の
検査）と DB 歯（`meta.note` の内容の検査）が、それぞれ別の粒度で同じ退行を捕まえる。

### ⭐ 変異3: スコアの歯が空振りでないことを確かめる

**この ADR の書き手とは別の個体（マネージャー）が独立に走らせた検算である。**

DB の歯が `returnedMemories.memories` から探す id を、`result.chosenId` から実在しない
`"bogus-not-a-real-id"` に差し替えた。

|                                            | 変異前   | 変異後                                                          |
| ------------------------------------------ | -------- | --------------------------------------------------------------- |
| 全体（`correction-demo.postgres.test.ts`） | 3 passed | **1 failed, 2 passed**                                          |
| 赤くなった歯                               | —        | 「markContested で対になった2件は…古いほうが消える」**1本だけ** |
| 他の2本                                    | 緑       | **緑のまま**                                                    |

⟹ ⭐ **`expect(chosenInRecall).toBeDefined()` は空振りしていない**——橋の先に指名した候補が
実際に居ることを測っている。

### ⭐ 変異2 の独立再現【実測】

**同じくマネージャーが独立に再現した。** `chosenRecallRank` を `reason` から落としたまま
ユニット歯と DB 歯を**同時に**走らせた:

|                                  | 値                                            |
| -------------------------------- | --------------------------------------------- |
| 全体（24件 = ユニット21 + DB 3） | **2 failed, 22 passed**                       |
| 赤くなった歯                     | ユニット1本＋DB 1本（どちらも上の表と同じ歯） |
| 他の22本                         | **緑のまま**                                  |

⟹ **報告された変異試験は、別の個体が引き直しても同じ形で再現した。**

**`cp` で復元した後**、両方の歯（`correction-demo.test.ts` 21件・
`correction-demo.postgres.test.ts` 3件、計24件）を再実行し、全件緑に戻ることを実測した。
`diff /tmp/correction-demo.ts.orig examples/chat/src/correction-demo.ts` が無出力
（同一）であることも確認した。

---

## 🔴 この ADR が着地させないもの

- ⛔ **ADR 0232/0235 が引き受けた負債（B群の深い誤爆 75%・棄権率0/8を下げる措置）は
  何も変えていない。** この ADR は「選んだ結果を後から辿れるようにする」記録を足すだけで
  あり、選び方そのもの（人が明示的に指名する、という ADR 0235 の決定）は1つも変えていない。
- ⛔ **`chosenRecallRank` の分布を実際に監視する仕組み（ダッシュボード・アラート・門）は
  作っていない。** この ADR が可能にしたのは「後から `memory_events` を読めば分かる」
  ことまでであり、「誰かが実際に定期的に読む」仕組みは範囲外——「なぜログを見る側の
  仕組みを作らないのか」への回答は、Issue #369 のチェックボックス自体がそこまでを
  要求していないため、という以上のものではない。

## ⛔ 確かめられなかったこと

1. **実運用（実 API・実 embedding・実際の UI 選択）で `chosenRecallRank` がどう分布するかは
   測っていない。** `correction-demo.ts` は `deterministic` provider で走る
   （ADR 0235 の「確かめられなかったこと」と同じ層）。この ADR が新設した記録が
   実際に「退行を検出する」場面に遭遇したことは、この作業の中では一度も無い
   ——検出できる**形**を作った、というだけである。
2. **`meta.note` の文字列を機械的にパースして統計を取る後段の仕組みは、この作業の範囲では
   書いていない。** `key=value / key=value` 形式にしたのは「人が読める」ことと
   「正規表現で拾える」ことの両立を狙った選択だが、実際にその正規表現をプロダクション
   コードとして書いたのは `correction-demo.postgres.test.ts` の歯だけであり、
   運用ツール側の実装は無い。
3. **`markContested`/`resolveContested` の `opts.reason` が他の呼び出し元
   （`packages/core` のテスト等）にどう影響するかは、この ADR の変更が `packages/core` を
   一切触っていないため確認の対象外**——`reason` は元から省略可能な欄であり、
   この ADR は「`examples/chat` からその欄を初めて使う」だけである。

⚠ **一般化しないこと**: この ADR が保証するのは「`correction-demo.ts` の今日の呼び出しが、
選んだ根拠を `memory_events.meta.note` と `RecallResult.explain` の両方から辿れる形に
なっている」ことだけであり、「訂正の相手選びの説明責任が一般に果たされている」ことでは
ない。

## これが覆るとしたら

- **`reason` の自由文字列という形が、後から機械可読性の要求（例: JSON 形式で持ちたい、
  監視ツールに食わせたい）と衝突したとき。** そのときはこの ADR の「`key=value` 区切りの
  1行」という形式そのものを見直す必要がある。
- **ADR 0232/0235 の「これが覆るとしたら」節と同じ条件**（機械が選ぶ形へ戻る場合）が
  満たされたとき——そのときは `chosenRecallRank` という値自体の意味が変わる
  （「人が選んだものの順位」ではなく「機械が選んだものの順位」になる）ため、
  この記録の読み方も変わる。

## 採らなかった案

### 1. `CorrectionDemoResult` に `correctionReason` フィールドを追加して露出する

⛔ **採らない。** `reason` は `markContested`/`resolveContested` の呼び出しの引数として
一度使われれば目的（`meta.note` への到達）を果たす。`CorrectionDemoResult`
（既存の型）に新しい必須フィールドを足すと、`correction-demo.test.ts` 内の複数の
テストが直接組み立てている固定値フィクスチャ（`as unknown as CorrectionDemoResult` で
型検査を迂回している箇所）にまで波及する経路を増やす。**この ADR の目的（`meta.note`
に届くこと）に対して、結果型を太らせる理由が無い。**

### 2. `meta.note` に `discovery.candidates` の全件（各候補の digest・score）を JSON で埋め込む

⛔ **採らない。** Issue #369 のチェックボックスが求めているのは「選んだ根拠
（スコア・順位・候補の数・どちらへ倒したか）」であり「候補の全内容」ではない。
候補の digest を丸ごと監査ログに複製すると、`RecallRecord`（`recallId` を辿れば
既に手に入る）と同じ情報を2箇所に持つことになる——ADR 0155 決定1「同じことを言う道を
2つ作らない」に反する。
