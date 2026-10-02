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
- **陽性対照**【実測】: 一時の md に存在しない ADR のパス（番号 0530 を名乗る架空のファイル名。ここには書かない）を書いてパスの照合に通し、拾った（実在する歯のパスは拾わなかった）。一時ファイルは削除した。種類ごとの結末と実装の突き合わせには機械の陽性対照が無い（手で読んだ）。
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

## 追い足し（基準 main `3136a062`、ADR 0508 の分）

0508（#1629）が main に入ったので掃いた（`git diff 7453e1a7 3136a062`）。その手前の #1630（ADR 0533、`7453e1a7`）は掃きの ADR 自身なので掃かず、取り込んだだけ。この枝は `origin/main` を merge した（衝突は `docs/decisions/README.md` の索引だけ。`generate-adr-index.mjs` で作り直した。`docs/migration-v1.md` は自動で入り、衝突マーカーは 0 件）。0531・0532・0510・0534 などは、まだ追い足していない。

- **0508 の中身**【現物】: 差は ADR 0508 と1つの歯（`packages/postgres/src/__tests__/recall-channels-undecidable-japanese-labels-parity.postgres.test.ts`）と索引だけ。実装・TSDoc・README・約束の文書・CHANGELOG・migration-v1 は変わっていない。`recall` の `channels` の合流のうち、(1) `ann_truncated` の `undecidable`（窓が埋まり、かつ語彙が走ったとき。窓が埋まらない・ANN が走らないときは出ない）、(2) 日本語の語彙（trigram は当て、tsvector と Fake は当てない。既知の非対称〔ADR 0084 §3.2・0319〕）、(3) `labels` との組（絞りが語彙 store へ降りていること）を、Fake・実 Postgres（tsvector・trigram）に同じ問いを当てて縛った。割れは日本語の既知の非対称だけ。
- **ADR 0533 への参照**: ADR 0535 の冒頭は ADR 0533 を番号だけで書き、リンクにしていない（`](./0533` の形は無い）。そのため、リンク切れの心配は元から無い。main には `docs/decisions/0533-doc-code-drift-sweep-0526-0527.md` が入っていて、番号で名指しした先が実在する。
- **探した場所**【現物】:
  - 差の確認: `git diff 7453e1a7 3136a062`。
  - `docs/recall.md` の語彙チャンネルの記述（§2 段1の「1チャンネルのみ」の追記、ADR 0319 の trigram の追記、`ann_truncated` の `certainty` の説明）、`packages/core/src/recall-runtime.ts` の `annWindowFilled`・`lexicalExecuted` の判定、`testkit` の `InMemoryLexicalStore` の TSDoc（CJK を語単位に割らない）を読み、0508 の結果と照らした。
  - 語の grep: `UNDECIDABLE_LEXICAL_ACTIVE|undecidable` を `docs/recall.md` に。`日本語|CJK|trigram` を `docs/recall.md`・`packages/testkit/README.md`・`in-memory-lexical-store.ts` に。
  - 機械照合を、前回（0505 の分）と同じ文書の集合に再度通した。
- **突き合わせの結果**【現物】:
  - `docs/recall.md` の「語彙チャンネルは日本語の文に埋もれた日本語の語を引けない」「`PostgresTrigramLexicalStore` は opt-in の代替で、日本語を引ける」は、0508 の結果（trigram は当て、tsvector と Fake は当てない。`ann+lexical` の合流でも同じ）と一致した。`InMemoryLexicalStore` の TSDoc（CJK 自体の分かち書きをしない。Fake は tsvector 側に合わせてある）とも一致する。
  - `ann_truncated` の `undecidable`（`certainty` の説明「たとえば語彙チャンネルを併用しているとき」）は、0508 が縛った条件（窓が埋まり、かつ語彙が走ったとき。実装は `annWindowFilled && lexicalExecuted`）の一般的な言い方で、矛盾しない。窓が埋まらない・語彙だけ・ANN だけのときに出ないことを書いた文書は無い（0508 は歯にしただけで、約束を足していない）。
  - `labels` を語彙 store へ降ろす絞りと後置の `survivesLabelsFilter` の関係（0508 の変異試験が示す、`kPrime` が窓を絞る形では降ろしが効く）は、文書には書かれていない。古くなった記述は無い。
- **直したもの**: なし（文書の側に古い記述が無かった）。上の ADR 0535 本文の1か所（陽性対照の説明に、実在しないパスの字面が入っていて、パスの照合が拾う形になっていた）だけ、字面を書かない言い方に直した。
- **コードの側を直すべき食い違い**: 見つからなかった。材料として残す【判断】: ADR 0508 が歯で縛った日本語の非対称（Fake が日本語を引けない）は、`recall.md`・Fake の TSDoc が書く既知の設計で、直す対象ではない。Fake が trigram 側へ寄る、または tsvector が日本語を引けるようになったときは、0508 の歯の期待を直す（0508 の「これが覆るとしたら」）。
- **前回との比較**【実測】: 機械照合の出力（識別子・パス・リンク・`Type.member`・import・文言・TSDoc の2つの照合）は、前回と、行番号を除いて同じだった。
- **陽性対照**【実測】: 一時の md に存在しない識別子 `ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVEX` を書いて識別子の照合に通し、拾った（実在する `ANN_TRUNCATION_UNDECIDABLE_LEXICAL_ACTIVE` は拾わなかった）。一時ファイルは削除した。0508 の結果と文書の突き合わせには機械の陽性対照が無い（手で読んだ）。
- **【未確認】**: 0508 の歯（Fake・実 Postgres の tsvector と trigram）を走らせていない。ADR 0508 の変異試験（4種類）の結果。SQL_ASCII の DB で trigram の歯が「使えないこと」を主張して終わること（0508 自身も走らせていない）。
- **走らせたコマンド**: `git fetch origin && git merge origin/main`、`node scripts/generate-adr-index.mjs`、機械照合のスクリプト（repo の外）。ビルド・全テスト・DB の要るテストは走らせていない。

## 追い足し（基準 main `e0a48aca`、ADR 0534 の分）

0534（`e0a48aca`。v1.2.0 の tag より後の #1615・#1616 の項目を CHANGELOG `[1.3.0]` 側へ移す。mgr-97707a4e が担当）が main に入ったので、取り込んでから掃いた（`git diff 3136a062 e0a48aca`）。

- **merge の結果**: `git merge origin/main` の衝突は `docs/decisions/README.md` の索引だけ（`checkout --theirs` のあと `generate-adr-index.mjs` で作り直した）。`CHANGELOG.md` と `docs/migration-v1.md` は自動で merge できた（衝突マーカー 0 件）。0531・0532・0510 などは、まだ追い足していない。
- **この枝の直しが、0534 の移動後の正しい位置に残っているか**【実測】: `git diff origin/main -U0 -- CHANGELOG.md docs/migration-v1.md` は3行だけで、重複も消失も無い。3行は (a) CHANGELOG `[1.3.0]` の 0504 の項の「変えなかったこと」の注（ADR 0505 で `PostgresEventStore.append`・`PostgresLexicalStore.search` は落とすようにした）、(b) migration 項目60（🔴「v1.2.0 → 次の版」）の参照先 `[1.3.0]`、(c) migration の 🟡「v1.2.0 → 次の版」の 0504 の項の同じ注。0534 は `[1.2.0]` の 0498 の項・migration の項目56と、0525・0521 の項を動かしたが、この3か所には触れていない（これらは 0534 が動かさなかった `[1.3.0]`・次の版の節の中にある）。前回までの直し（項目57〜59 の参照先 `[1.3.0]`、`docs/memory-model.md`・`fixtures.ts` の直し）は、main に取り込まれた ADR 0533・0535 の枝の分で、残っている。
- **0534 自体の突き合わせ**【現物】:
  - `[1.2.0]` の `### Breaking` の項目56（ADR 0498）と migration の🔴の項目56 は、ADR 0525 が足していた注記（「`@mnemora/bullmq` の `everyMs`・`jobName`・`concurrency` も同じ。ADR 0525 で揃えた」）を取り除き、出荷された本文（「`@mnemora/bullmq` は `resolveConcurrency` と同じ素の `Error`」）に戻っている。実装（`tick-driver.ts` は 0525 以降 `TypeError`・`RangeError`）とは食い違うが、これは「`v1.2.0` の時点の本文」であって、現在形の約束ではない（`v1.2.0` の tag が指す `d49c46c` の実装は素の `Error`）。
  - ADR 0525 の項は CHANGELOG `[1.3.0]` の `### Changed`、ADR 0521 の項は `### Fixed` に、migration では「🟡 v1.2.0 → 次の版」に移っている。`[1.2.0]` と migration の v1.1.0 → v1.2.0 の節には、0525・0521 の項は残っていない（`ADR 0525`・`ADR 0521` の grep で、`[1.3.0]` と「v1.2.0 → 次の版」の節の外のヒットは無い）。
  - migration の移した項にある「🔴 の項目56（ADR 0498）の続き」は、項目56 が出荷済みの節に在るので正しい。0521 の項の「上の項目（ADR 0466・0469・0475・0488）の続き」の「上」は、同じ文書の「v1.1.0 → v1.2.0 の🟡」の節にあり、移したあとも文書の上側に在る。
  - CHANGELOG `[1.3.0]` の見出しの追記2の文言（`d49c46c`..`3c90e3b7` を棚卸し済み、#1620・#1621・#1624 は自分で `[1.3.0]` に足していた、#1615・#1616 を移した）は、実装・差と矛盾しない。その後に入った ADR 0505（#1625）の項が `[1.3.0]` に在ることは、この範囲の外（0505 が自分で足した）で、追記2も「`3c90e3b7` まで」と範囲を書いている。
  - `docs/release-notes-v1.2.0.md`（Release 本文の草稿）に、0525・0521 の記述は無い（`0525|0521|#1615|#1616|TypeError|大文字` の grep が無ヒット）。
- **v1.2.0 の tag**【実測】: `git ls-remote --tags origin v1.2.0` は `d49c46c26748692e9f69f5d0c5729169ef7a1ef3`（`refs/tags/v1.2.0`）。CHANGELOG `[1.2.0]` の区切りの点 `d49c46c` と一致する（tag は打たれている）。なお、`[1.2.0]` の本文と migration の見出し直下が `d49c46c` を「PR #1609」と呼ぶ件（`d49c46c2` は #1613 のマージ、#1609 は `b19115dc`）は ADR 0528 が材料に書いたとおりで、今回も直していない（`[1.2.0]`・v1.2.0 の節は触らない決まり）。
- **直したもの**: なし（0534 の移動後に、この枝の直しの位置の食い違い・重複・消失は無く、移した項と指す記述の食い違いも無かった）。
- **コードの側を直すべき食い違い**: 見つからなかった。
- **前回との比較**【実測】: 機械照合の出力（識別子・パス・リンク・`Type.member`・import・文言・TSDoc の2つの照合）は、前回（0508 の分）と、行番号を除いて同じだった。
- **陽性対照**【実測】: 「migration の未リリースの節に、`[1.2.0]` 節の `### Breaking` を指す参照が残っていない」ことを、grep の形（`` `[1.2.0]` 節 `### Breaking` ``）で見た。いまは 0 件で、0508 の取り込み後（`3136a062` の `migration-v1.md`）は同じ形が1件（項目60。この枝で直した）だった。この grep が拾えることの対照になる。0525・0521 の項の位置は、`ADR 0525`・`ADR 0521` の grep の行番号と節の見出しの行番号を突き合わせて見た（機械の陽性対照は無い）。
- **【未確認】**: 0534 が書く「#1615・#1616 以外で、`d49c46c` より後に `[1.2.0]` へ足された項目が無い」ことの網羅（0528 と 0533 の追い足しで、`ADR 0499|0502|0504|0506|0521|0523|0525|0524` の語の grep をしたが、`d49c46c` より後の全 PR を1本ずつ当ててはいない）。
- **走らせたコマンド**: `git fetch origin && git merge origin/main`、`git ls-remote --tags origin v1.2.0`、`node scripts/generate-adr-index.mjs`、機械照合のスクリプト（repo の外）。ビルド・全テスト・DB の要るテストは走らせていない。

## 追い足し（基準 main `28f98bee`、ADR 0532 の分）

0532（#1632）が main に入ったので掃いた（`git diff e0a48aca 28f98bee`）。この枝は `origin/main` を merge した（衝突なし。索引は再生成して変更なし）。0531・0510 などは、まだ追い足していない。

- **0532 の中身**【現物】: 差は ADR 0532 と1つの歯（`packages/postgres/src/__tests__/tick-job-sources-lowercase.postgres.test.ts`）と索引だけ。実装・TSDoc・README・約束の文書・CHANGELOG・migration-v1 は変わっていない（0532 も、変えていないと書く）。`tick` 経由の `consolidate`・`reflect` ジョブの `created` の `meta.sources` が小文字になること（ADR 0527 の続き）を測った。ジョブの payload の `memoryId` に大文字が入る入口は無い（payload は store が組み、`OutboxStore` に積む口は無い）。入口が仮に開いていても（payload を直接書き換えた行）、0527 の直しで `meta.sources` は小文字になる。Postgres と InMemory は一致、Fake は近傍が取れず `created` が積まれない（0521 の注と同じ）。
- **探した場所**【現物】:
  - 差の確認: `git diff e0a48aca 28f98bee`。
  - `Runtime.reflect` の手順8（`runtime.ts`。ADR 0533 で書いた「`meta.sources` は store が返した行の id＝小文字」）と、`tick` が `consolidate`・`reflect` のジョブを処理する経路（`readSeedMemoryIdFromPayload` が payload の `memoryId` をそのまま種にする）、`docs/memory-model.md` 行13付近の「ジョブの `payload.memoryId` を種にして `consolidate()`/`reflect()` を呼ぶ」、`interfaces/outbox-store.ts`（`enqueue` の有無）、`docs/architecture.md` の `OutboxStore` の写し。
  - 語の grep: `meta.sources` を `runtime.ts` に。`enqueue` を `interfaces/outbox-store.ts` と `docs/architecture.md` の `OutboxStore` の節に。`payload` に `consolidate|reflect` を重ねたもの（`docs/memory-model.md`）。
  - 機械照合を、前回（0534 の分）と同じ文書の集合に再度通した。
- **突き合わせの結果**【現物】:
  - ADR 0532 が確かめた入口（`OutboxStore` に `enqueue` が無い。ジョブを積むのは `jobKinds` を渡す記憶の作成だけ。`tick` は payload の綴りを直さない）は、`interfaces/outbox-store.ts` の口の一覧、`runtime.ts` の `readSeedMemoryIdFromPayload` と一致した。
  - `Runtime.reflect` の手順8の TSDoc（`meta.sources` は store が返した行の id＝小文字の正規形で、渡された綴りではない）は、`tick` 経由でも成り立つ（`tick` は同じ `consolidate`・`reflect` の本体を呼ぶ）。`docs/memory-model.md` の「ジョブの `payload.memoryId` を種にして…呼ぶ」は、0532 のあとも正しい。`meta.sources` に呼び出し側の綴りが残ると現在形で書いた所は、ADR 0527・0533 のとおり無い。
  - CHANGELOG `[1.3.0]` の ADR 0527 の項（`meta.sources` を小文字に）は、`tick` 経由の経路を書いていない。0532 は割れが無く、挙動を変えていないので、足す必要は無い。migration に項目は無く、不要。
- **直したもの**: なし（文書の側に古い記述が無かった）。
- **コードの側を直すべき食い違い**: 見つからなかった。材料として残す【判断】: ADR 0532 の負債（Fake の `tick` 経由の `meta.sources` の中身は、近傍が取れないので見ていない。書き換えた payload の大文字が `consolidate` の返り値や `tick` の他の欄にどう出るかは見ていない）。`OutboxStore` に payload を渡して積む口を足す、または `createMemoryWithOutbox` が呼び出し側の id を payload に載せる形に変わるときは、0532 の歯の前提が崩れる（0532 の「これが覆るとしたら」）。
- **前回との比較**【実測】: 機械照合の出力（識別子・パス・リンク・`Type.member`・import・文言・TSDoc の2つの照合）は、前回と、行番号を除いて同じだった。
- **陽性対照**【実測】: 一時の md に存在しない識別子 `readSeedMemoryIdFromPayloadX` を書いて識別子の照合に通し、拾った（実在する `readSeedMemoryIdFromPayload` は拾わなかった）。一時ファイルは削除した。`OutboxStore` に `enqueue` が無いことは grep の無ヒットで見た（`claimBatch` が同じ節でヒットすることで、grep が当たる場所を見ていることは確かめた）。入口の突き合わせには機械の陽性対照が無い（手で読んだ）。
- **【未確認】**: 0532 の歯（実 Postgres・InMemory・Fake の4本）を走らせていない。ADR 0532 の変異試験（0527 の直しを外すと「書き換えた payload」の2本だけが赤になる）の結果。0532 が測っていない範囲（並行する複数の `tick`、`extract` ジョブ経由の `created`、実 API）。
- **走らせたコマンド**: `git fetch origin && git merge origin/main`、`node scripts/generate-adr-index.mjs`、機械照合のスクリプト（repo の外）。ビルド・全テスト・DB の要るテストは走らせていない。

## 追い足し（基準 main `09516d1e`、ADR 0531 の分）

0531（#1633）が main に入ったので掃いた（`git diff 28f98bee 09516d1e`）。この節はマネージャーが書いた（担い手のセッションが利用上限で止まったため）。この枝は `origin/main` を merge した（衝突なし）。

- **0531 の中身**【現物】: 差は ADR 0531・1つの歯（`packages/postgres/src/__tests__/tick-multi-pool-concurrency.postgres.test.ts`）・索引だけ。実装・TSDoc・README・約束の文書・CHANGELOG・migration-v1 は変わっていない（0531 の決定1も、変えていないと書く）。
- **探した場所**【現物】: `interfaces/outbox-store.ts` の `claimBatch`・`complete`/`fail` の TSDoc（`FOR UPDATE SKIP LOCKED`・`attempts` の CAS）、`docs/architecture.md` の `OutboxStore` の並行の追記（ADR 0206・0325 の追記）、`grep -n 'SKIP LOCKED|複数のプロセス|複数プロセス|接続プール'` を `docs/architecture.md`・`docs/memory-model.md`・`packages/postgres/README.md`・`packages/core/src/runtime.ts` に当てた。
- **突き合わせの結果**【現物】: 0531 が測った「別々の接続プールからの `tick` でも二重 claim が起きない」「`attempts` の CAS は接続をまたいで効く」は、`outbox-store.ts` の TSDoc の約束と一致する。`docs/architecture.md` の「単一プロセス内の複数接続までであり」「別ホストの複数マシンが同じ Postgres に対して撃つ状況は、依然として測っていない」は、0531（1つのプロセスの中の別々のプール）のあとも成り立つ。古くなった記述は無かった。
- **直したもの**: なし。
- **コードの側を直すべき食い違い**: 見つからなかった。
- **【未確認】**: 0531 の歯（実 Postgres）を走らせていない。この回は、担い手の機械照合（識別子・パス・リンク・`Type.member`・import・文言・TSDoc）を当て直していない（差が ADR と歯だけで、文書・TSDoc に変更が無いため、前回の出力から変わる入力が無いと判断した【判断】）。陽性対照も取っていない。
- **走らせたコマンド**: `git fetch origin && git merge origin/main`、上の grep、`node scripts/generate-adr-index.mjs`。

## 追い足し（基準 main `77053aa4`、ADR 0510 の分）

0510（`77053aa4`）が main に入ったので取り込んだ（`git diff 09516d1e 77053aa4`。衝突なし）。この節もマネージャーが書いた。

- **0510 の中身**【現物】: 差は ADR 0510 と索引だけ。0510 は、ADR 0495・0520・0523 が「見ていない形」として残した表の中の数値・定数と既定値の散文を、コードの定数に照らした掃きであり、文書の側もコードの側も直していない（0510 の「見つけたもの」）。
- **突き合わせの結果**【判断】: 文書・TSDoc・CHANGELOG・migration-v1 に変更が無いので、この ADR の照合の入力は変わらない。0510 の照らした範囲（`main` の `0bdc0e27`）と、この ADR とそれ以前の掃き（0528・0533）が直した所は重ならない（0510 は数値・定数、こちらは識別子・例外・振る舞いの記述）。0510 が「本文の側が追記で自分の古さを書いている」として直さなかった3件（`docs/conformance.md` §2.1 の6 suite、`docs/memory-model.md` 行12・13 の `tick()`、`docs/release-v1.md` の当時の実測）は、この ADR でも同じ理由で直さない。
- **直したもの**: なし。**コードの側を直すべき食い違い**: 見つからなかった。
- **【未確認】**: 0510 の「一致した」の各行を当て直していない。機械照合と陽性対照もこの回は取っていない（差に文書の変更が無いため）。

## 追い足し（基準 main `1d4218a0`、ADR 0512 の分）

0512（#1634、`1d4218a0`）が main に入ったので掃いた（`git diff 77053aa4 1d4218a0`。merge は衝突なし）。この節もマネージャーが書いた。

- **0512 の中身**【現物】: `PostgresMemoryStore.scrubPurged`・`InMemoryMemoryStore.scrubPurged` が、そのテナントの `recalls.index_band` の `digestBand` のうち、渡された id の purge 済みの行のエントリの `digest` を、その行の `digest`（トゥームストーン）へ伏せるようになった（`truncated` は落とす。`recalls.query`・`explain` は書かない）。`MemoryStore.scrubPurged?` の TSDoc・CHANGELOG `[1.3.0]`・migration-v1 の「🟡 v1.2.0 → 次の版」は 0512 自身が書いている。
- **探した場所**【現物】: `grep -rn scrubPurged` を `docs/*.md`・`packages/*/README.md`・`packages/core/src/runtime.ts`・`packages/core/src/interfaces/*.ts` に。`index_band|indexBand|目次帯` に `purge|伏せ|残` を重ねて `docs/memory-model.md`・`packages/postgres/README.md` に。
- **直したもの**（TSDoc だけ。実装は変えていない）: `packages/core/src/runtime.ts` の
  1. `PurgeResidueCleanup` の TSDoc: 後始末の中身を「`tags`・`attributes`・claim key・label の紐付けの掃除」とだけ書いていたので、ADR 0512 から目次帯の digest を伏せることも含む、と足した。
  2. `PurgeOutcome` の `"already_purged"` の説明: 同じく `scrubPurged` が伏せるものに目次帯の digest を足した。あわせて、同じ段落の「**`MemoryStore` への書き込みは一切起きていない**」が、同じ段落の後半（`scrubPurged` をベストエフォートで試みる。ADR 0437 から）と食い違っていたので、「下の `scrubPurged` の後始末を除く」と限定した（この食い違いは 0512 より前、ADR 0437 からのもの）。
- **触っていないもの**: `docs/migration-v1.md` の「🔴 v1.1.0 → v1.2.0」の節の `scrubPurged?` の項（「`tags`… が消える」の列挙）は、v1.2.0 の節なので触らない（クローンの決定）。`docs/memory-model.md` の `recalls` の行（ADR 0375 の追記）は `purge()` の時点の振る舞いの記述で、`scrubPurged` の射程を書いていないので、0512 のあとも成り立つ。
- **コードの側を直すべき食い違い**: 見つからなかった。
- **【未確認】**: 0512 の歯（実 Postgres・InMemory）を走らせていない。機械照合と陽性対照はこの回は取っていない（直したのは TSDoc の文だけで、新しい識別子を書いていない）。
- **走らせたコマンド**: `git fetch origin && git merge origin/main`、上の grep、`packages/core` の `tsc --noEmit`、`node scripts/generate-adr-index.mjs`。
