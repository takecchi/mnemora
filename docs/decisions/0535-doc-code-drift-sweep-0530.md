# ADR 0535: 文書とコードのずれを横に掃く（第5弾の1回目）— ADR 0530 の分の文書を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-d9378a02 の指示による）が書いた。文書の側の直しは無かった。コードの側を直すべき食い違いも見つからなかった。

**照合の基準は main `3c90e3b7`。** ADR 0533（#1630）の続きで、0530（#1628、`b6e30f6a`）の分を掃く（`git diff f3e44794 b6e30f6a`）。ADR 0533 の冒頭は 0505・0508・0530・0531・0532 などを「追い足す」と書いたが、クローンの決定で 0533 は 0503 までで締め、それ以降はこの ADR で掃く。**このあとマージされる 0505・0508・0531・0532・0510・0534 などは、マージされた順に追い足す。**

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 0530 は、1回の `tick` の2件目の処理中にリースが切れ、別の `tick` が再 claim して二重に処理したときの結末を、種類（`embed`・`extract`・`reflect`・`consolidate`）ごとに Fake・InMemory・Postgres の3者で測った。結果は TSDoc の約束どおりで一致し、`consolidate` の結末だけが TSDoc に書かれていなかったので、`runtime.ts` の `TickOptions.leaseMs` の TSDoc に1段落を足した（実装は変えていない。CHANGELOG・migration には載せていない。0530 決定1）。
  決まり（前回と同じ）: CHANGELOG の `[1.2.0]` と migration-v1 の v1.2.0 の節（「`v1.2.0` で出す」の節）には触らない。既存の ADR 本文は対象外。

- **探した場所**【現物】:
  - 差の確認: `git diff f3e44794 b6e30f6a`（`runtime.ts` の TSDoc 6 行、ADR、歯 2 本、索引）。`CHANGELOG.md`・`docs/migration-v1.md`・README・約束の文書の差は無い。
  - 語の grep: `二重|再配達|leaseConflicts` を `docs/architecture.md`・`memory-model.md`・`recall.md`・ルートと各パッケージの README・`interfaces/outbox-store.ts` に。`再配達|二重に|リース` を `runtime.ts`（3000 行目以降）に。ヒットした所を読んだ: `docs/architecture.md` §5.2（`leaseConflicts` を積んで次のジョブへ進む）・§5.11（`claimBatch` が二重に claim しない）、`docs/memory-model.md` の行13（`reflect` の再配達で内省の記憶が2件になる）、`interfaces/outbox-store.ts` の再配達の注記、`Runtime.reflect`・`Runtime.consolidate` の TSDoc（再配達の扱い）、`packages/bullmq/README.md` の「データは壊れない」。
  - 機械照合を、前回の最後（ADR 0533 の追い足しのあと）と同じ文書の集合に再度通した。

- **突き合わせの結果**【現物】:
  - 新しい TSDoc の4種類の結末（`embed` は同じベクトルを上書き、`extract` は事前の確認が効かないとき同じ候補なら冪等の鍵で1件・違う候補なら両方 `active`・遅れた側の LLM が落ちると全文フォールバックの記憶も残る、`reflect` は材料を `superseded` にしないので内省が2件、`consolidate` は書く前の読み直し〔ADR 0420〕で先に統合された元の記憶を見て何も書かずに打ち切る）と、「どの種類でも遅れた側の `complete`/`fail` は `leaseConflicts` に載り、行は先に完了した側のまま」は、ADR 0530 の表（12項目・3者一致）と一致する。`consolidate` の打ち切りは `runtime.ts` の書く前の読み直し（`recheckedBeforeConsolidateWrite`）、`reflect` の内省が材料を `superseded` にしないことは `runtime.ts` の `reflect` の `created` の組み立てと矛盾しない。
  - 既存の記述と矛盾しない: `docs/memory-model.md` の行13（`reflect` は再配達で2件）、`interfaces/outbox-store.ts` の「`embed`・`consolidate` は1回だけ処理したときと同じ」、`Runtime.reflect`・`Runtime.consolidate` の TSDoc、`docs/architecture.md` §5.2 の `leaseConflicts` の記述。新しい段落が先頭で挙げる参照先の歯（`fake-tick-batch-exceeds-lease-parity.test.ts`・`tick-batch-exceeds-lease-parity.postgres.test.ts`）も、実在する。
  - README・約束の文書に、二重処理の結末を種類ごとに書いた所は元から無く、古くなった記述は無かった。CHANGELOG `[1.3.0]`・migration-v1 に 0530 の項は無い（0530 決定1どおり。文書だけの訂正で、挙動も公開の型も変わらない）。
- **直したもの**: なし（文書の側に古い記述が無かった）。
- **コードの側を直すべき食い違い**: 見つからなかった。オーナーの領分の材料として、ADR 0530 が挙げる3点（`limit` の既定と `leaseMs` の関係、`OutboxStore` にリースを延ばす口を足すか、`reflect` の二重を許すか）が残る。変更なし。
- **前回との比較**【実測】: 識別子・パス・リンク・`Type.member`・import の照合は、前回の最後の出力と、行番号を除いて同じ。TSDoc の2つの照合も同じ。文言の照合は、ADR 0528（#1622）が `docs/architecture.md` に足した `setEventRetention` の int4 の文面の1行が、この基準（`3c90e3b7`）には入っているので、1行多い。それ以外は同じ。
- **陽性対照**【実測】: 一時の md に存在しないパス `docs/decisions/0530-nope.md` を書いてパスの照合に通し、拾った（実在する歯のパスは拾わなかった）。一時ファイルは削除した。種類ごとの結末と実装の突き合わせには機械の陽性対照が無い（手で読んだ）。
- **【未確認】**: 0530 の2つの歯（Fake・InMemory・実 Postgres）を走らせていない。ADR 0530 が書く4種類の結末の12項目そのもの。0530 が測っていないと書く範囲（複数プロセス・複数の接続プール、`reflect` の材料が処理の途中で `superseded` になる場合）。
- **走らせたコマンド**: `node scripts/generate-adr-index.mjs`、機械照合のスクリプト（repo の外）。ビルド・全テスト・DB の要るテストは走らせていない。

- **引き受けた負債**: この ADR の結果は `main` の `3c90e3b7` に対して測った記録で、`main` が進めば古くなる。照合の道具は repo に入れていない（ADR 0495 の代替案1のとおり）。
- **これが覆るとしたら**: 上の探し方が拾わない種類（散文の中で二重処理の結末を言い換えた文）の古さが見つかったとき。

## 追い足し（基準 main `2963235e`、ADR 0505 の分）

0505（#1625）が main に入ったので掃いた（`git diff 3c90e3b7 2963235e`）。この枝は `origin/main` を merge した（衝突なし）。0508・0531・0532・0510・0534 などは、まだ追い足していない。

- **0505 の中身**【現物】: (1) `@mnemora/postgres` の `createObservation`・`createObservationWithOutbox`・`createRecall` が、NUL を DB の生の例外でなく名指しの `Error` で断る（`input-check.ts` の `assertNoNulInNewObservation`・`assertNoNulInNewRecall`）。(2) testkit の InMemory が、`archiveDecayed`・`aggregateScope`・`VectorStore.search` の `nowSeq + S_x`（`decayFloorSeqAfter + S_x`）の bigint の溢れを、Postgres がその式を評価する行があるときに断る（`seqSumOverflowsBigint`）。`nowSeq`・`decayFloorSeqAfter` そのものが 2^63 以上のときは `assertQueryBigint` で断る。(3) `PostgresEventStore.append`・`PostgresLexicalStore.search` を直接呼んだときの例外から params の値を落とす（`omittingParams`）。CHANGELOG `[1.3.0]` と migration-v1（🔴 項目60、🟡 の2項目）は 0505 自身が足している。
- **探した場所**【現物】:
  - 差の確認: `git diff 3c90e3b7 2963235e`（`CHANGELOG.md`・`docs/migration-v1.md`・`event-store.ts`・`lexical-store.ts`・`memory-store.ts`・`input-check.ts`・testkit の `in-memory-memory-store.ts`・`in-memory-vector-store.ts`・`query-check.ts`）。
  - 語の grep: `まだ揃えていない|bigint の溢れ|S_x` を `packages/testkit/src/fixtures.ts` に。`生の例外|DrizzleQueryError` に `NUL|createObservation|createRecall` を重ねたもの（`memory-store.ts` の TSDoc・testkit/postgres の README・`docs/conformance.md`）。`NUL` を `memory-store.ts` の TSDoc 全部。`まだ落ちない` と `PostgresMemoryStore\`・\`PostgresEventStore\`・\`PostgresLexicalStore\`` を CHANGELOG・migration-v1 に。
  - 読んだ所: `fixtures.ts` の冒頭の「揃えていないもの」、CHANGELOG `[1.3.0]` の 0504 の項（「変えなかったこと」）、migration-v1 の 🟡「v1.2.0 → 次の版」の 0504 の項、🔴 項目57・60、`MemoryStore.createObservation`・`createRecall` の TSDoc。
  - 機械照合を、前回の最後（0530 の分）と同じ文書の集合に再度通した。
- **突き合わせの結果**【現物】:
  - (1) CHANGELOG・migration 項目60の欄の列挙（`kind`・`payload`・`attributes`〔key も値も入れ子も〕、`createRecall` の7欄）、例外の型（素の `Error`）、文面（`PostgresMemoryStore: <欄> must not contain NUL characters (U+0000)`・`createRecall: <欄> …`）、`subjectId`・`externalId` は先に `assertWellFormedIdentifier` が断るので新しい検査は見ない、は実装と一致した。
  - (2) `nowSeq + S_x`（`archiveDecayed`、`usesSubjectActivityCounters: true`）・`decayFloorSeqAfter + S_x`（`aggregateScope`・`VectorStore.search`、`decayFloorSeqUsesSubjectCounters: true`）が 2^63 以上になるとき、subject を持ち `decay_floor_seq` が非 NULL の行があるときだけ断る、2軸は左（壁時計）で決まれば右は評価されない、`nowSeq`（`decayFloorSeqAfter`）そのものは行が無くても断る（`archiveDecayed` は `clock: 'wall'` を除く）は、実装（`seqSumOverflowsBigint`・`assertQueryBigint`・`markSeqSumOverflow`）と一致した。message は `archiveDecayed: nowSeq + own subject seq must fit in a Postgres bigint …` などで、CHANGELOG は文面を書いていない。
  - (3) 落とすのは `append`・`search` の2口だけで、CHANGELOG の「変えなかったこと」（`EventStore.get`・`list`、`PostgresTrigramLexicalStore` ほか）と一致した。
  - `memory-store.ts` の TSDoc には、`createObservation`・`createRecall` の NUL を「Postgres は DB の生の例外」と書いた所は無かった（「拒む」とだけ書く）。
- **直したもの（文書の側だけ）**:
  1. `packages/testkit/src/fixtures.ts`（冒頭の「揃えていないもの」）: 「`archiveDecayed`・`aggregateScope`・`VectorStore.search` の `S_x` を足す式の bigint 溢れは、まだ揃えていない（ADR 0500 の材料）」→ 0505 で揃えた（条件つき）。0505 が実装を揃えたのに、この一覧が残っていた。
  2. `docs/migration-v1.md` 項目60（未リリースの節）の「何が変わったか」: 「CHANGELOG の `[1.2.0]` 節 `### Breaking` を見ること」→ `[1.3.0]` 節。前回（ADR 0533）と同じ種類のずれ（項目57〜59を直した続き。0505 はそのあとに足された項目で、書いた時点の指す先が古い）。
  3. CHANGELOG `[1.3.0]` の 0504 の項の「変えなかったこと」: 「`PostgresMemoryStore`・`PostgresEventStore`・`PostgresLexicalStore` など…の直接呼びの例外」に、そのうち `PostgresEventStore.append`・`PostgresLexicalStore.search` は、のちに ADR 0505 で落とすようにした、と足した。0505 のあとは「`PostgresEventStore`・`PostgresLexicalStore` を直接呼んだときの例外は変えなかった」が成り立たない。
  4. `docs/migration-v1.md` の 🟡「v1.2.0 → 次の版」の 0504 の項の「ほかの store の直接呼びは、まだ落ちない（ADR 0504 の表）」に、同じ注を足した（`append`・`search` は ADR 0505 で落ちるようになった。下の項目）。
  5. CHANGELOG `[1.2.0]` と migration-v1 の v1.2.0 の節には触っていない。
- **コードの側を直すべき食い違い**: 見つからなかった。材料として残す【判断】: 0504 の表のうち、`PostgresMemoryStore` ほか params を落としていない store の口は、0505 のあとも「負債」のまま（0505 は 2 口だけ）。0505 の実測の「実際の `nowSeq` は小さい整数なので、到達しない入力」（migration の 🟡）は、利用者への注意として足りている。
- **前回との比較**【実測】: 機械照合の出力（識別子・パス・リンク・`Type.member`・import・文言・TSDoc の2つの照合）は、前回（0530 の分）と、行番号を除いて同じだった。
- **陽性対照**【実測】: 一時の md に存在しない識別子 `seqSumOverflowsBigintX` を書いて識別子の照合に通し、拾った（実在する `seqSumOverflowsBigint` は拾わなかった）。一時ファイルは削除した。migration の指す節のずれは、CHANGELOG の見出しの位置（`## [1.3.0]` の `### Breaking` に 0505 の NUL の項が在る）と migration の項の位置を数えて見つけた。条件・文面の突き合わせには機械の陽性対照が無い（手で読んだ）。
- **【未確認】**: 0505 の歯（`in-memory-fixtures-seq-sum-overflow.test.ts`・`testkit-fixture-seq-sum-overflow.postgres.test.ts`・`store-write-nul-named.postgres.test.ts` と `error-message-omits-params.postgres.test.ts` の追加分）を走らせていない。2軸の組み合わせ（`decayFloorAnyAxis` ほか）の条件が Postgres と同じ結果になること（0505 は実測したと書くが、再実行していない）。
- **走らせたコマンド**: `git fetch origin && git merge origin/main`、`node scripts/generate-adr-index.mjs`、機械照合のスクリプト（repo の外）。ビルド・全テスト・DB の要るテストは走らせていない。
