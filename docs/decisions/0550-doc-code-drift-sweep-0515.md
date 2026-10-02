# ADR 0550: 文書とコードのずれを横に掃く（第7弾）— ADR 0515・0516 からの分の文書を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の指示で、マネージャー mgr-b9b6a409 とその委譲先（担い手）が書いた。

**照合の基準は main `8c2519ca`。** ADR 0545（#1653）の続きで、0545 を締めたあとに main へ入った 0515（#1648、`575042a2`）と 0516（#1649、`8c2519ca`）から掃く。**このあとマージされるものは、マージされた順に追い足す。**1時間ほどマージが入らなかったら、そこまでで締める。

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

- **直したもの**: 0515 の分だけ文書を直した。`docs/memory-model.md`（ADR 0503 の追記の直後に、ADR 0515 の2つの断りを足した）と、`packages/core/src/interfaces/memory-store.ts` の TSDoc 2語句（`updateStatus` の「`supersededById` が無くてよい」と `resolveContestedPair` の「対の外の記憶を指す `superseded` は断らない」を、0515 のあとの約束と矛盾しない形に）。0516 の分に文書のずれは無かった。型・実装・振る舞いは変えていない。
- **コードの側を直すべき食い違い（材料）**:
  1. 0515 の分: core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）が、`superseded` 以外への `supersededById`・`resolveContestedPair` の対の外の `forgotten`・ADR 0503 の `superseded` の形の検査（無い・自己置換・循環）を断らない。Postgres・InMemory と挙動が割れる。ADR 0515 自身が負債に書いていた件の確認。
  2. 0516 の分: `trigram-lexical-store.ts` の `search` 以外の DB 呼び出し（`create`・索引づくり）に `omittingParams` が無い。約束の違反ではなく、ADR 0516 の負債の一覧への補足。
  - どちらも別の PR で直す（担当はクローンが配る）。
- **照らした範囲**【現物】: 上の各節に書いた。読んだファイルは、`packages/postgres/src/memory-store.ts`（`assertSupersededByShape` の呼び出し・`resolveContestedPair` の先取り）、`outbox-store.ts`・`tenant-settings-store.ts`・`trigram-lexical-store.ts`・`event-store.ts`・`relation-store.ts`・`omit-params.ts`、`packages/testkit/src/__fixtures__/in-memory-memory-store.ts`、`packages/core/src/__tests__/runtime-fakes.ts`、`packages/core/src/interfaces/memory-store.ts`・`tenant-settings-store.ts`、`packages/testkit/src/memory-store-conformance.ts` と `*conformance*` 全体の grep、`error-message-omits-params.postgres.test.ts` の構成、ルートと各パッケージの README、`docs/*.md`（`memory-model.md`・`architecture.md`・`release-notes-v1.1.0.md`・`release-notes-v1.2.0.md`）、CHANGELOG `[1.3.0]`、`docs/migration-v1.md`（項目59・61 と 2803 行目以降）。grep の語は `supersededById`・`forbidWhenNotSuperseded`・`assertSupersededByShape`・`COALESCE`・`omittingParams`・`omitParams`・`params:`・`omitted by mnemora`・`updateStatusWithEvent(`・`this.db`。
- **走らせたコマンド**: `git fetch`・`git diff`・`grep`・`node scripts/generate-adr-index.mjs`（差分なし）。ビルド・テスト・DB の要るテストは走らせていない。機械照合のスクリプトは通していない【未確認】（読んで突き合わせた）。
- **引き受けた負債**: この ADR の結果は `main` の `8c2519ca` に対して測った記録で、`main` が進めば古くなる。0515・0516 の歯・変異試験を再実行していない。Fake・trigram の材料は、この ADR では直していない。TSDoc の2語句の直しに対して、TSDoc を検査する歯（`tsdoc` 系）を走らせていない【未確認】。
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
