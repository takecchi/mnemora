# ADR 0670: 09/18 にマージされた Runtime.applyCorrection（#537）と publish.yml の門の shell の歯（#546）の確かめ直しで見つかった穴に歯を足す（Issue #1804）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1804](https://github.com/takecchi/mnemora/issues/1804)。
これは試験だけの変更で、`packages/core/src/*`・`.github/workflows/publish.yml`・実装は触らない。

## 経緯【実測】

2026-09-18（UTC）にマージされた PR は11本で、対象にしたのは4本（#537・#543・#545・#546）。残り7本（#533・#535・#538・#539・#540・#542・#544）は文書・コメント・ADR への追記だけで、機械の約束が無い。分母は Issue #1804 にある。変異は main `85d8bb9b` の上で、控えを `cp` で取って当て、`cp` で戻して `cmp` で一致を確かめた。

### #543 は止めた（約束が狭まっていた）

ADR 0244 決定1（3文書が中核以外の全メソッド名を並べる）が #543 の主たる約束だった。ADR 0633 決定3・4（#1736）は、層の正本を `runtime.ts` の各メソッドの `層:` 行へ移し、3文書から列挙を外し、決定1を一部覆して旧 it 4 を外した。残っているのは中核5動詞の literal の実在・抽出の陽性対照・3文書が空でないことだけである。撤回された約束の周りを固めないために、当てていない。

### #537 applyCorrection（ADR 0242。ADR 0446・0496 が足した形が今の約束）

ADR 0446 は `winnerId` の検査を `markContested` の前へ移し、大文字小文字だけ違う `correctedId` は store が同じ記憶と言えば候補とした。ADR 0496 は未知の `resolution.kind` を書き込み前に `RangeError` にした。ADR 0291・0321 は `findCorrectionCandidates` の側で、`applyCorrection` の約束は変えていない。狭まった約束は無かった。

`packages/core` の試験（関連7ファイル、生き残りは全 318 ファイル）で、`runtime.ts` の `applyCorrection` と `apply-correction.ts` の `buildCorrectionReason`、`examples/chat/src/correction-demo.ts` に変異を当てた。素通りしたもの（歯を足す前）:

- `correctedId` が空文字のとき `awaiting_choice` にする（`!input.correctedId`。約束は `undefined` だけ）
- 綴り違いの候補の照合で、候補側を store が返さない（null）と TypeError になる
- `actor` を `markContested`・`resolveContested` のどちらかから外す
- 順位を詰め直す（`chosenRecallRank` を `indexOf + 1` にする。約束は候補の `recallRank` そのもの）
- `markContested`・`resolveContested` の引数（訂正される側・する側）を入れ替える（`sides` の並びとイベントの順が観測できるのに誰も見ていない）
- `resolveContested` の例外を握り潰す
- `buildCorrectionReason`: 完全一致を先に採る優先を外す／大文字小文字の照合を丸ごと外す／両方に合うときの倒し方を変える／前方一致で照合する（ADR 0446 決定3。この約束の歯は DB が要る `packages/postgres` 側にしか無かった）

既存の歯で赤になったもの: 検査を外す・順を `markContested` の後へ戻す・`candidates[0]` を採る・store の同一性確認を外す・reason を外す・`score.total` を載せる・件数や項目の順を変える・`index.ts` の export を外す（`pnpm run api:check` が止める）・デモ側の10形。

### #545 使用報告による選別（試験だけの PR）

約束は変わっていない。`handleMemoryUsage` への変異は、この試験自身では強化の時刻を巻き戻す形だけが赤で、複数件の報告・2段の経路（`recordUsageAndReinforce` が無い adapter）の形は、全 core では既存の別の試験（`memory-usage-reinforce-inserted-only.test.ts`・`memory-usage-record-and-reinforce.test.ts`・`runtime.test.ts`）が赤にしていた。穴は 0。

### #546 publish.yml の門の shell（ADR 0245。#667 で門が単一コマンドになった形が今の約束）

撤回された publish の CHANGELOG 門（#601・ADR 0267・0664）は、この歯の対象ではない（この歯は CHANGELOG を読まない）ので当てていない。素通りしたもの（歯を足す前。`publish-yml-*` の4ファイルが全部緑のままだった）:

- `defaults: { run: { shell: "bash {0}" } }`（フロー形式。既存の判定は行末が `defaults:` で終わる形だけを見る）
- step の `shell:` を `- shell: …`（step の先頭のキー）・`"shell": …`（引用符つきのキー）・`- { shell: …, name: … }`（フロー形式）で書く（既存の抽出は行頭の `shell:` だけ）
- 門ステップに `if: false`・`"if": …`・`if: ${{ false }}`（門ごと飛ぶ）、`"continue-on-error": true`（引用符つき）

先の #1784（ADR 0666）が見つけた形がここでも出た。**ある書き方しか見ない歯は、同じ門を別の書き方で外す変異を通す。**

## 決定【判断】

1. 実装・`publish.yml` は変えない。足すのは試験だけである。
2. `packages/core/src/__tests__/apply-correction-passthrough.test.ts`（新規9本）
   - 空文字の `correctedId` は `not_a_candidate`
   - 候補側を store が返さなくても TypeError にしない
   - `actor` が mark・resolve の4件に載る
   - `sides` とイベントの順は「訂正される側, 訂正する側」
   - `chosenRecallRank` は候補の `recallRank` そのもの
   - `markContestedPair`・`resolveContestedPair` の例外はそのまま reject する
3. `packages/core/src/__tests__/apply-correction-reason-spelling.test.ts`（新規8本）: `winnerId` の綴りが違っても `buildCorrectionReason` は実際の勝者の側を書く（完全一致の優先・大文字小文字・前方一致では決めない・決まらなければ `corrected`）。
4. `scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs` に2本。
   - `shell` の値は、キーの書き方（`- shell:`・引用符・`{ }` の中）によらず bash / sh だけ。
   - 門ステップに `if:`・`continue-on-error` が無い（キーを引用符で囲んでも同じ）。
5. 等価な変異は歯にしない。`buildCorrectionReason` の完全一致の判定の順を入れ替える変異（B2）は、`correctedId` と `correctingId` が同じでなければ2つの完全一致が同時に成り立たないので等価である（`apply-correction.ts` の `supersedeWinnerLabel`。同じ id は `markContested` が `RangeError` で断る）。
6. 決定4の2本目（`if:` を持たない）は、「門が走る」という今の約束に照らしたクローンの判断で、ADR 0245 の条文ではない。門を条件つきにする正当な理由が出たら、ADR を積んでこの歯を直す。

当てた変異は全部、赤になること・戻して緑になること・`cmp` で控えと一致することを確かめた。

## 確かめていないこと

- `packages/postgres` の `applyCorrection` の試験（`apply-correction-case-and-no-partial-write.postgres.test.ts`）は、手元に Postgres を立てていないので走らせていない。core の Fake の上で足りた。
- GitHub が `if:`・`shell:` を本当にそう評価するか（元の歯と同じ。YAML は構造として解析せず、文字列で見ている）。
- `ci.yml` のステップ名（#533）と文書だけの PR（#535・#538・#539・#540・#542・#544）は、機械の約束が無いので測っていない。
- #543 の残りの部分（中核5動詞の literal・抽出・空でない）には当てていない。
