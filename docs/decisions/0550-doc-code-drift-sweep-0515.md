# ADR 0550: 文書とコードのずれを横に掃く（第7弾）— ADR 0515・0516 からの分の文書を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の指示で、マネージャー mgr-b9b6a409 とその委譲先（担い手）が書いた。

**照合の基準は main `a956adf5`。** ADR 0545（#1653）の続きで、0545 を締めたあとに main へ入った 0515（#1648、`575042a2`）と 0516（#1649、`8c2519ca`）から掃く。そのあとに main へ入った 0538（#1643、`fd8b5aea`）・0535（#1637、`d480131c`）・0539（#1652、`bfb865a6`）・0519（#1651、`21fda201`）・0545（#1653、`e987150b`）・0549（#1656、`fb17ef28`）・0514（#1650、`a956adf5`）は、末尾の追い足しの節で掃いた（照らしたのは 0515・0516・0538・0535・0539・0519・0545・0549・0514 の9つ）。**このあとマージされるものは、マージされた順に追い足す。**1時間ほどマージが入らなかったら、そこまでで締める。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

決まり（前回と同じ）: CHANGELOG の `[1.2.0]` と migration-v1 の v1.2.0 の節には触らない。既存の ADR 本文は対象外。コードの振る舞いは変えない。ずれがあれば文書をコードに合わせ、コードの側が約束を破っていそうなら直さずに材料として残す。

## 0515（`575042a2`、差は `git diff 0cfe277c 575042a2`）

- **文脈**: 0515 は、ADR 0503 の負債2つを返す。(1) `resolveContestedPair` が、対の外の `forgotten` な記憶を指す `supersededById` を断る（群版は 0503 から断っていた）。(2) `updateStatus`・`updateStatusWithEvent` が、`superseded` 以外の status（`active`・`archived`・`forgotten`）に付けた `supersededById` を断る。どちらも書く前に素の `RangeError`。
- **差の中身**【現物】: コードは `packages/postgres/src/memory-store.ts`（`forbidWhenNotSuperseded` を2か所 `false` → `true`、`resolveContestedPair` のトランザクション内に `SELECT 1 … status = 'forgotten'` の先取りを追加）と `packages/testkit/src/__fixtures__/in-memory-memory-store.ts`（同じ2か所と、`rawGet(...)?.status === "forgotten"` の判定）。TSDoc は `packages/core/src/interfaces/memory-store.ts` の `updateStatus`・`updateStatusWithEvent`・`resolveContestedPair` に各1か所。文書は CHANGELOG `[1.3.0]` の Breaking に1項目、migration-v1 の項目61（🔴「v1.2.0 → 次の版」）。歯は Postgres の `store-superseded-by-checks.postgres.test.ts`（InMemory と Postgres に同じ入力）と testkit の `in-memory-superseded-by-checks.test.ts`。
- **3実装**【現物】:
  - Postgres: `assertSupersededByShape` の呼び出しは5か所（`updateStatus`・`updateStatusWithEvent`・`resolveContestedPair` の first/second・`resolveContestedGroup`）で、`forbidWhenNotSuperseded` は全部 `true` になった。message は `<口>: opts.supersededById must not be set unless status is "superseded"`（TSDoc・CHANGELOG と一字一致）。位置は `contested` の検査のあと、存在確認・テナント照合・CAS より前（TSDoc の「同じ位置」と一致）。`resolveContestedPair` の先取りは、両側が `contested` と確かめたあと（CAS のあと）・書く前で、`ref === first.id || ref === second.id` は読み飛ばす。SELECT に `tenant_id` が入っているので、別テナントの id は当たらず、UPDATE の切り分け（ADR 0439）の「memory not found」に落ちる。TSDoc の「テナントの照合のあと」は結果として成り立つ。
  - testkit の InMemory: 上と同じ2か所の `true` と、`assertOwnMemoryRef`（ADR 0439）のあと・書く前の判定。message は Postgres と同じ。
  - core の Fake（`runtime-fakes.ts`）: **0515 の約束と食い違う**。`updateStatus`（1335 行目付近）・`updateStatusWithEvent`（1374 行目付近）・`resolveContestedPair`（2509 行目付近）に `assertSupersededByShape` 相当は無く、`supersededById` を渡されれば `assertOwnMemoryRef` のあとそのまま書く。ADR 0503 の `superseded` に `supersededById` が無い・自己置換・循環の断りも、Fake にはまだ無い。ADR 0515 の「引き受けた負債」・CHANGELOG の【確かめていないこと】が自分で書いているとおり（PR #1643 が触っているため）で、新しい発見ではない。読んだだけで、Fake に対して走らせてはいない【判断】。
- **突き合わせの結果**【現物】:
  - TSDoc 3か所の新しい文は、実装と一致した。ただし周りの既存の文が2か所、0515 のあとで読みにくくなっていた。(a) `updateStatus` の「`superseded` 以外の status は、`supersededById` が無くてよい」（ADR 0503 の文。付けてよいとも読める）。(b) `resolveContestedPair` の「対の外の記憶を指す `superseded` は断らない」（直後の (5) が `forgotten` を断る）。
  - CHANGELOG `[1.3.0]` の項（2口の message、`COALESCE` で `superseded_by_id` が残っていたこと、`Runtime` 経由は変わらない、対の相手・対の外の `active`・`archived` は断らない）は、実装と ADR と一致した。`Runtime` の `updateStatusWithEvent` の呼び出し4か所（`runtime.ts` の 5628・6601・6911・8563 行目付近）のうち `supersededById` を渡すのは `superseded` を書く2か所、という文は、`grep` で呼び出しが4か所であることまで確かめた（渡す引数の中身は ADR 0515 の記述を信じた【未確認】）。
  - CHANGELOG の 0503 の項（79〜84 行目）は ADR 0503 の時点の記述で、「断らないもの」に「`superseded` 以外の status（`supersededById` 無し）」と書いてあるのは今も成り立つ（無しなら通る）。触っていない。
  - migration-v1 の項目61: 「(a) `resolveContestedPair` で、書く時点で既に `forgotten` な記憶を置き換えた側に指している」「(b) `updateStatus*` で `active`・`archived`・`forgotten` に付けている」「`superseded_by_id` を外したいなら `restoreSuperseded`」は、実装と一致した（`restoreSuperseded` は `restoreSupersededBy` の別の口で `NULL` へ戻す。interface の TSDoc の「`NULL` へ戻す経路が無い」は `updateStatus*` の話で、矛盾しない）。項目59（0503）は `updateStatus*` の `superseded` 以外を断るとは書いていない。
  - 適合スイート `packages/testkit/src/memory-store-conformance.ts`: `updateStatus*` に `supersededById` を渡す呼び出し（4422・4491・4511・4578・4624・4653・4690・4722・4752 行目付近）は全部 `"superseded"` で、`resolveContestedPair` の下ごしらえ（8121 行目付近）も `superseded` のときだけ渡す。0515 の断りで赤になる項目は無い。断りの歯はスイートに無く、第三者の adapter は検査されない（ADR 0434 決定5。CHANGELOG の「第三者の adapter は断りを持たない」と一致）。
  - `docs/memory-model.md` 427 行目の ADR 0503 の追記（`supersededById` の約束を壊す入力を列挙する）: 0515 の2つが列挙に無かった。**古くなっていた**。
  - ルートと各パッケージの README、`docs/architecture.md`（`updateStatus` の型だけ）、`docs/conformance.md`: `supersededById` を断る・断らないと述べた所は無い（grep）。`[1.2.0]` と migration-v1 の v1.2.0 の節には触っていない。公開 API の snapshot は TSDoc を含まず、型は変わっていない。
- **直したもの**:
  - `docs/memory-model.md`（ADR 0503 の追記の直後）に、「ADR 0515 から、`resolveContestedPair` の対の外の `forgotten`、`updateStatus*` の `superseded` 以外への `supersededById` も断る（上の列挙は ADR 0503 の時点）」の1段落を足した。
  - `packages/core/src/interfaces/memory-store.ts` の TSDoc を2語句だけ直した。(a) 「`supersededById` が無くてよい」→「無いこと（付けると断る。次の ADR 0515）」。(b) 「対の外の記憶を指す `superseded` は断らない」→「対の外の（`forgotten` でない）記憶を指す…（`forgotten` は下の (5)）」。型・実装は変えていない。
- **コードの側を直すべき食い違い（材料）**【判断】: core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）が、(1) `superseded` 以外の status への `supersededById`、(2) `resolveContestedPair` の対の外の `forgotten`、(3) ADR 0503 の `superseded` の形の検査（無い・自己置換・循環）を断らない。Postgres・InMemory と同じ入力を流すと挙動が割れる。直すなら、InMemory の `assertSupersededByShape`・`assertNoSupersededCycle` と同じ検査を足す。直す前に、Fake を使う core の歯が、これらの入力に依っていないか見る必要がある。ここでは直さない。
  - 別の PR で直す（担当はクローンが配る）。
- **【未確認】**: 歯 `store-superseded-by-checks.postgres.test.ts`（DB が要る）・`in-memory-superseded-by-checks.test.ts` と、ADR 0515 の変異試験を走らせていない。ADR 0515 の負債（`updateStatus*` は `superseded` のとき `forgotten` な記憶を指す `supersededById` を断らない、検査のあとに指す先が `forgotten` になる並行は Postgres で断れない）は、そのまま残る。Fake の振る舞いを実際に呼んでいない（読んだだけ）。


## 0516（`8c2519ca`、差は `git diff 575042a2 8c2519ca`）

- **文脈**: 0516 は、ADR 0504・0505 の負債の続きとして、`PostgresTrigramLexicalStore.search`・`PostgresOutboxStore`・`PostgresTenantSettingsStore` を `Runtime` を通さずに直接呼んだときの例外の message（`cause` の連鎖・`stack` を含む）から、SQL に付けた値（`params:` より後ろ）を落とす。
- **差の中身**【現物】: コードは `packages/postgres/src` の `trigram-lexical-store.ts`・`outbox-store.ts`・`tenant-settings-store.ts` で、DB を呼ぶ箇所を既存の `omittingParams`（`omit-params.ts`）で包んだだけ（`omit-params.ts` 自体と export は変えていない）。文書は CHANGELOG `[1.3.0]` の Fixed に1項目、migration-v1 の「v1.2.0 → 次の版で、挙動が変わるが手順は要らないもの」（2803 行目の見出し。🟡）に1項目。歯は `error-message-omits-params.postgres.test.ts`（既存14本に24本）。TSDoc の変更は無い。
- **3実装**【現物】:
  - Postgres: 包みの数を `grep` で数えた。`outbox-store.ts` は DB を呼ぶ 8 か所（`claimBatch`・`complete`・`fail`・`raiseIfLeaseConflict`・`eraseTenant` の2・`purgeCompletedJobs` の2）がすべて `omittingParams(` の中、`tenant-settings-store.ts` は 14 か所（`get`・`set`・`has` の12と `eraseTenant` の2）がすべて中、`trigram-lexical-store.ts` の `search` の `db.transaction` は中。ADR・CHANGELOG の「8つの呼び」「14」と一致した。`OutboxLeaseConflictError`（DB の例外ではない）は包みの外で投げており、`raiseIfLeaseConflict` の中の `throw` も包みの外（`complete` の `UPDATE` のあと）で、変わらない。`eraseTenant` のトランザクション内の `lockTenantForErase(tx, …)` は、外側の `db.transaction` の包みで掛かる。
  - testkit の InMemory・core の Fake: 該当なし。drizzle も SQL も無く、`params:` を含む例外が出ない。
- **突き合わせの結果**【現物】:
  - CHANGELOG `[1.3.0]` の項（3つの store、`cause` の連鎖・message・`stack`、`(omitted by mnemora, N chars)`、`kind`・`name`・`code`・`cause` は残る、破壊的と数えない）と、migration-v1 の項（SQL の文・SQLSTATE・`cause` は残る、`PostgresMemoryStore`・`PostgresRelationStore` は対象外）は、実装と一致した。migration-v1 の項は v1.2.0 の節ではなく「v1.2.0 → 次の版」の節（2803 行目の見出しの下）に在る。
  - CHANGELOG の「変えなかったこと」（`PostgresMemoryStore`・`PostgresRelationStore`・`EventStore.get`・`list` の直接呼び）は、`memory-store.ts`・`relation-store.ts` に `omittingParams` が無く、`event-store.ts` は `append` の2か所だけが包まれ `get`（117 行目）・`list`（150 行目）は包まれていないことで一致した。
  - `omit-params.ts` の冒頭コメントは ADR 0504 の記述で、どの store が使うかを列挙していない。0516 のあとも古くならない。`packages/core/src/interfaces/tenant-settings-store.ts`（569 行目）の「`params:` より後ろを落とす」は、Runtime 側の ADR 0423 の作法の話で、store 直接呼びの約束ではない。矛盾しない。
  - 適合スイート `packages/testkit/src/*conformance*`: 例外の message の `params` を検査する項目は無い（grep: `params`・`omit`）。0516 の約束は Postgres 固有の歯だけが持つ。
  - ルートと各パッケージの README・`docs/*.md`: store を直接呼んだ例外の message を述べた所は、CHANGELOG と migration-v1 だけ。`docs/release-notes-v1.1.0.md` 249 行目の `tick()` の `lastError`（ADR 0363）と `docs/release-notes-v1.2.0.md` 87 行目の `Runtime` が投げ直す例外（ADR 0423）は別の話で、出荷済みの記述として成り立つ。
  - 歯のファイルの数: ADR の「24本」は、`it` が 24（`for` で束ねたものを含む定義の数）という数え方と一致する。実際に走った本数は走らせていない【未確認】。
- **直したもの**: なし。
- **コードの側を直すべき食い違い**: 約束を破っているものは見つからなかった。材料として、ADR 0516 に書かれていない口を1つ見つけた【現物】: `trigram-lexical-store.ts` には `search` のほかに、`create`・索引づくりの経路で `db.execute`・`db.transaction` を直接呼ぶ箇所が在り（384・400・407・423・438・442・464・479・615 行目付近）、`omittingParams` で包まれていない。ADR・CHANGELOG・migration-v1 は「`search`」だけを約束しており、嘘ではない。ADR 0516 の負債の一覧には出ていないので、この ADR で補う【判断】。起動時の経路で、`params` に入るのは設定値・名前くらいと見ている（読んだだけで、利用者データが入るかは確かめていない【未確認】）。別の PR で直すかは、クローンの判断（直すなら担当はクローンが配る）。
  - ADR 0516 自身の負債（`PostgresMemoryStore`・`PostgresRelationStore`・`EventStore.get`・`list` の直接呼びは params が残る、新しい口に包みを付け忘れても型・lint で気づけない）は、そのまま残る。
- **【未確認】**: 歯 `error-message-omits-params.postgres.test.ts` を走らせていない（DB が要る）。ADR 0516 の変異試験（包みを1つずつ外す）を再実行していない。`complete`・`fail` の `OutboxLeaseConflictError` が包みの影響を受けないことの専用の歯は無い（ADR 0516 が認めている）。実運用の拒まれ方（タイムアウト・接続断）での message。`DrizzleQueryError.params` プロパティが残ること（ADR の負債）。

## まとめ

- **直したもの**: 0515・0538・0535 の分で文書を直した（0516・0539・0519・0545 の分に文書のずれは無かった）。0538 は `docs/memory-model.md` 1964 行目に Fake の1文、0535 は CHANGELOG `[1.3.0]` と migration-v1（v1.2.0 → 次の版の節）の ADR 0504 の項に、ADR 0516 で落とす store を足した（追い足しの節）。0515 の分は: `docs/memory-model.md`（ADR 0503 の追記の直後に、ADR 0515 の2つの断りを足した）と、`packages/core/src/interfaces/memory-store.ts` の TSDoc 2語句（`updateStatus` の「`supersededById` が無くてよい」と `resolveContestedPair` の「対の外の記憶を指す `superseded` は断らない」を、0515 のあとの約束と矛盾しない形に）。0516 の分に文書のずれは無かった。型・実装・振る舞いは変えていない。
- **コードの側を直すべき食い違い（材料）**:
  1. 0515 の分: core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）が、`superseded` 以外への `supersededById`・`resolveContestedPair` の対の外の `forgotten`・ADR 0503 の `superseded` の形の検査（無い・自己置換・循環）を断らない。Postgres・InMemory と挙動が割れる。ADR 0515 自身が負債に書いていた件の確認。
  2. 0516 の分: `trigram-lexical-store.ts` の `search` 以外の DB 呼び出し（`create`・索引づくり）に `omittingParams` が無い。約束の違反ではなく、ADR 0516 の負債の一覧への補足。
  - どちらも別の PR で直す（担当はクローンが配る）。
- **照らした範囲**【現物】: 上の各節に書いた。追い足しの分（0538・0535）は、`runtime-fakes.ts` の `purgeExpiredEventsSync`、Postgres・InMemory の `events_purged` の書き手、`memory-store.ts`（interface）の `purgeExpiredEvents` の TSDoc、適合スイートの A10、`docs/conformance.md`・`docs/memory-model.md`、`runtime.ts` の `already_purged` の TSDoc と呼び出し、`query-check.ts` と InMemory の `seqSumOverflowsBigint`、`event-store.ts`・`relation-store.ts`・`memory-store.ts` の `omittingParams` の有無、CHANGELOG `[1.3.0]` 97・112 行目、migration-v1 の項目60・2810 行目。読んだファイルは、`packages/postgres/src/memory-store.ts`（`assertSupersededByShape` の呼び出し・`resolveContestedPair` の先取り）、`outbox-store.ts`・`tenant-settings-store.ts`・`trigram-lexical-store.ts`・`event-store.ts`・`relation-store.ts`・`omit-params.ts`、`packages/testkit/src/__fixtures__/in-memory-memory-store.ts`、`packages/core/src/__tests__/runtime-fakes.ts`、`packages/core/src/interfaces/memory-store.ts`・`tenant-settings-store.ts`、`packages/testkit/src/memory-store-conformance.ts` と `*conformance*` 全体の grep、`error-message-omits-params.postgres.test.ts` の構成、ルートと各パッケージの README、`docs/*.md`（`memory-model.md`・`architecture.md`・`release-notes-v1.1.0.md`・`release-notes-v1.2.0.md`）、CHANGELOG `[1.3.0]`、`docs/migration-v1.md`（項目59・61 と 2803 行目以降）。grep の語は `supersededById`・`forbidWhenNotSuperseded`・`assertSupersededByShape`・`COALESCE`・`omittingParams`・`omitParams`・`params:`・`omitted by mnemora`・`updateStatusWithEvent(`・`this.db`。
- **走らせたコマンド**: `git fetch`・`git diff`・`grep`・`node scripts/generate-adr-index.mjs`（差分なし）。ビルド・テスト・DB の要るテストは走らせていない。機械照合のスクリプトは通していない【未確認】（読んで突き合わせた）。
- **引き受けた負債**: この ADR の結果は `main` の `a956adf5` に対して測った記録で、`main` が進めば古くなる。0515・0516・0538・0539・0519・0549・0514 の歯・変異試験を再実行していない。Fake・trigram の材料は、この ADR では直していない。TSDoc の2語句の直しに対して、TSDoc を検査する歯（`tsdoc` 系）を走らせていない【未確認】。
- **これが覆るとしたら**: 上の探し方が拾わない種類（散文で `supersededById` の扱いや store の例外の message を言い換えた文）の古さが見つかったとき。Fake を直す PR で Fake の振る舞いが割れていないと分かったとき（材料1が消える）。

## 追い足し（基準 main `d480131c`、ADR 0538・0535 の分）

0538（#1643、`fd8b5aea`）と 0535（#1637、`d480131c`）が main に入ったので、マージされた順（0538 → 0535）に掃いた。この枝は `origin/main` を merge した（衝突なし。ADR 索引は `node scripts/generate-adr-index.mjs` で再生成しても差分なし）。この節は担い手が書いた。

### 0538（`fd8b5aea`、差は `git diff 8c2519ca fd8b5aea`）

- **0538 の中身**【現物】: 保持と掃除の口（`purgeExpiredEventsByRetention`・`purgeExpiredRecalls`・`purgeCompletedJobs`）を Fake・InMemory・Postgres の3者で突き合わせる歯を足した。割れていたのは1点で、Fake の `events_purged` の `meta`（`oldestPurgedAt`・`newestPurgedAt`・`olderThan`）が `Date` のままだった。差は ADR 0538・歯2ファイル（`fake-retention-purge-parity.test.ts`・`retention-purge-parity.postgres.test.ts`）・索引・`packages/core/src/__tests__/runtime-fakes.ts` の9行だけ。TSDoc・CHANGELOG・migration-v1 は変えていない（ADR 0538 決定1）。
- **3実装**【現物】:
  - Postgres（`memory-store.ts` 1756 行目付近）: `JSON.stringify({ purgedCount, oldestPurgedAt, newestPurgedAt, olderThan })` を `jsonb` へ。`Date` は JSON で ISO 8601 の文字列になる。
  - testkit の InMemory（`in-memory-memory-store.ts` 1790 行目付近）: `toISOString()` で文字列、`null` は `null`。
  - core の Fake: `purgeExpiredEventsSync`（`purgeExpiredEvents`〔1604 行目〕と `purgeExpiredEventsByRetention`〔1687 行目〕が共有する本体）が、いま `toISOString()` で文字列にしている。`events_purged` を積む本番の書き手はこの3つだけ（`grep` の `events_purged`）。3者が揃った。Fake の `scrubPurged` は無い（0538 の言うとおり）。
- **突き合わせの結果**【現物】:
  - `packages/core/src/interfaces/memory-store.ts` の `purgeExpiredEvents` の TSDoc（1665 行目）は「`meta` は `{ purgedCount, oldestPurgedAt, newestPurgedAt, olderThan }` の4欄のみ」で、型を書かない。0538 の「型は TSDoc に書いていない」と一致した。矛盾は無い。
  - 型を言う文書は2つ在る。適合スイートの A10（`memory-store-conformance.ts` 5828 行目、`docs/conformance.md` 48 行目）は ISO 8601 の文字列を検査し、これは InMemory と Postgres を縛る。Fake は適合スイートを通らないので、これまで Fake だけが割れても捕まらなかった（0538 が歯で縛った）。`docs/memory-model.md` 1964 行目は「`@mnemora/postgres` と `@mnemora/testkit` の fixture が文字列」と書き、Fake を挙げていなかった（嘘ではないが、Fake が割れていた間の空白がそのまま残っていた）。
  - Fake の `events_purged` の `meta` を `Date` として読むテストは見つからなかった（`grep` で `oldestPurgedAt` を `toEqual(new Date`・`toBeInstanceOf(Date)` で比べる所は、いずれも返り値の側で、`meta` ではない）。0538 の「名指しの14本が緑」を再実行はしていない【未確認】。
  - ルートと各パッケージの README・ほかの `docs/*.md`: `events_purged` の `meta` の型を述べた所は上の2つだけ（grep: `events_purged`）。
- **直したもの**: `docs/memory-model.md` 1964 行目の箇条に、「core の Fake（非公開）も ADR 0538 から同じく文字列で持つ」の1文を足した。ほかは無い。
- **コードの側を直すべき食い違い**: 見つからなかった。0538 自身が残した材料（`scrubPurged` を3者で比べる歯は、`createMemory` が `purgedAt` を受けないので足せていない。`purgeExpiredEventsByRetention` の並行は Postgres 固有の歯だけ）は、そのまま残る。変更なし。
- **【未確認】**: 0538 の歯2本（Postgres は DB が要る）と変異試験 19 件を走らせていない。Fake の `purgeExpiredEvents` を実際に呼んで `meta` の型を見ていない（読んだだけ）。

### 0535（`d480131c`、差は `git diff fd8b5aea d480131c`）

- **0535 の中身**【現物】: 0535 は文書の横掃き（第5弾、0530 から）で、差は ADR 0535・索引のほかに、文書とコメントの直し4か所だけ。CHANGELOG `[1.3.0]` の ADR 0504 の項（112 行目）、migration-v1 の項目60 の参照先（`[1.2.0]` → `[1.3.0]`）と ADR 0504 の項（2810 行目）、`packages/core/src/runtime.ts` の TSDoc 3か所（`PurgeResidueCleanup`・`already_purged` の2か所に ADR 0512 の `recalls.index_band` を足した）、`packages/testkit/src/fixtures.ts` の冒頭コメント1行（bigint 溢れを ADR 0505 で揃えた）。実行時の振る舞いは変えていない。
- **3実装**: 0535 の直しはどれも文書とコメントで、3実装の振る舞いの約束を新しく足していない。直しが言う内容を、コードの側で確かめた【現物】:
  - `runtime.ts` の `already_purged` の TSDoc（`dryRun` が `false` なら `scrubPurged` をベストエフォートで試みる、書き込みは「下の `scrubPurged` の後始末を除く」）: 呼び出しは 7028〜7042 行目で、`scrubPurged` が無い adapter では飛ばす。一致。`recalls.index_band` の目次帯を伏せること: Postgres（`memory-store.ts` 3335 行目付近の `UPDATE recalls SET index_band = jsonb_set(...)`）と InMemory（`in-memory-memory-store.ts` 2810 行目付近）の `scrubPurged` が持つ。一致。core の Fake は `scrubPurged` を実装しない（0538 も同じ）ので、後始末は飛ばされる。TSDoc の「無い adapter では飛ばす」と整合する。
  - `fixtures.ts` の「`archiveDecayed`・`aggregateScope`・`VectorStore.search` の `S_x` を足す式の bigint 溢れも、ADR 0505 で揃えた」: InMemory に `seqSumOverflowsBigint`（`query-check.ts`、BigInt で足して 2^63 以上を断る）の呼び出しが、`in-memory-memory-store.ts`（67・395・2013〜2023 行目付近）と `in-memory-vector-store.ts`（20・311〜378 行目付近）に在る。一致。
  - CHANGELOG の ADR 0504 の項に足した句（`PostgresEventStore.append`・`PostgresLexicalStore.search` は、のちに ADR 0505 で落とすようにした）: `event-store.ts` の `append`・`lexical-store.ts` の `search` が `omittingParams` で包まれており、一致した。migration-v1 項目60 が指す `[1.3.0]` の Breaking の NUL の箇条（97 行目）は在る。
- **突き合わせの結果**: 上の直しは、0535 の時点では正しかったが、**0516 が入って、ADR 0504 の項の2か所が古くなった**【現物】。0516 は `PostgresTrigramLexicalStore.search`・`PostgresOutboxStore`・`PostgresTenantSettingsStore` も落とすようにした（この ADR の0516の節）。CHANGELOG の項は「そのうち … は ADR 0505 で」で足りず、migration-v1 の項は「ほかの store の直接呼びは、まだ落ちない（…ADR 0505 で…）」が、0516 の3つについて成り立たなかった。
- **直したもの**: 上の2か所に、「`PostgresTrigramLexicalStore.search`・`PostgresOutboxStore`・`PostgresTenantSettingsStore` は ADR 0516 で」を足した（CHANGELOG `[1.3.0]` 112 行目、migration-v1 の v1.2.0 → 次の版の節 2810 行目。`[1.2.0]` と migration-v1 の v1.2.0 の節には触っていない）。0535 の ADR 本文は直していない。
- **コードの側を直すべき食い違い**: 見つからなかった。0535 が材料として残したもののうち、いまも残っているか確かめた【現物】:
  - ADR 0504 の表の負債（`PostgresMemoryStore`・`PostgresRelationStore`・`EventStore.get`・`list` の直接呼びは params が残る）: 0516 のあとも残る（`memory-store.ts`・`relation-store.ts` に `omittingParams` が無く、`event-store.ts` は `get`・`list` が包まれていない）。0535 が書いた「0505 は 2 口だけ」は、0516 で3つの store に広がった。残りの負債の範囲は、この ADR の0516の節のとおり。
  - ADR 0530 の3点（`limit` の既定と `leaseMs` の関係、`OutboxStore` にリースを延ばす口を足すか、`reflect` の二重を許すか）はオーナーの領分で、ここでは確かめ直していない。ADR 0532 の負債（Fake の `tick` 経由の `meta.sources`）・ADR 0508 の日本語の非対称（Fake が日本語を引けない）も、読み直していない【未確認】（0535 の深追いはしない指示のとおり）。
  - 0535 が「ADR 0541 は未マージでこの枝の tree に無いので照らせていない」と書いた件: いまも `docs/decisions` に 0541 が無い（0542 だけ在る）。状況は変わらない。
- **【未確認】**: 0535 が「一致した」と書いた各行を当て直していない（上は、直した4か所とその言い分だけ）。0535 のあとで入った PR の文書への影響は、0515・0516・0538 の節で見た範囲だけ。


## 追い足し（基準 main `bfb865a6`、ADR 0539 の分）

0539（#1652、`bfb865a6`）が main に入ったので掃いた（`git diff d480131c bfb865a6`。この枝は `origin/main` を merge した。衝突なし。ADR 索引は `node scripts/generate-adr-index.mjs` で再生成しても差分なし）。この節も担い手が書いた。

### 0539（`bfb865a6`）

- **0539 の中身**【現物】: 差は ADR 0539・索引・歯2本（`fake-claim-key-parity.test.ts`、`claim-key-parity.postgres.test.ts`）だけで、コード・TSDoc・CHANGELOG・migration-v1 の変更は無い。claim key の読み口（`findActiveByClaimKey?`・`findContestedByClaimKey?`・`listActiveClaimPredicates?`）と `observe` の `claimKey` 有効経路を3者に流して、割れは無かったという記録。
- **3実装**【現物】: コードの変更が無いので、ADR 0539 が「3者で揃っている」と言う契約を、いまのコードと TSDoc で確かめた。
  - Postgres（`memory-store.ts` 3647・3710 行目）: `content_hash <>`・半開区間の重なり（`valid_from < …`・`… < valid_until`）・保存済みの行の側の空・逆転の除外（`valid_from < valid_until`）が SQL に在り、`LIMIT` は無い（ADR 0539 §6 の「LIMIT が無い」と一致）。
  - testkit の InMemory・core の Fake: 実装を読み直していない。ADR 0539 の `EXPECTED`（73 項目）が3者一致という実測を信じた【未確認】。
- **突き合わせの結果**【現物】:
  - `packages/core/src/interfaces/memory-store.ts` の TSDoc（`findActiveByClaimKey?` 2330〜2380 行目、`findContestedByClaimKey?` 2409〜2424 行目）: `subjectId` は NULL 同士も一致、鍵は正規化済みの文字列をそのまま等値比較（口自体は正規化しない）、`status` の絞り（active／contested）、`excludeMemoryId`・`contentHash` の除外、半開区間 `[validFrom, validUntil)`・空区間と逆転区間は問い合わせ側も保存済みの行側も何とも重ならない、順序は規定しない。ADR 0539 §1 の「契約」の段と一字ずつ一致した。
  - `listActiveClaimPredicates?` の TSDoc（2470〜2510 行目）: 述語が非 NULL の行だけ、重複を除き最も新しい行で代表、新しい順、同着はコードポイント順、`limit` を超えない、`claim_key_subject` は返さない。ADR 0539 §1 と一致した。同着の並びは適合スイート（`memory-store-conformance.ts` 2848 行目）が縛っていて、§6 の「測っていない」の言い分と一致する。
  - `docs/memory-model.md` 189 行目（空・逆転の区間を何とも重ねない、「3実装とも同じ」）、504 行目（片方欠落の claim key は `findActiveByClaimKey` に一致せず `listActiveClaimPredicates` にも数えられない）、521〜575 行目（検出の流れ、相手 0・1・2件以上）、`docs/conformance.md` 35 行目: 0539 と食い違う主張は無かった。鍵の正規化・大文字小文字・空白を畳む、と store の口について言う文は無い（grep: `findActiveByClaimKey`・`findContestedByClaimKey`・`listActiveClaimPredicates`・`正規化`・`NFC`）。
  - CHANGELOG `[1.3.0]`・migration-v1 の v1.2.0 → 次の版の節: claim key の読み口の振る舞いを述べた項は無い（NUL の項だけ。別の話）。ルートと各パッケージの README: 該当の記述は無い。
  - 適合スイート: claim key の項目は在り、0539 は「conformance に足さない」（ADR 0434 決定5）で、スイートは変わっていない。
  - ADR 0539 §6 が「既存の歯が縛る」と挙げたファイルは在る（`fake-list-claim-predicates-limit.test.ts`・`claim-key-oversized-part.test.ts`・`claim-key-oversized-part.postgres.test.ts`・`claim-key-index.postgres.test.ts`・`claim-key-index-limit-error.postgres.test.ts`）。
- **直したもの**: なし（文書の側にずれは無かった）。
- **コードの側を直すべき食い違い**: 見つからなかった。ADR 0539 が残した材料は、いまも成り立つ【現物】: 同着の並びを3者で比べていない（適合スイートが縛る）、`observe` の検出ロジック自体への変異は測っていない、`findActiveByClaimKey` に `LIMIT` が無い（Postgres の SQL で確認）。オーナーの領分の材料は無し。
- **【未確認】**: 0539 の歯2本（Postgres は DB が要る）と変異試験 85 件を走らせていない。Fake・InMemory の読み口を読み直していない。ADR 0539 の「3者一致」を、この回は当て直していない。

## 追い足し（基準 main `21fda201`、ADR 0519 の分）

0519（#1651、`21fda201`）が main に入ったので掃いた（`git diff bfb865a6 21fda201`。この枝は `origin/main` を merge した。衝突なし。ADR 索引は再生成しても差分なし）。この節も担い手が書いた。

### 0519（`21fda201`）

- **0519 の中身**【現物】: 差は ADR 0519・索引・Postgres の歯1本（`store-reinforce-purged-checks.postgres.test.ts`）と、`packages/core/src/interfaces/memory-store.ts` の `reinforce` の TSDoc の4行（purged の箇条の末尾の「InMemory 側は測っていない」を「InMemory も同じ…」に書き換え）。実装は変えていない。主張は、purge 済みの記憶に対して、InMemory も Postgres も `reinforce`・`reinforceMany`・`recordUsageAndReinforce` が弾かず `lastReinforcedAt`・`decayFloorAt` を書き換える（`status`・`purgedAt`・`content`・`memory_events` は不変）。
- **3実装**【現物】:
  - Postgres（`memory-store.ts` の `reinforce` 2008 行目、`reinforceManyOn` 2163 行目、`recordUsageAndReinforce` 2305 行目付近）: 各メソッドの範囲に `purged_at`・`purgedAt` を条件にする所は無い。
  - testkit の InMemory（`in-memory-memory-store.ts` の `reinforce` 1964 行目、`reinforceMany` 2057 行目、`recordUsageAndReinforce` 2078 行目付近）: 各範囲に `purgedAt`・`status` を見る所は無い。no-op（起点以前の `at`）は現在の行を返す。0519 の言い分と一致した。
  - core の Fake（`runtime-fakes.ts` の `reinforce` 1732 行目、`reinforceMany` 1808 行目、`recordUsageAndReinforce` 1829 行目付近）: 0519 は Fake を見ていない。読むと、`purgedAt`・`status`・`forgotten` を見る所は無く、no-op（起点以前の `at`）も現在の行を返す。形は InMemory・Postgres と同じで、purge 済みでも書き換わる。**割れは見つからなかった**（読んだだけ。Fake に対して走らせていない【未確認】）。
- **突き合わせの結果**【現物】:
  - 書き換えた TSDoc の文は、上の3実装と一致する。参照先（`reinforce-purged-memory.postgres.test.ts`・`store-reinforce-purged-checks.postgres.test.ts`・ADR 0453・0501・0519）はすべて在る。TSDoc は Fake に触れておらず、嘘ではない。
  - 適合スイート `memory-store-conformance.ts`: purge 済みの記憶への `reinforce` を検査する項目は無い（grep）。0519 は「conformance に足さない」（ADR 0434 決定5）で、スイートは変えていない。
  - CHANGELOG `[1.3.0]`・migration-v1・README・`docs/*.md`: purge 済みの記憶への強化を述べた所は無い（grep: `reinforce` と `purge`・`forgotten` の同居）。0519 は CHANGELOG・migration-v1 を変えない決め（fixture を変える直しではない）で、それで足りる。
- **直したもの**: なし（文書の側にずれは無かった）。
- **コードの側を直すべき食い違い**: 見つからなかった。ADR 0519 が残した材料は、いまも成り立つ【現物】: 負債1（`Runtime.observe({ kind: 'memory_usage' })` 経由の purge 済みへの強化を InMemory で測っていない。TSDoc も同じく書いている）、負債2（Postgres の単体 `reinforce` を弾く変異を撃っていない）。測っていない範囲（別テナントの purge 済み、`halfLifeRecalls` を持つ記憶への `nowSeq`）も変わらない。これに「Fake は読んだだけ」を加える。
- **【未確認】**: 0519 の歯（8 本。DB が要る）と変異試験を走らせていない。Fake の `reinforce` 系を実際に purge 済みの記憶へ呼んでいない。

## 追い足し（基準 main `e987150b`、ADR 0545 の分）

0545（#1653、`e987150b`）が main に入ったので掃いた（`git diff 21fda201 e987150b`。この枝は `origin/main` を merge した。ADR 索引だけが衝突し、`node scripts/generate-adr-index.mjs` で作り直した）。この節はマネージャーが書いた。

- **0545 の中身**【現物】: 差は ADR 0545 と索引の1行だけ（`docs/decisions/0545-doc-code-drift-sweep-0517.md`・`docs/decisions/README.md`）。0545 は文書の横掃きで、0517・0511・0518 の分に文書のずれが無かったため、コード・TSDoc・CHANGELOG・migration-v1・README・`docs/*.md` のどれも変えていない。
- **3実装・文書の突き合わせ**: 0545 は振る舞いも文書も変えていないので、照らす新しい約束は無い。0545 の各節の結論（0517・0511・0518 の文書は実装と一致）は、その後の 0515・0516・0538・0535・0539・0519 の差（この ADR の上の節）が 0517・0511・0518 の触った所（`observation-text.ts`、`labels` の行ロック、`MemoryStatusConflictError` の TSDoc）に届いていないので、今も成り立つ【判断】（差のファイル一覧で見た。行ごとには当て直していない）。
- **0545 が残した材料**【現物】: core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）の `updateStatus`（1351 行目）・`updateStatusWithEvent`（1389 行目）の CAS は、main `e987150b` でも `memory.status !== opts.expectedStatus` だけで `purgedAt` を見ない。まだ残っている。これを直す PR は #1656（ADR 0549、Draft、head `ce6dc300`）として開いている（中身は読んでいない）。
- **直したもの**: なし。
- **コードの側を直すべき食い違い**: 新しいものは無い。上の Fake の件は 0545 の材料のままで、#1656 が受けている。
- **【未確認】**: #1656 の中身と、それが 0545 の材料をすべて（`supersedeWithNewMemories` の2か所を含めて）覆うか。

## 追い足し（基準 main `fb17ef28`、ADR 0549 の分）

0549（#1656、`fb17ef28`）が main に入ったので掃いた（`git diff e987150b fb17ef28`。この枝は `origin/main` を merge した。衝突なし。ADR 索引は再生成しても差分なし）。この節は担い手が書いた。0545 の節は書き換えず、その【未確認】への答えはここに書く。

### 0549（`fb17ef28`）

- **0549 の中身**【現物】: 差は ADR 0549・索引・歯 `packages/core/src/__tests__/fake-cas-purged-row.test.ts`（5 本）と、`packages/core/src/__tests__/runtime-fakes.ts` の直し。Fake に `casMismatch(memory, expectedStatus)`（`status !== expectedStatus || (purgedAt ?? null) !== null`）を置き、`expectedStatus` を見る4か所に当てた。CHANGELOG・migration-v1 は変えない決め（Fake は非公開、ADR 0549 決定4）。
- **3実装の揃い**【現物】:
  - Fake: `expectedStatus` を見る所は `grep` で全部数えて4か所で、すべて `casMismatch` を通る（`updateStatus` 1363 行目、`updateStatusWithEvent` 1401 行目、`supersedeWithNewMemories` の事前判定 1481 行目〔willSupersede の走査。同じ呼び出しで先に `superseded` にした対象は `{ status: "superseded" }` として比べる〕、同 本処理 1508 行目〔弾かれたら `conflicted` に `observedStatus: memory.status` で積む〕）。例外は `MemoryStatusConflictError(id, expectedStatus, memory.status)`。ほかに Fake で `expectedStatus` を見る口は無い。
  - testkit の InMemory: `casMismatch`（85 行目。同じ式）を `updateStatus`（1436）・`updateStatusWithEvent`（1479）・`supersedeWithNewMemories` の本処理（1675）が使い、事前判定（1604 行目）は同じ条件を式で書いている。Fake と同じ4か所。
  - Postgres: `expectedStatusCondition`（403 行目、`AND status = … AND purged_at IS NULL`）が3つの口（1315・1376・1596 行目。`supersedeWithNewMemories` は1か所の SQL）で使われ、0行なら `explainEmptyStatusUpdate` が `row.status` を読み直して同じ例外を作る。
  - **3者が揃った。** 式・例外の中身（`observedStatus` は `forgotten` のまま）・`conflicted` の形が同じ。
- **突き合わせの結果**【現物】: interface の TSDoc は Fake と食い違わない。`MemoryStatusConflictError`（34〜38 行目。purge 済みの行では `expectedStatus: "forgotten"` のとき両方 `"forgotten"` になる、例外だけでは purge 済みと分からない）、`updateStatus`（939 行目）、`updateStatusWithEvent`・`supersedeWithNewMemories`（976 行目）の「purge 済みはどの `expectedStatus` にも一致しない」は、3者とも成り立つ。`expectedStatus` を渡さない呼び出しは無条件の書き込みのまま、という TSDoc の但し書きも、Fake は `expectedStatus` が `undefined` のとき `casMismatch` を呼ばないので成り立つ。適合スイートは purge 済みの行の CAS を検査しない（ADR 0499 の決定のまま）。CHANGELOG `[1.3.0]`・migration-v1・README・`docs/*.md` に、Fake の CAS を言う文は無い。
- **0545 の【未確認】への答え**【現物】: 「#1656 が 0545 の材料（Fake の CAS が `purgedAt` を見ない）を、`supersedeWithNewMemories` の2か所を含めて覆うか」は、**覆う**。直したのは `updateStatus`・`updateStatusWithEvent`・`supersedeWithNewMemories` の事前判定と本処理の4か所で、Fake の `expectedStatus` を見る所はこれで全部。0545 の節にあった行番号（`updateStatus` 1351・`updateStatusWithEvent` 1389）は、この直しで動いている。0545 の節の「材料」は、解消済みになった。
- **0515 の材料1（Fake が `supersededById` の断りを持たない）は別件で、残っている**【現物】: Fake に `assertSupersededByShape` 相当は無く（`grep`）、`superseded` 以外への `supersededById`・対の外の `forgotten`・`superseded` の形の検査（無い・自己置換・循環）は、0549 の差に入っていない。これは別の PR で直す（担当はクローンが配る）。
- **直したもの**: なし（文書の側にずれは無かった）。
- **コードの側を直すべき食い違い**: 0549 の分は見つからなかった。ADR 0549 の負債（`casMismatch` の式の写しが Fake と testkit の2つになる）は残る。
- **【未確認】**: 歯 `fake-cas-purged-row.test.ts` を走らせていない（この clone に `node_modules` が無い）。0549 の変異試験・名指しの 21 ファイル（411 本）を再実行していない。

## 追い足し（基準 main `a956adf5`、ADR 0514 の分）

0514（#1650、`a956adf5`）が main に入ったので掃いた（`git diff fb17ef28 a956adf5`。この枝は `origin/main` を merge した。衝突なし。ADR 索引は再生成しても差分なし）。この節は担い手が書いた。

### 0514（`a956adf5`）

- **0514 の中身**【現物】: `packages/core/src/runtime.ts` の `tick` の入口が、claim の前に `kinds`（配列でない・文字列でない要素 → `TypeError`）・`limit`（0 以上 2^63 未満の整数でない → `RangeError`）・`claimedBy`（文字列でない → `TypeError`、NUL → `RangeError`）・巨大な `leaseMs`（`now - leaseMs` が `Date` の範囲外か 4714-11-24 BC〔`MIN_STORABLE_TIMESTAMP_MS` = -210866803200000〕より前 → `RangeError`）を断る。`undefined` は省略と同じ。`TickOptions` の TSDoc 4か所、CHANGELOG `[1.3.0]` の Breaking に1項目、migration-v1 の項目62、歯2本。store の実装は変えていない。
- **3実装との関係**【現物】:
  - claim 側の検査は変わらず残る。Fake（`runtime-fakes.ts` 3189 行目）と InMemory（`in-memory-outbox-store.ts` 66〜86 行目）の `claimBatch` は、`limit` が整数・非負・2^63 未満、`claimedBy` に NUL なし（Fake）、`now - leaseMs` が有効な `Date`、を見る。Postgres の `claimBatch`（`outbox-store.ts` 113 行目）は SQL の `LIMIT`・`timestamptz`・`text` 列が拒む。
  - 食い違う上限は無い。`limit` の上限は Runtime も Fake・InMemory も 2^63 で同じ。`leaseMs` の下限は、store 側が見ない `timestamptz` の下限を Runtime だけが持つ（0514 の負債2）。Runtime が先に断るので、`Runtime.tick` 経由では store の検査に当たらず、二重に断ることも例外の顔が割れることも無い。直接 `claimBatch` を呼ぶ人の顔は 3者で違うまま（0514 の負債4。CHANGELOG も「変えていない」と書く）。
  - Fake・InMemory の `claimBatch` の中のコメント（「Postgres の範囲を外れる値は揃えていない」、Issue #1041）は、store を直接呼ぶ場合については今も本当で、`tick` 経由では 0514 が塞いだ。コメントは store の話なので触らなかった。
- **突き合わせの結果**【現物】:
  - 例外の種類と message（`Runtime.tick: opts.kinds must be an array of strings`・`… opts.limit must be an integer from 0 up to (not including) 2^63`・`… opts.claimedBy must be a string`・`… must not contain NUL characters (U+0000)`・`… opts.leaseMs is out of range …`）、断らないもの（`limit: 0`・`kinds: []`・`claimedBy: ""`・0 以下の `leaseMs`・下限ちょうど）、順序（`opts` が object → `leaseMs` が有限 → `kinds` → `limit` → `claimedBy` → `leaseMs` の範囲 → claim）は、runtime.ts の実装・`TickOptions` の TSDoc・CHANGELOG・migration-v1 の表・ADR 0514 の決定で一致した。TSDoc の古い文（`leaseMs` の「ここでは断らない。store の側で落ちる」「`1e20` は断らない」、`limit` の「負数・非整数は例外になる（`claimBatch` がそのまま受け取る）」）は、0514 が書き換え済み。
  - `leaseMs` の下限の境界は、`now` が壊れた Date のときは見ない（store が断る。コードのコメントと同じ）。TSDoc・CHANGELOG はこの但し書きを書かないが、`RuntimeConfig.clock` が壊れた Date を返す入力は 0496 以来の別の話で、ずれとは数えなかった【判断】。
  - README・`docs/*.md`・`packages/bullmq` の README: `tick` の `limit`・`kinds`・`claimedBy`・巨大な `leaseMs` の扱いを述べた所は無い（grep: `1e20`・`store の側で落ち`・`leaseMs`・`claimedBy`）。`@mnemora/bullmq` は `opts.tick` を `runtime.tick(ctx, opts.tick)` へそのまま渡す（`tick-driver.ts` 109・284 行目）ので、型の外の値は、これまでの store 経由の例外の代わりに、入口の `TypeError`・`RangeError` として `onTickError` に届く。bullmq の README・TSDoc にこれと食い違う文は無かった。
  - 適合スイート: `tick` の `opts` を検査する項目は無い（ADR 0434 決定5）。
- **直したもの**: `docs/migration-v1.md` の項目62について2点（コードは変えていない）。(a) 本文の「**番号は 61 である**——項目60 の続き」を、実際の番号に合わせて「**番号は 62 である**——項目61 の続き」にした（0515 が先に項目61 を使っていた）。(b) 項目62 が項目61 の前に置かれていたので、項目61 のあとへ移した（見出しの並びが 60・61・62 になる）。（追記: 同じ並べ替えを、別の PR #1665（`5a9f37a5`、ADR なし、文書だけ）が main で先に入れた。この枝は main を merge し、衝突なしで同じ並びになった。main に対するこの枝の差は (a) の1行だけ。）`[1.2.0]` と migration-v1 の v1.2.0 の節には触っていない。
- **コードの側を直すべき食い違い**: 見つからなかった。0514 が残した材料は、いまも成り立つ【現物】: 0 以下の `leaseMs` は通る（負債1）、`MIN_STORABLE_TIMESTAMP_MS` を core に写している（負債2）、`kinds` の要素の中身は見ない（負債3）、`claimBatch` を直接呼ぶ人の顔は 3者で違う（負債4）。
- **【未確認】**: 0514 の歯2本（Postgres のほうは DB が要る）と変異試験を走らせていない。SQL_ASCII の脚。`@mnemora/bullmq`・`examples/` のテスト。NUL を含む `kinds` の要素。`tick` の入口の検査の順序を、実行して確かめていない（読んだだけ）。
