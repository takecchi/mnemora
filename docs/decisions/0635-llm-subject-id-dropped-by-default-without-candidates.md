# ADR 0635: `subjectCandidates` を渡さない抽出では、LLM が返した `subjectId` を既定で捨てる（`acceptLlmSubjectIdWithoutCandidates` で受ける）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**担い手が書いた（マネージャー mgr-67f2a813 の指示）。オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが決めたのは次の1点だけである**: 「オーナー回答 374f6f88 の問15（全部推奨）」——`subjectCandidates` を渡さない抽出では LLM が返した `subjectId` を既定で捨て、受け入れるのは opt-in にする、という推奨の採否。破壊的変更を v1.X.0 で出してよいことも、オーナーの回答による（ask_human 6911db12。README・CHANGELOG に記録あり）。
**オプションの名前・置き場所・捨てる範囲の細部・歯の形は、担い手が決めた。** オーナーが覆せる点は「これが覆るとしたら」にまとめた。

## 文脈

[ADR 0442](./0442-migrate-deadlock-subject-injection-ddl-lock-wait-docs.md)（PR #1551）は、`subjectCandidates` を渡さない抽出が LLM の `subjectId` をそのまま Memory の主題にすることを、文書の警告だけにした（代替案3の「違う値を捨てる」はオーナーに回した）。
観察文の注入で、同じテナントの別の subject に記憶を書かせられ、claim key の検出を併用するとその subject の active な記憶が `contested` になりうる。`extract: 'deferred'` の `tick` と `reextract` は一覧を持てないので、常にこの経路を通る。
オーナーは問15で、既定を変えることを推奨どおり採った。

【現物】変更前の流れ: `extractCandidates`（`packages/core/src/extraction.ts`）→ `sanitizeCandidateSubjectId` は、一覧が無い（省略・空配列）と、NUL・孤立サロゲートを含む値（ADR 0456）以外を「常に有効」にする → `buildNewMemoryFromCandidate` が候補の `subjectId` を observation の `subjectId` より優先する（ADR 0271）。`runExtraction`（`observe()` の sync と `tick` の extract ジョブ）と `reextract` の2か所が `extractCandidates` を呼ぶ。

## 決めたこと【判断】

1. **`RuntimeConfig.acceptLlmSubjectIdWithoutCandidates?: boolean`（既定 `false`）を足す。** `false` のとき、`subjectCandidates` が無い（省略・空配列）抽出では、LLM が返した候補の `subjectId` を捨てる。Memory の主題は observation の `subjectId`（無ければ主題なし）になる。`true` なら従来どおり受ける。
2. **置き場所は `RuntimeConfig`（runtime の設定）にした。** 抽出の引数にしなかった理由: `extract: 'deferred'` の `tick` と `reextract` には、呼び出しごとの引数を運ぶ口が無い（`subjectCandidates` や `claimKey` が deferred と併用できないのと同じ理由。ADR 0287・0315）。引数にすると、一番危ない経路（tick・reextract）だけ既定が変わらないか、別の設定が要る。`RuntimeConfig` の既存の opt-in（`autoQueueConsolidateReflectOnExtract`）と同じく、`createRuntime` で1回決める形に合わせた。名前は、何を（LLM の subjectId）・どの条件で（一覧なしで）受けるかが、名前だけで読めるようにした。
3. **捨てる範囲**: `subjectCandidates` が無い抽出での、候補の `subjectId` だけ。文字列も明示の `null` も捨てる（一覧の無い抽出のプロンプトは `null` を指示していないし、`null` で observation の主題を消せると、主題を指定した検索から記憶が見えなくなる別の経路になる）。`subjectId` 以外の欄（`content`・`digest`・`tags`・`provenanceKind`・`confidence`）には触れない。
4. **`subjectCandidates` を渡した `observe()` は変えない。** 一覧内の値は採り、一覧外は弾いて `rejectedSubjectIds` に残し、一覧内の明示の `null` は主題なしにする（ADR 0304 の文字列 `"null"` の特例も含む）。オプションを `true` にしても、この挙動は同じ。
5. **実装の場所**: `extractCandidates`・`sanitizeCandidateSubjectId`（公開の関数）は変えず、`runtime.ts` の `runExtraction` と `reextract` が抽出の結果を受けた直後に捨てる。公開の関数の署名・テストを動かさないため。
6. **文書**: `ExtractedMemoryCandidateSchema.subjectId`・`SubjectCandidatesInput`・`ObserveResult.rejectedSubjectIds`・`Runtime.reextract` の TSDoc と `docs/architecture.md` の抽出の主題の節で、ADR 0442 の警告を「既定では捨てる。opt-in で受ける」に更新した（ADR 0442 の本文は書き換えていない）。CHANGELOG の `[1.3.0]` 節 `### Breaking` と `docs/migration-v1.md` の項目66 に載せた。

## 検討した代替案

1. **一覧が無いとき、observation や `ctx` の `subjectId` と違う文字列だけを捨てる（`null` は通す・一致する値は通す）。** 採らなかった。オーナーの推奨は「`subjectId` を既定では捨てる」で、一致する値を通す分岐は、「いつ採られるか」を利用者が説明しにくくする。また observation に主題が無いときは何と比べるかが決まらない。
2. **抽出の引数で opt-in にする。** 決めたこと2の理由で採らなかった。
3. **捨てた値を `ObserveResult` に出す。** 今回はしなかった（下の負債）。`rejectedSubjectIds` は「`subjectCandidates` を渡した呼び出しだけが持つ」規約（`ObserveResult` の TSDoc）で、規約を変えると「渡していない呼び出しでキーが無い」を縛る既存の歯と型の約束に触れる。
4. **`acceptLlmSubjectIdWithoutCandidates` を、`true` のとき一覧外でも検証する形にする。** 一覧が無いのに検証しようがない。採らなかった。

## 引き受けた負債

- **捨てた値は、どこにも出ない。** 一覧を渡さない呼び出しで LLM が `subjectId` を返しても、`ObserveResult`・イベントには残らない（黙って戻す）。必要なら別の決定で `created` イベントの `meta`（ADR 0443 の `droppedFields` と同じ形）に載せる。
- 候補ごとの主題の上書き（ADR 0271）を、一覧を渡さずに使っていた呼び出し側は、`acceptLlmSubjectIdWithoutCandidates: true` を足すまで効かなくなる。安全でない入力を扱うなら `true` にせず、`subjectCandidates` を渡すこと。
- `@mnemora/openai` は明示の `null` を落とす（Issue #1082）ので、`true` でも `null` は届かない。今回も変えない。
- 実際の LLM で、一覧を渡さない抽出が返す `subjectId` の頻度は測っていない。

## これが覆るとしたら（オーナーへ）

- オプション名・置き場所（`RuntimeConfig`）。
- `null` も捨てる範囲（決めたこと3）。「文字列だけ捨てて `null` は通す」にもできる。
- 捨てた値の通知（上の負債）。

## 追記（2026-10-06、PR #1737 の確かめ直し。クローン miku の委譲先が書いた。オーナーの判断ではない）: 決めたこと6の訂正

**決めたこと6は「`ObserveResult.rejectedSubjectIds` の TSDoc を更新した」と書いているが、この PR はその TSDoc を変えていない。**
`ObserveResult.rejectedSubjectIds` の TSDoc は「一覧を渡さなかった呼び出しでは欄が無い」と書いており、既定の変更の後もそのまま正しいため、更新は要らなかった。
捨てた値が `ObserveResult` に出ないことは、`RuntimeConfig.acceptLlmSubjectIdWithoutCandidates` の TSDoc と上の「引き受けた負債」に書いてある。
決めたこと6のほかの記述（`ExtractedMemoryCandidateSchema.subjectId`・`SubjectCandidatesInput`・`Runtime.reextract` の TSDoc、`docs/architecture.md`、CHANGELOG、migration の項目66）は、この PR の差分と合っている。
