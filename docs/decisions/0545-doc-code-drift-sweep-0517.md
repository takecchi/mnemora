# ADR 0545: 文書とコードのずれを横に掃く（第6弾の1回目）— ADR 0517・0511 の分の文書を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-d1d64a4a の指示による）が書いた。文書の側の直しは無かった。コードの側が約束を破っていそうな食い違いも見つからなかった。

**照合の基準は main `6e71ffb4`。** ADR 0535（#1637）の続きで、0517（#1646、`bc4452cc`）と 0511（#1636、`6e71ffb4`）の分を掃く。0535 は 0542 までで締め、それ以降をこの ADR で掃く。**このあとマージされるものは、マージされた順に追い足す。**（0543・0544 は枝 `fix/adr-0543-*`・`fix/adr-0544-*` が在るが、main にまだ無いので掃いていない。）

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 0517 は、`extractTitle: true` の `document` で空白だけの `title` を本文の前置きにしない（断らず無視する）。0511 は、`@mnemora/postgres` の `labels` の行ロックを、どの経路でも名前のコードポイント順で取り、記憶をまたぐ upsert と purge/scrub の 40P01 をなくす。
  決まり（前回と同じ）: CHANGELOG の `[1.2.0]` と migration-v1 の v1.2.0 の節には触らない。既存の ADR 本文は対象外。コードの振る舞いは変えない。

## 0517（`bc4452cc`、差は `git diff eb614e16 bc4452cc`）

- **差の中身**【現物】: コードは `packages/core/src/observation-text.ts` の1行（`title.length > 0` → `title.trim().length > 0`）。TSDoc は同ファイルの `observationPayloadText` と `packages/core/src/observation.ts` の `ObserveDocumentInput.title`。文書は CHANGELOG `[1.3.0]` の Changed に1項目、migration-v1 の 🟡「v1.2.0 → 次の版」に1項目。歯は `observation-text-blank-title-not-prefixed.test.ts`。
- **3実装**【現物】:
  - Postgres: 該当なし。前置きの合成は core の純関数 `observationPayloadText` の1か所で、Postgres は `payload` を保存・読み直すだけ。
  - testkit の InMemory: 該当なし（同じく payload を保存するだけ）。
  - core の Fake: 該当なし。ADR 0517 が書くとおり `runtime-fakes.ts` は触っていない。
  - 前置きを作る場所が1か所であることを `grep`（`observationPayloadText`・`title.length`・`.title` の長さ・trim 判定を `packages/*/src` の非テストに）で確かめた。呼び出しは `extraction.ts`（2か所）・`runtime.ts`（言語の事後検査 `profileObservationLanguage`）の3つで、すべてこの関数を通る。`runtime.ts` の `payload` の組み立て（`extractTitle === true` のときだけ印を足す）は変わっていない。
- **突き合わせの結果**【現物】:
  - TSDoc 2か所（「`trim` で空になる値は空とみなす」「断らず無視する」「`title` を渡さない・空文字・空白だけのときは `content` だけ」「`content` が空文字で `title` が実質あるときは `title` だけ」）は、実装（`title.trim().length > 0` で前置き、値は trim せず、`content` が空なら `title` 単体）と一致した。
  - CHANGELOG `[1.3.0]` の項（`" \n\nC"` の前置きが無くなる、実質のある `title` は前後の空白もそのまま、`ObserveInputSchema` は変えない、`extractTitle` の既定は `false`）と、migration-v1 の項（`reextract`・`deferred` の読み直しは新しい規則で本文を作る、保存済みの Memory は書き換えない）は、実装と一致した。`ObserveInputSchema` の `title` は `z.string().min(1).optional()` のまま（`observation.ts`）。
  - 適合スイート `packages/testkit/src/*conformance*`: `title` を含む記述は無い（grep）。0517 の約束は core の純関数の単体の歯だけが持つ。
  - ルートと各パッケージの README・`docs/*.md`: `extractTitle` を書いた所は `docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけ。後者と CHANGELOG の `[1.1.0]` の「`title` が空でない文字列なら」は、出荷済みの版の記述で、いまの実装でも成り立つ（空白だけは空とみなす）。触っていない。公開 API の snapshot（`scripts/__snapshots__/public-api/core.d.ts`）は TSDoc を含まず、型は変わっていない。
- **直したもの**: なし。
- **コードの側を直すべき食い違い**: 見つからなかった。ADR 0517 自身の負債（U+200B など `trim` が落とさない文字だけの `title` は前置きになる、保存済みの Observation の読み直しで本文が変わる、`event` の `name` は空白だけでも前置きになりうる）は、そのまま残る。変更なし。
- **【未確認】**: 歯 `observation-text-blank-title-not-prefixed.test.ts`・`observe-rejects-whitespace-only-input.test.ts` を走らせていない。ADR 0517 の変異試験（`title.trim()` を前置きに使う、判定を外す）を再実行していない。Postgres を通した経路（実 DB で空白だけの `title` を保存して `reextract` する）。

## 0511（`6e71ffb4`、差は `git diff bc4452cc 6e71ffb4`）

- **差の中身**【現物】: コードは `packages/postgres/src/memory-store.ts` だけ（`compareCodePoints`・`lockExistingLabelsInNameOrder` の新設、`upsertProposedLabels` の `.sort()` を `compareCodePoints` に、`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の先取り、`purgeMemory`・`scrubPurged` の名前順 `FOR UPDATE`）。文書は CHANGELOG `[1.3.0]` の Fixed に1項目だけ。歯は `label-lock-order-cross-memory.postgres.test.ts`。
- **3実装**【現物】:
  - Postgres: 上のとおり。`labels` を触る SQL を grep で全部数えた（8か所: `lockExistingLabelsInNameOrder` の SELECT、`upsertProposedLabels` の INSERT、purge/scrub それぞれの先取りの SELECT と `UPDATE labels`、`listLabels` の SELECT、`registerLabel` の INSERT）。`upsertProposedLabels` の呼び出しは3か所で、`createMemory`（単一）・`insertMemoryWithOutboxRows`（`createMemoryWithOutbox` と `createMemoriesWithOutboxAndEvents` の候補ごと）・`supersedeWithNewMemories` の候補ごと。複数の記憶をまたぐ `createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` には先取りが入り、単一の記憶の呼び出しは1回の中が名前順なので先取りは要らない。先取りが無い経路で、複数の `labels` 行を別の順で取るものは無い。
  - testkit の InMemory（`__fixtures__/in-memory-memory-store.ts`）: 該当なし。行ロックも deadlock も無い単一プロセスの Map。`listLabels` の `name` 昇順がコードポイント順なのは、0511 より前から Postgres の `COLLATE "C"` と揃えてある（変更なし）。
  - core の Fake: 該当なし（`labels` の行ロックの概念が無い）。
- **突き合わせの結果**【現物】:
  - CHANGELOG `[1.3.0]` の項は、対象の4口（`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents`・`purgeMemory`・`scrubPurged`）、「名前のコードポイント順」、`createMemoriesWithOutboxAndEvents` は衝突した候補が例外にならず `dropped` に黙って積まれていた、公開 API・DB・`Memory.tags`・`proposedCount` は変えない、まだ無いラベルを同時に新規作成する競合は残る、のすべてが実装・ADR 0511 と一致した。
  - `memory-store.ts` の TSDoc・コメント（`compareCodePoints`・`lockExistingLabelsInNameOrder`・各呼び出し箇所・`upsertProposedLabels` の ADR 0476/0511 の注）は、SQL（`ORDER BY l.name COLLATE "C" ASC FOR UPDATE OF l`）と一致した。NUL を含む名前を先取りから外す説明も、実装（`filter((name) => !name.includes("\u0000"))`）と一致した。
  - `packages/core/src/interfaces/memory-store.ts` の TSDoc: `labels` の行ロックの順・40P01 を約束する文は無い（grep: `deadlock|40P01|行ロック|FOR UPDATE|名前順|コードポイント順`）。`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents` の約束（`dropped`・`abortIfForgotten`）と 0511 は矛盾しない。
  - 適合スイート `packages/testkit/src/memory-store-conformance.ts`: 並行する書き込みの deadlock を約束する項目は無い（grep）。0511 の約束は Postgres 固有の歯だけが持つ。これは 0511 が公開の約束を増やさなかったことと整合する。
  - ルートと各パッケージの README・`docs/`: `labels` の行ロックの順を書いた所は無い。`packages/postgres/README.md` の 40P01 の記述は migrate と observe の衝突（ADR 0442）で、別の話。`docs/migration-v1.md` に 0511 の項は無い。0476 の項も無く（CHANGELOG `[1.2.0]` の Fixed にだけ在る）、落ちる入力が減るだけの直しを migration に載せない扱いと揃っている【判断】。
  - CHANGELOG `[1.2.0]` の 0476 の項（同じ語彙を逆の並びで持つ**1つの記憶**の並行作成）は、記憶をまたぐ競合を約束していないので、0511 のあとも古くならない。触っていない。
- **直したもの**: なし。
- **コードの側を直すべき食い違い**: 見つからなかった。材料として、ADR 0511 自身の負債が残る【判断】: (3) まだ無いラベルを同時に新規作成する競合（CHANGELOG・コードの注に「残る」と書いてある）、(4) `labels` 以外の表の行ロックの順。`compareCodePoints` は孤立サロゲートを1文字として扱い、UTF-8 の `COLLATE "C"` とは順が食い違いうるが、`assertWellFormedIdentifier` 系の検査で通常は届かない入力と見ている（確かめていない）。
- **【未確認】**: 0511 の歯 6 本（`label-lock-order-cross-memory.postgres.test.ts`）と既存の label 系の歯を走らせていない（DB が要る）。ADR 0511 の変異試験（先取りを外す4種・やりすぎ1種）を再実行していない。実運用での頻度。孤立サロゲートを含む名前での並びの一致。

## まとめ

- **直したもの**: なし（0517・0511 とも、文書にずれは無かった）。
- **照らした範囲**【現物】: 上の各節に書いた。`packages/core/src/observation-text.ts`・`observation.ts`・`runtime.ts`・`extraction.ts`、`packages/postgres/src/memory-store.ts`、`packages/core/src/interfaces/memory-store.ts`、`packages/testkit/src/memory-store-conformance.ts` と `__fixtures__/in-memory-memory-store.ts`、ルートと各パッケージの README、`docs/*.md`、CHANGELOG `[1.3.0]`、`docs/migration-v1.md`、公開 API の snapshot。
- **走らせたコマンド**: `git diff`・`grep` と `node scripts/generate-adr-index.mjs`。ビルド・テスト・DB の要るテストは走らせていない。機械照合のスクリプトは、この回は通していない【未確認】（読んで突き合わせた）。

- **引き受けた負債**: この ADR の結果は `main` の `6e71ffb4` に対して測った記録で、`main` が進めば古くなる。照合の道具は repo に入れていない（ADR 0495 の代替案1のとおり）。0517・0511 の歯・変異試験を再実行していない。
- **これが覆るとしたら**: 上の探し方が拾わない種類（散文の中で `title` の前置きや `labels` のロック順を言い換えた文）の古さが見つかったとき。

## 追い足し（基準 main `0cfe277c`、ADR 0518 の分）

0518（#1647、`0cfe277c`）が main に入ったので掃いた（`git diff 6e71ffb4 0cfe277c`。この枝は `origin/main` を merge した。衝突なし。ADR 索引は `node scripts/generate-adr-index.mjs` で再生成しても差分なし）。この節もマネージャーが書いた。

- **0518 の中身**【現物】: 差は ADR 0518・`packages/core/src/interfaces/memory-store.ts` の `MemoryStatusConflictError` の TSDoc（purge 済みの行では `expectedStatus: "forgotten"` のとき `expectedStatus` と `observedStatus` が両方 `"forgotten"` になる、例外だけでは purge 済みと分からない、`Memory.purgedAt` を読む、`purge` の CAS 違反は `MemoryPurgeConflictError`）・Postgres の歯 `store-status-write-checks.postgres.test.ts` に assertion 2か所・索引だけ。実装は変わっていない。
- **3実装**【現物】:
  - Postgres（`packages/postgres/src/memory-store.ts`）: `expectedStatusCondition` が `AND status = … AND purged_at IS NULL` を付け、0行のとき `explainEmptyStatusUpdate` が `row.status` を読み直して `new MemoryStatusConflictError(id, expectedStatus, row.status)` を作る。purge 済みなら `row.status` は `"forgotten"` なので TSDoc のとおり。`conflictAfterEmptyUpdate`（`markContestedGroup`・`resolveContestedGroup` 系）も同じく読み直した `status` を詰める。TSDoc と一致した。
  - testkit の InMemory（`__fixtures__/in-memory-memory-store.ts`）: `casMismatch(memory, expected)` が `memory.status !== expected || purgedAt != null`。`updateStatus`・`updateStatusWithEvent` は `new MemoryStatusConflictError(id, opts.expectedStatus, memory.status)`、`supersedeWithNewMemories` は同じ `casMismatch` で `conflicted` に積む。purge 済みなら両方 `"forgotten"`。TSDoc と一致した。
  - **core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）: TSDoc の約束と食い違う**【現物】。`FakeMemoryStore.updateStatus`（1351 行目）・`updateStatusWithEvent`（1389 行目）の CAS は `memory.status !== opts.expectedStatus` だけで `purgedAt` を見ない。`supersedeWithNewMemories` の2か所（1468・1494 行目）も同じ。purge 済みの行（`status` が `"forgotten"`、`purgedAt` が非 null）に `expectedStatus: "forgotten"` を渡すと、例外にならず `active` へ戻してしまう（`purgedAt` は残ったまま）。TSDoc の「purge 済みの記憶への、`expectedStatus` 付きの更新は、この例外で断られる」と合わない。Postgres・InMemory は ADR 0499 で揃えたが、Fake だけ取り残されている。0518 の【未確認】も 0499 の「確かめていないこと」も Fake を未確認と書いていたので、新しく見つかったというより、未確認だった所を読んで割れが確かめられた形【判断】。読んだだけで、Fake に対して走らせてはいない。
- **文書の突き合わせ**【現物】:
  - 関連する interface の TSDoc: `MemoryStatusConflictError` の既存の段落（`observedStatus` は読み直した値で正確な相手ではない）は 0518 の追記と矛盾しない。`MemoryPurgeConflictError`・`MemoryStore.updateStatus`・`updateStatusWithEvent`・`supersedeWithNewMemories` の TSDoc に、purge 済みの行の CAS を逆の向きに言う文は無い。
  - 適合スイート `packages/testkit/src/memory-store-conformance.ts`: `MemoryStatusConflictError` の検査（4522・4669 行目付近）は `observedStatus` が `"archived"` の通常の競合だけで、purge 済みの行の CAS の検査は無い（ADR 0499 が「conformance suite は変えない」と決めたとおり）。0518 の TSDoc の約束は Postgres・InMemory の歯だけが持つ。Fake が約束を破っていても、スイートでは捕まらない。
  - CHANGELOG `[1.3.0]`（Breaking の「purge 済みの記憶」の項、58 行目）と `docs/migration-v1.md` 項目57（2532 行目「`expectedStatus` と `observedStatus` がどちらも `"forgotten"` になる」）・2791 行目の InMemory の項: 0518 の TSDoc・実装（Postgres・InMemory）と一致した。
  - `[1.3.0]` の「【確かめていないこと】」（65 行目）は「`expectedStatus`・`observedStatus` が purge 済みの行で両方 `"forgotten"` になること」を未確認として挙げている。0518 が Postgres・InMemory で実測したので、その1項は今は確かめ済み。ただし 0518 は CHANGELOG に書かない（TSDoc だけの変更は載せない）と決めており、この行は出荷時点の記録として残るため、**触らなかった**【判断】（`MemoryPurgeConflictError` を使うべきかを決めていない、という後半は今も本当）。
  - README（ルート・`packages/*/README.md`）・`docs/*.md`（`architecture.md`・`conformance.md`・`memory-model.md`）: purge 済みの行の `MemoryStatusConflictError` の中身を述べた所は無く（grep: `MemoryStatusConflictError|purge 済み|purgedAt|observedStatus`）、0518 と食い違う主張は無かった。`[1.2.0]` と migration-v1 の v1.2.0 の節には触っていない。
- **直したもの**: なし（文書の側にずれは無かった）。
- **コードの側を直すべき食い違い（材料）**【判断】: 上の core の Fake。`purgedAt` が非 null の行の CAS（`updateStatus`・`updateStatusWithEvent`・`supersedeWithNewMemories`）を、InMemory の `casMismatch` と同じにすれば揃う。Fake は `packages/core/src/__tests__/` の中で公開されない面で、0518 が「ほかの担当が触っている」として触らなかった。直す前に、Fake を使う core の歯が purge 済みの行の CAS に依っていないか見る必要がある。ここでは直さない。
- **【未確認】**: 0518 の歯（`store-status-write-checks.postgres.test.ts` の14本）と変異試験を走らせていない（DB が要る）。Fake の振る舞いを実際に呼んで確かめていない（読んだだけ）。SQL_ASCII の DB。
