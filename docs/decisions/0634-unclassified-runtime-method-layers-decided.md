# ADR 0634: `層: 未分類` だった `Runtime` のメソッドの層を1本ずつ決める（Issue #605 の続き、ADR 0633）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

> **⚠ この判定はクローン（オーナーの価値観を写した担い手）のものであり、⛔ オーナー本人の判定ではない。**
> ADR 0633 は「`未分類` はあとで1本ずつ決める」と書いた。そう書いたのはクローンであり、
> この分類は公開の型も既定値も変えない doc の分類なので、クローンが決めた。
> 材料（候補・両論・実装の根拠・推奨）はマネージャー mgr-f1a44881 が作り、決めたのはクローンである。
> 署名ではクローンとオーナーを区別できない（ADR 0220）。⟹ **この ADR を「オーナーが決めた」と読まないこと。**

- **【現物】** — 読んだコード・文書。**【実測】** — 手元で走らせた結果。**【受】** — 報告として受け取り、再導出していない。

**測定条件**: 断りの無い【現物】【実測】は `origin/main` = `cb891be3` の木（2026-10-06）。

## 文脈

- 【現物】ADR 0633 は層の正本を `packages/core/src/runtime.ts` の各メソッドの doc コメントの `層:` 行に移し、
  判断が割れているものを `層: 未分類` にした。対象は `tick` / `reextract` / `restoreSuperseded` /
  `applyCorrection` / `findCorrectionCandidates`。
- 【現物】前の4本は、[Issue #605](https://github.com/takecchi/mnemora/issues/605) のコメント（2026-09-23）の
  表3が「候補（両論あり）」としたもの。`findCorrectionCandidates` は同じ表で「候補ではない（確認）——3文書の
  『未配置』判断は、ADR 0171 の3定義を逐語で当てても崩れない」とされていたもの。
- 層の定義は README.md「中核を守る3つの層」の逐語による（ADR 0171）:
  - 保守操作——「いつ動かすか」を呼び出し側が決める口。自動では走らない。
  - 是正・取り消し——呼び出し側が既に下した判断（矛盾の指摘・決着・復帰・完全削除）を、決められた形で
    書き込む口。どちらが正しいかを mnemora 自身は判定しない。
  - 説明——なぜそれが想起されたかを、後から読み戻す口。

## 決定

1. **物差しを「そのメソッド自身が何を決めるか」に揃える。**呼んだ先で何が起きうるか（委譲した先・
   駆動したジョブが何を書くか）は、層を分ける理由にしない。この物差しで残る懸念は「引き受けた負債」に書く。
2. **`tick` → `保守操作`。**
   - 【受・一部現物】`tick` 自身が書くのは outbox の状態（claim / complete / fail）だけで、ジョブを kind で処理へ配る
     だけである。何を書くかは決めない。runtime の中に `tick` を自動で呼ぶ経路は無い（駆動は呼び出し側か
     `@mnemora/bullmq` の tick driver、ADR 0325）。
   - 【現物】`consolidate` / `reflect` のジョブは `processConsolidateJob` / `processReflectJob` が
     `consolidate()` / `reflect()` をそのまま呼ぶ。そのジョブを抽出時に自動で積むのは
     `RuntimeConfig.autoQueueConsolidateReflectOnExtract`（既定 `false`）を有効にしたときだけ（ADR 0157）。
3. **`reextract` → `保守操作`。**
   - 【受】使う抽出関数は observe の抽出と同じ `extractCandidates` で、新しい種類の判断を持たない。対象は
     呼び出し側が指定した Observation 1件で、決めているのは「observe が既にした抽出を、いつやり直すか」である
     （doc の自己位置づけ「失敗した抽出をやり直す」、ADR 0028）。自動で呼ばれる経路は無い。
   - `中核` は5動詞で閉じているので、そもそも置き先の候補にならない。
4. **`restoreSuperseded` → `是正・取り消し`。**
   - 【受】`superseded → active` に戻してイベントを積み、`reinforce` する。戻す対象は呼び出し側が渡す
     `supersededById`（必要なら `onlyMemoryIds`）で決まり、LLM も埋め込みも呼ばない。doc は
     「`restoreArchived` が `sweepArchive` に対して果たしたのと同じ役割」と書いている。定義の「復帰」に当たる。
   - #605 のコメントの Reading B（ADR 0171 の逐語の member 列挙に無い＝未検算のまま広げた）は意味の反論ではなく
     手続きの指摘であり、この ADR が検算したことで解消する。
5. **`applyCorrection` → `是正・取り消し`。**
   - 【現物】`correctedId` と `correctingId` は必ず呼び出し側が渡す。`memoryStore` に対してするのは `get` だけで、
     書き込みは `markContested` / `resolveContested` を呼んで行う。【受】中でやるのは候補に入っているかの照合と
     winnerId の検査だけで、LLM は呼ばず、自動で呼ばれる経路も無い。
   - 「選択」をしているのは呼び出し側であり、このメソッドはその選択を矛盾の指摘・決着として書く。定義の
     「既に下した判断を書き込む」に当たる。#605 のコメントの Reading B（自分で store を触らないラッパーである）は
     実装の形の話であり、決定1の物差しでは層を分ける理由にならない。
6. **`findCorrectionCandidates` → `未分類` のまま。3つの定義のどれにも当たらないと確かめたうえで、置かないと決めた。**
   - 【受】Memory の状態は動かさない（中で `recall()` を1回呼ぶので recall の記録は1件書かれる、Issue #1244）。
     相手を選ばず、recall のスコア順をそのまま返す。
   - 保守操作ではない（「いつ動かすか」の口ではない）。是正・取り消しではない（判断を書き込まない）。
     説明ではない（過去の recall を後から読み戻すのではなく、新しく recall する）。
   - ⛔ **4つ目の層は作らない。**3層という構造を変えるかどうかはオーナーの領分である（#605 本文が名指しした
     オーナー領分の3点目「3層という分類そのものを維持するか」）。下の「これが覆るとしたら」に問いの候補として書くに留める。
7. **`未分類` の意味を広げる。**README.md / docs/vision.md / docs/architecture.md の `未分類` の説明に、
   「判断が割れているもの」に加えて「3つの層の定義のどれにも当たらないと確かめたうえで、置かないと決めたもの」も
   入る、と1文足す。個数は書かない（AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。
8. **歯は変えない。**`scripts/__tests__/runtime-method-layer-line.test.mjs` は値が5種のどれかであることだけを見る
   （ADR 0633 決定2）。今回の変更は値の書き換えだけなので、歯を先に赤くする変更は無い。

## 採らなかった案

- **物差しを「呼んだ先で何が起きうるか」まで含める。**`tick`（`consolidate` / `reflect` を駆動しうる）と
  `reextract`（LLM 判断で Memory を作り supersede する）は `未分類` に残るのが筋になる。その場合、
  `未分類` はいつまでも決まらないものの置き場になる。
- **`findCorrectionCandidates` を `説明` に置く。**「後から読み戻す」という定義が崩れる。
- **`findCorrectionCandidates` のために4つ目の層（例: 発見）を作る。**上の決定6のとおり、オーナーの領分である。
- **`reextract` だけ `未分類` に残す。**材料の段では選択肢として示したが、決定1の物差しを揃えた以上、
  `tick` と扱いを分ける理由が無い。

## 引き受けた負債

- **`tick` 経由で中核と同じ書き込みが走る。**`autoQueueConsolidateReflectOnExtract` を有効にすると、
  抽出で作った Memory に `consolidate` / `reflect` のジョブが積まれ、`tick` が `consolidate()` / `reflect()` を
  そのまま呼ぶ。ADR 0171 決定2 の歯止め（「中核5動詞と同じ性質なら足せない」）は、この経路では `tick` という
  保守操作の名前の下を通る（#605 のコメントの `tick` の Reading B）。層は `tick` 自身が決めることで付けたので、
  この懸念は層では表さない。opt-in の設定の性質として残る。
- **`reextract` は LLM 判断を伴って Memory を作り、旧い方を supersede する。**書き込みの性質は `consolidate`
  （LLM + 作成 + supersede）に近い（#605 のコメントの `reextract` の Reading B）。保守操作の他のメソッド
  （`reembed` / `sweepArchive`）は LLM を呼ばない。「保守操作は LLM を呼ばない」と読む人には誤解を生む。
- **`未分類` の意味が2つになった。**「判断が割れている（あとで決める）」と「置かないと決めた」が同じ値で
  表される。どちらかは `層:` 行だけでは分からず、この ADR を読む必要がある。
- 層の値の意味が正しいかを見る歯は無い（ADR 0633 の負債と同じ）。

## これが覆るとしたら

- **オーナーへの問いの候補**: 「3層という構造を保つか。`findCorrectionCandidates` のような『発見』の口
  （書き込まず、呼び出し側の判断の材料を返す）のために4つ目の層を作るか」。オーナーが4つ目の層を作ると
  判断すれば、`findCorrectionCandidates` はそこへ移る。
- `autoQueueConsolidateReflectOnExtract` の既定が `true` になる、または `tick` が自分で何を処理するかを
  決めるようになったとき（`tick` の「自身は何も決めない」が崩れる）。
- `reextract` が observe の抽出とは別の判断（observe の抽出に無い基準）を持つようになったとき。
- `applyCorrection` が相手を自分で選ぶようになったとき（ADR 0232 / 0242 が退けた形）。
- 物差し（決定1）そのものを「呼んだ先で何が起きうるか」まで含める形に変えるとき。

## 測ったこと / 確かめていないこと

**測ったこと**:
- 【現物】`TICK_SUPPORTED_JOB_KINDS = ["extract", "embed", "consolidate", "reflect"]`、consolidate / reflect の
  ジョブの処理が `consolidate()` / `reflect()` をそのまま呼ぶこと、`autoQueueConsolidateReflectOnExtract` の
  既定が `false` であること、`applyCorrection` が `memoryStore` に対してするのが `get` だけであることを grep で確かめた。
- 【実測】`層:` 行を書き換えた後、層の行の歯が緑であることと、`pnpm api:check` の差分0を確かめた（PR の本文を参照）。

**確かめていないこと**:
- 【受】の各項目は、作業者が `runtime.ts` を読んだ報告による。`consolidate` 本体と `classifyReextractTargets` は
  全行を読んでいない。
- `reextract` / `restoreSuperseded` / `applyCorrection` を自動で呼ぶ経路は無い、という主張は、`runtime.ts` と、
  それ以外のテストでない `.ts` を grep した範囲での結果であり、断定ではない。examples は精査していない。
