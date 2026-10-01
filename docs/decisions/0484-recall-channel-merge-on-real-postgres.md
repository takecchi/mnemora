# ADR 0484: 穴探し55巡目 — `recall` の `channels`（ANN・lexical）の候補の合流を、実 Postgres の2つの語彙 store で ADR 0084 の表に照らして縛る（ずれは見つからなかった）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 下調べの要点

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

## 決定（線の内側＝歯だけ。実装は変えていない）

- 歯 `packages/postgres/src/__tests__/recall-channel-merge.postgres.test.ts`: 記憶 3 件（A = ANN にも語彙にも当たる、B = ANN だけ〔語彙の語を含まない〕、C = 語彙だけ〔ベクトルが遠く、`overFetchFactor: 0.2` で k' = 2 にして ANN の窓から外す〕）を作り、`channels: ["ann","lexical"]` を、**語彙 store 2 つ**（`PostgresLexicalStore` = tsvector、`PostgresTrigramLexicalStore`）で当てる。埋め込みの fake はどの文面も `[1, 0, 0]`。各 store で 6 本:
  1. 同じ記憶は 1 件にまとまり（memoryId が重複しない）、A・B・C の 3 件が返り、**A は `retrievedVia: "ann"` で `similarity` と `lexicalMatch` の両方を持ち、B は `ann` で `lexicalMatch` が無く、C は `lexical` で `similarity` が無い**。`lexicalMatch` は A・C とも `(0, 1]`。
  2. `explain.stages` の `candidate_generation` は channel ごとに 1 つ（`ann`、`lexical` の順）で、どちらも `executed`。
  3. A の `score.total` は `max(similarity, lexicalMatch) × decay × tagMatch × freshness × strength`（ADR 0084 の affinity）。
  4. 同じ query を 5 回繰り返しても順序が同じ（同点の並びが揺れない。ADR 0170 の隣の確認）。
  5. `limit: 1`・`overFetchFactor: 1` に絞っても重複せず 1 件で、`omitted` に `lexical_truncated` が出る。
  6. 陽性対照: `channels: ["ann"]`（既定）では C が入らず、どの記憶にも `lexicalMatch` が付かない。
- **CI の 2 脚（UTF8／SQL_ASCII）への備え**: `PostgresTrigramLexicalStore.create` は SQL_ASCII の脚では pg_trgm を使えず投げる（ADR 0319）。そこで trigram の歯は、`create` が `TRIGRAM_LEXICAL_STORE_UNAVAILABLE_ERROR_PREFIX` つきで投げた環境では、skip ではなく「使えないこと」を主張して終える（ADR 0103 の作法）。手元で同じクラスタに `ENCODING 'SQL_ASCII' LC_COLLATE 'C'` の DB を作り、両方の DB で 12 本緑を確かめた【実測】。
- **実測の結果**【実測。手元の PostgreSQL 17（`initdb`、UTF8 + C.UTF-8）+ pgvector、node v22.23.3】: 12 本（2 store × 6）すべて緑。**ADR 0084 の表からのずれは見つからなかった**。core の `recall-channels.test.ts`（歯①〜⑨、17 本）も緑。
- **歯が赤くなることの陽性対照**【実測。変異】: `recall-runtime.ts:1426` の `retrievedVia` の三項を逆にする（`distance === undefined ? "ann" : "lexical"`）と、「同じ記憶は 1 件にまとまり…」が 2 store の両方で赤になった（12 本中 2 本。他は `retrievedVia` を見ない）。`cp` で退避して戻し、戻した後は 12 本緑。

## 探した形の一覧

- 当てた形: 両方が当てる（A）／ANN だけ（B）／語彙だけ（C）の 3 通り × 2 つの語彙 store、k' を絞る（`overFetchFactor: 0.2`）、`limit: 1` で `lexical_truncated`、`channels: ["ann"]` の対照、同じ query の繰り返し（順序の安定）、UTF8 と SQL_ASCII の両方の DB。
- 当てていない形: `ann_truncated`（`certainty: "undecidable"`）の中身を実 Postgres で確かめること（core の歯⑦に委ねた）、`labels`・`attributes`・`validAt` などの絞り込みと channels の組み合わせ（`recall-filter-combination-parity.postgres.test.ts` がランダムに組んでいる）、日本語の語彙（tsvector は日本語を引けない。ADR 0084 §3.2。trigram では引ける）、`lexicalMatch` の値そのもの（値域だけ縛り、store ごとの coverage の定義は ADR 0092・0319 に委ねた）。
- 見つからなかった形: `lexicalMatch` が `(0, 1]` を外れる、同点の並びが揺れる、重複して返る。

## 検討した代替案

1. **語彙だけが当てる C に、日本語の文面を使う。** 採らなかった。tsvector 側は日本語を引けない（ADR 0084 §3.2）ので、2 つの store で同じ形を当てるには ASCII の語にする必要がある。日本語は trigram の歯（`trigram-lexical-store.postgres.test.ts`）に既にある。
2. **ランダムな filter との直積を足す。** 採らなかった。`recall-filter-combination-parity.postgres.test.ts` が既にランダムに組んでいる。

## 引き受けた負債（材料）

| # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
|---|---|---|---|---|---|
| 1 | `lexicalMatch` は値域 `(0, 1]` しか縛っていない | 上 | store ごとの coverage の定義の違い（tsvector は一致した語彙数 ÷ 総数、trigram は word_similarity ベース）が順位にどう効くかは測っていない | 低 | 2 つの store を同じ尺度に揃えると決めたとき（ADR 0092・0319 の見直し） |

## これが覆るとしたら

合流の規則（ADR 0084 の表、`retrievedVia` の決め方、affinity の `max`）を変えると決まったとき（歯が赤くなる）。`RECALL_CHANNELS` に値が増えたとき（歯の表に足すこと）。

## 測っていないこと

PostgreSQL 17 以外、大きなデータでの k' の効き方、実際の埋め込み provider での `similarity` の値。
