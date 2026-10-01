# ADR 0492: 穴探し — recall の不変条件 fuzz に、これまで一度も振っていない欄（`timeWeighting`・`digestBandLimit`・クエリの `tags`・`occurredAt`）を足す（割れは見つからなかった）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 要点

- **今ある fuzz**【現物】:
  - `packages/core/src/__tests__/recall-invariant-fuzz.test.ts` + `recall-invariant-fuzz-harness.ts`: core の Fake、40 シード × 60 操作、不変条件 I1〜I12、決定性（I9）あり。
  - `packages/postgres/src/__tests__/recall-invariant-fuzz.postgres.test.ts`: 同じ harness を実 Postgres で（default 40 + wide 10 シード）、さらに Fake・testkit InMemory との**差分検査**（同じ操作列の recall の結果を突き合わせる。各 40 シード）と陽性対照。
  - `recall-filter-combination-parity.postgres.test.ts`: filter（tags・attributes・labels・subject・期間・validAt・provenance・channels）の乱択の組み合わせ。
  - `write-diff-fuzz.test.ts`・`fake-store-postgres-parity.test.ts` ほか、書き込み系の parity。
- **振っていない欄**: recall の `timeWeighting`・`digestBandLimit`・`relationMaxCount`・`tags`・`attributes`・`labels`/`taxonomyGroups`・`validAt`・`includeFullyDecayed`・`activityCounting` ほか。create の `occurredAt`・`validFrom/Until`・`attributes`。
- **足す欄と理由**【判断】: `timeWeighting`・`digestBandLimit`・`relationMaxCount`・クエリの `tags`（重複を含む。ADR 0474）・create の `occurredAt`。(1) ADR 0481 が実 Postgres のテストが渡していなかった欄として挙げたもの（`digestBandLimit`・`timeWeighting`・`relationMaxCount`）は固定の 17 形で当てただけで、操作列（forget・purge・contested・連想）との組み合わせは未踏。(2) 3 実装（Fake・InMemory・Postgres）の差分検査に載り、`digestBandLimit` の SQL の `LIMIT`・`relationMaxCount` の探索・鮮度の式の食い違いを乱択で拾える。(3) 既存の不変条件 I1〜I12 を変えずに効く欄（ランキング・帯の大きさ・同伴の数であって、スコープを絞らない。I11 の「この検査器の recall は scope を絞らない」前提を壊さない）。
- **足さない欄**: スコープを絞る欄（`validAt`・`labels`・`attributes`・`excludeProvenanceKinds` ほか）は I11 の前提を壊すので別の不変条件が要る。`taxonomyGroups` は 47 巡目（labels）の面。`activityCounting` は活動時計のテナントでしか効かない（harness は壁時計）。
- **形**: 既存の harness に新しい profile `"fields"` を足す。欄の乱数は別の流れから引き、default／wide のシード→操作列の対応は変えない（既存の固定シードの再現性を保つ）。反復は小さく（Fake 20 シード、Postgres 10 シード + 差分 10 シード × 2）、足した分の実行時間を前後で測って書く。
- **線**: 割れ（3 実装の食い違いなど）が見つかったら、約束に実装を戻すのは内側（直す前の赤を先に見せる）。オーナーの領分の 6 つは材料。再現する seed は ADR に書き、固定の歯にもする。

## 決定（線の内側＝歯だけ。実装は変えていない）

- **harness**（`packages/core/src/__tests__/recall-invariant-fuzz-harness.ts`）に、新しい profile `"fields"` を足した。欄の乱数は別の流れ（`seed ^ 0x5bd1e995`）から引くので、`default`／`wide` の同じシードの操作列の骨格は変わらない（既存の固定シードの再現性を保つ）。振る欄:
  - recall: `timeWeighting`（`eventAwareFreshness`／省略）、`digestBandLimit`（省略が 2/6、1・2・3・5）、クエリの `tags`（`a`・`b`・`c`・`a` から確率 0.4 ずつ。重複を含む。ADR 0474）。
  - create: `occurredAt`（半数が null、残りは「400 日前〜10 日後」）。`timeWeighting` が効くのに必要。
- **歯**: core の `recall-invariant-fuzz.test.ts` に `fields` の leg（20 シード × 60 操作、決定性あり）。postgres の `recall-invariant-fuzz.postgres.test.ts` に `fields` の leg（10 シード、planner）と、Fake・testkit InMemory との差分（`fields`、10 シードずつ、`indexscan_off`）を足した。環境変数: `RECALL_FUZZ_FIELDS_SEEDS`（core）、`RECALL_FUZZ_PG_FIELDS_SEEDS`・`RECALL_FUZZ_PG_FIELDS_DIFF_SEEDS`（postgres）。**既存の default・wide・差分の反復数を決める環境変数とは別の変数**で、「前」を `…=0` で取っても既存の leg の仕事量は変わらない（コードで確認）。
- **実測の結果**【実測。手元の PostgreSQL 17（`initdb`、UTF8 + C.UTF-8）+ pgvector、node v22.23.3】: **割れは見つからなかった**。core（Fake）の `fields` 20 シード、Postgres の `fields` 10 シード、Fake・testkit との差分 各 10 シードのすべてで、I1〜I12 の違反も、3 実装の食い違いも無かった。
- **足した分の実行時間**【実測】:

  | ファイル | 足す前（既存の leg だけ） | 足した leg | 足した後の全体 |
  |---|---|---|---|
  | `recall-invariant-fuzz.test.ts`（core、Fake） | 約 1.9 秒（40 シード）。`RECALL_FUZZ_FIELDS_SEEDS=0` の全体は 3.97 秒 | `fields` 20 シード 0.48 秒 | 3.42 秒（ばらつきの範囲） |
  | `recall-invariant-fuzz.postgres.test.ts` | default 9.8 + wide 8.8 + 差分 10.0 + 0.46 + 陽性対照 0.06 = 約 29 秒 | `fields` 2.4 + 差分（Fake）2.2 + 差分（testkit）0.11 = **約 4.7 秒** | 40.9 秒 |

  足した分は 1 ファイルあたり数秒以内（core 0.5 秒、postgres 4.7 秒）。
- **足した欄が効いていることの陽性対照**【実測。変異】: core の Fake の `aggregateScope` の目次帯を `slice(0, limit - 1)` に壊した（`runtime-fakes.ts`）。**`default` の差分は緑のまま**（`digestBandLimit` を渡さない既定の 50 は候補数より大きく、`limit - 1` でも同じ結果になる）が、**`fields` の差分（Fake 対 Postgres）は赤になり、`seed=1`・`2`・`3`・`5`・`7` が `$.index.digestBand.length` の食い違いで報告された**。`cp` で戻し、`git status` は空。→ `default`／`wide` の fuzz では拾えない Fake の食い違いを、`fields` が拾える。
- **`relationMaxCount` を外した理由**【判断】: harness は `relationStore` を配線していない（`FuzzStores` に `relationStore` が無く、`markContested` は 2 者版の `contestedWithId` で動く）ので、`RecallQuery.relationMaxCount`（`relationStore` 経由の群の同伴の上限）は効かない。振っても何も変わらない欄を足さなかった。**材料**: harness に `relationStore`（Fake の `FakeRelationStore`、Postgres の `PostgresRelationStore`）を配線し、`markContestedGroup`／`resolveContestedGroup` を操作に足せば、`relationMaxCount` と群の同伴（ADR 0381・0396）を振れる。

## 今回の欄で拾えなかったもの（ADR 0480〜0490 の割れの観点）

- **uuid の大文字小文字**（ADR 0469・0475）: 操作列の id は検査器が作った小文字の uuid（または Fake の `mem-N`）で、`forget`／`purge` などへ大文字化した id を渡す操作が無い。別の欄（操作の引数の変形）が要る。
- **forget・purge の後の参照**: 既存の操作列には `forget`（6%）・`purge`（4%）・`restoreArchived`（2%）・`sweepArchive`（2%）・`markContested`（7%）・`resolveContested`（4%）・`consolidate`（3%）・使用報告（8%）が含まれる（`genOps` の確率）。`usage`／`mark`／`resolve` は `nth(i)` で過去に作った記憶を指すので、forget・purge 済みの記憶を指す呼び出しは偶然に起きる。ただし「消した後の参照」を狙って多く出す形ではない。
- **`event.data` の JSON で往復しない値**（ADR 0482・0486）: この harness は `observe()` を通らない（`createMemory` を直接呼ぶ）ので届かない。`observe()` を操作に足す別の fuzz が要る。
- **`RecallRecord` の往復**（ADR 0480）: 差分検査は `recall()` の戻り値を比べ、`getRecall` は比べない。
- **`channels` の合流**（ADR 0484）: `lex`（語彙チャンネル）は既存の操作にある（20%）が、`"lexical"` だけの recall や、tsvector／trigram の両方の store での合流は振っていない。
- **スコープを絞る欄**（`validAt`・`labels`・`attributes`・`excludeProvenanceKinds`）: I11 の前提（この検査器の recall は scope を絞らない）を壊すので、別の不変条件が要る。

## 検討した代替案

1. **新しい harness を作る。** 採らなかった。操作列・不変条件・差分検査・最小化がそろった既存の harness に profile を足すほうが、不変条件を二重に持たずに済む。
2. **`default` の recall に直接欄を足す。** 採らなかった。乱数の流れが変わり、既存の固定シードの再現性（過去に Issue を見つけたシード）が失われる。
3. **スコープを絞る欄も足す。** 採らなかった。上のとおり、別の不変条件（`totalInScope` の期待値の計算）が要る。

## 引き受けた負債（材料）

| # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
|---|---|---|---|---|---|
| 1 | harness に `relationStore` が無く、`relationMaxCount`・多者間の群を振れない | 上 | 群の同伴の上限は固定の形の歯（ADR 0396 ほか）だけが見ている | 低 | harness に `relationStore` を配線するとき |
| 2 | 操作の引数の変形（id の大文字化など）を振っていない | 上 | uuid の大文字小文字は固定の歯が見ている | 低 | 操作の引数を乱択する harness を足すとき |

## これが覆るとしたら

`RecallQuery` に欄が増えたとき（`fields` に足すか決める）。`default`／`wide` の乱数の引き方を変えたとき（固定シードが指す操作列が変わるので、ADR を読み直す）。

## 測っていないこと

`fields` の本数を増やしたときの割れ（既定は小さく絞った。`RECALL_FUZZ_PG_FIELDS_SEEDS` ほかで増やせる）、HNSW を通す脚（`seqscan_off`）への `fields` の適用（差分は `indexscan_off` だけ。ADR 0193 の理由）、実際の埋め込み provider。
