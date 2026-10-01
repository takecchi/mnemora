# ADR 0484: 穴探し55巡目 — `recall` の `channels`（ANN・lexical）の候補の合流を、実 Postgres の2つの語彙 store で ADR 0084 の表に照らして縛る（草稿・作業中）

- **状態**: 草稿 (2026-10。作業中。実測の結果で書き換える)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 下調べの要点（この草稿の時点。器の入れ替えで文脈が失われても引き継げるように、先に書く）

- **選んだ面**: `RecallQuery.channels: ["ann", "lexical"]` のとき、2つのチャンネルが返した候補の**合流**（和集合・重複の扱い・`retrievedVia`・`score`・並び・`explain.stages`）を、実 Postgres の**2つの語彙 store**（`PostgresLexicalStore` = tsvector、`PostgresTrigramLexicalStore` = pg_trgm）で、ADR 0084 の表に照らして検査する。
- **契約**【現物】:
  - `packages/core/src/recall-runtime.ts:1153-1330`: ANN と語彙のチャンネルを実行し、それぞれ `candidate_generation` の trace を積む（`channel: "ann"`／`"lexical"`）。
  - `:1296-1310` 付近: 和集合。`rawById` に「ANN が返した順 → 語彙だけが返した順」で積み、両方が当てた記憶は `distance` と `lexicalCoverage` を1件にまとめる。
  - `:1426`: `retrievedVia: distance === undefined ? "lexical" : "ann"`。
  - ADR 0084 の表（L363 付近）: 「両方が当てた → `retrievedVia: "ann"`」。affinity は `max(similarity, lexicalMatch)`。
- **歯の現状**: core の fake では `packages/core/src/__tests__/recall-channels.test.ts` が 9 群（歯①〜⑨）。実 Postgres では `channels` を渡す歯が 14 箇所（`recall-filter-combination-parity.postgres.test.ts:242` は filter とチャンネルをランダムに組む）あるが、**同じ記憶を両チャンネルが当てたときの合流（1件にまとまる・`retrievedVia`・`score` の両方の欄・trace が2つ・2つの語彙 store の両方で成り立つ）を実 Postgres で縛る歯は見当たらない**【実測。grep】。52巡目（ADR 0481）は「既存の歯に委ねた」として当てていない。
- **gh の件数**: `lexical_truncated` は closed の issue 2・PR 9、`channels lexical` は closed の issue 2・PR 3、`lexicalMatch` は closed の issue 11・PR 15、`語彙チャンネル` は closed の issue 19・PR 30、`PostgresTrigramLexicalStore` は closed の issue 8・PR 23。open は 0。ADR 0084・0092・0319 が既出。
- **当て方**: 実 Postgres + fake の LLM・埋め込み。同じ文面で ANN にも語彙にも当たる記憶・ANN だけ当たる記憶・語彙だけ当たる記憶を作り、`channels: ["ann","lexical"]` を2つの語彙 store で当てる。見る: 重複しない／`retrievedVia`／`score`（`similarity`・`lexicalMatch` の有無と値域 `(0, 1]`）／順序／`candidate_generation` が2つ。従: `limit`・`overFetchFactor` を絞った形、`lexical_truncated`・`ann_truncated`（undecidable）。陽性対照: core の fake の既存の歯（歯①・歯⑨）と、合流の規則を壊す変異（`retrievedVia` の三項を逆にする）で新しい歯が赤になること。
- **線**: 食い違いが出れば、実装を ADR 0084 の表に戻すのは内側（直す。直す前の赤を先に見せる）。合流の規則そのものの変更は外側（材料）。`limit` を絞ったときの同点の並びの非決定性の疑いが出たら、ADR 0170 との関係を確かめてから決める。何も出なければ、当てた記録（この ADR）と実 Postgres の歯が成果。
- **見送った候補**:
  - **候補2 `getObservation`・`listBySourceObservation` の payload の往復**: ADR 0482（`observe()` の入力、`event.data` の JSON で往復しない値）と同じ jsonb の往復の入力表を使うことになり、境を引くと「`createObservation` への直接呼び」に限られて価値が薄い。
  - **候補3 `createOptionalTrigramIndex[Concurrently]` の失敗経路**: `trigram-index-concurrently-lock-mode.postgres.test.ts` が、TSDoc の約束の3点（ロック種別・トランザクション内で投げる・INVALID な索引が残っても作り直す）を、キャンセルで本当に INVALID な索引を作る形で縛っている。残るのは別スキーマの INVALID な索引と DROP/CREATE の間の競合で、再現が難しく、ADR 0460・0464 の隣。
- **避けた面**: ADR 0480（`RecallRecord`・`getRecall`）、0481（実 Postgres の recall の `outputValidation`）、0482（`observe()` の入力）、0483（`TokenCounter` と `maxTokens`）、47巡目 taxonomy（labels は使わない）、50巡目（テナント設定）。

## 実測の結果

（作業中。追記する。）
