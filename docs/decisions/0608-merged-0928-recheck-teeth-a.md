# ADR 0608: 09/28 前後にマージされた #1318・#1366・#1378 の確かめ直しで見つかった穴に歯を足す（forget・purge 後の extract 再配達・restoreSupersededBy の Invalid Date・生きた接続の release(err)）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャー（mgr-52e2aa65）の依頼で、担い手が書いた。歯を書くと決めたのはクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手（またはマネージャー）の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0606](./0606-merged-pr-1002-recheck-teeth.md) などの試験だけの PR と同じ）。
この PR は「PR A」で、確かめ直しで見つかった穴のうち、変異が1つの約束に素直に対応するものだけを入れた。

## 経緯

マネージャーが、マージ済みの PR を、約束ごとに足りない側の変異を入れて確かめ直し、どの歯にも捕まらない変異を拾った【判断。拾った過程そのものは、この PR の担い手は再現していない】。この PR は、そのうち次の3本を、変異が捕まるところまで試験で埋める。

| 約束の出所 | 約束 | すり抜けた変異（マネージャーの下調べ） |
| --- | --- | --- |
| #1318・[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md) 決定1 | extract ジョブの再配達は、その Observation から今の抽出器の版で作られた Memory が status を問わず1件でも在れば、LLM を呼ばず何も書かない（forget・purge した記憶も「在る」に数える） | `processExtractJob` の `existing` を `status === "active"` に絞る |
| #1366・Issue #1229 の行3（`restoreSupersededBy` の doc の 2026-09-28 の追記） | Invalid Date の `at` でも、戻す対象が無ければ空で返す。対象が在れば今どおり例外で、1件も戻さない | Postgres の「対象が在るか」の確認の SQL からテナント条件を外す／testkit InMemory の事前検査の条件を `targets.length > 1` にする |
| #1378・[ADR 0444](./0444-pool-begin-release-rollback-error-preserved.md)（`client.ts` の `connectWithErrorListener` の doc） | `begin` が落ちた接続は `release(err)` で pool から捨てる | `release.call(client, err ?? discardWith)` から `err` を落とす |

## 決定【判断】

1. 実装は変えない。適合テストにも足さない（公開の約束を増やすのはオーナーの領分。歯は `__tests__` に置く）。
2. 歯を足す（試験だけ）。
   - **#1318**: forget した記憶・purge した記憶がある Observation に、1回目が「書いた後・complete の前」に止まった extract ジョブを再配達しても、LLM を呼ばず（2回目の LLM の出力が手つかずで残る）、`active` が増えず（残るのは `forgotten` の1件だけ）、2回目の LLM が返す別の本文が現れず、`created` が1件のままであること。2回目の LLM が別の本文を返す形にしてある（同じ本文だと、変異で書き直されても本文が同じ記憶に見え、気づけない）。
     - core の Fake: `packages/core/src/__tests__/extract-redelivery-unsaveable-fake.test.ts`
     - Postgres と testkit の InMemory: `packages/postgres/src/__tests__/tick-sequential-redelivery.postgres.test.ts`
   - **#1366a**: `packages/postgres/src/__tests__/restore-superseded-invalid-at.postgres.test.ts`。テナント A に群を作り、テナント B の ctx から A の anchor id と Invalid Date の `at` で呼んで `{ restored: [] }` が返り、A の群は `superseded` のまま。2実装。
   - **#1366b**: `packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts`。群が1件で `at` が Invalid Date なら、例外になり、Memory は `superseded` のまま、イベントは0件、store の写しが呼ぶ前と同じ。
   - **#1366c**: 同ファイルの古いテスト名「（Postgres は拒む）」を、今の事実（Postgres も対象が無ければ空で返す）に直した。
   - **#1378**: `packages/postgres/src/__tests__/transaction-begin-release.postgres.test.ts`。生きた接続に `release()` すると pool に残り（`totalCount` 1・`idleCount` 1・backend の pid が `pg_stat_activity` に在る）、同じ接続を借り直して `release(err)` すると捨てられる（`totalCount` 0・`idleCount` 0・pid が消える）。
3. ADR 0347 に追記を足す（本文は書き換えない）。`reextract` は本 ADR の確認は通らないが、後に入った「退けた記憶があれば飛ばす」確認（`listWithdrawnAmong`）は通る。

## 実測【実測】

PostgreSQL 17（`--encoding=UTF8 --locale=C.UTF-8`、自分専用のインスタンス）、pg-pool 3.14.0・pg 8.23.0。

### #1378 の前提: `release(err)` は生きた接続を捨てるか

捨てた。pg-pool の `_release(client, idleListener, err)` は `if (err || this.ending || !client._queryable || ...)` で `this._remove(client, ...)` へ進む（`node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.0/node_modules/pg-pool/index.js` の `_release`）。新しい歯が、`release()` では `totalCount` 1・`idleCount` 1・pid が残り、`release(err)` では `totalCount` 0・`idleCount` 0・pid が `pg_stat_activity` から消える（最大2秒待つ）ことを、本物の Postgres で縛る。

### 変異試験

対象ファイルを `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、緑に戻した。「穴」はマネージャーが挙げた変異、「やりすぎ」は正しい振る舞いまで壊す向きの変異。

| 約束 | 変異 | 赤になった歯 |
| --- | --- | --- |
| #1318 | 穴: `existing` を `status === "active"` に絞る | core Fake 2本（forget・purge）、Postgres・InMemory 4本（2実装 × 2） |
| #1318 | やりすぎ: 確認を常に真にする（常に飛ばす） | core Fake 11本、Postgres・InMemory とも多数（既存の「1回目の配達は抽出する」ほか）。⚠ 新しい歯もここで赤になるが、理由は「1回目から書かれないので記憶が無い」であり、狙った赤ではない |
| #1366a | 穴: 確認の SQL から `tenant_id = ${ctx.tenantId}` を外す | 新しい歯1本（Postgres のみ。InMemory はテナントで絞る別の箇所があり、この変異の対象外） |
| #1366a | やりすぎ: 対象が無いと判定した後も空で返さない（常に流す） | 既存の「対象が無いとき空で返る」1本と新しい歯1本（どちらも Postgres） |
| #1366b | 穴: 事前検査の `targets.length > 0` を `> 1` にする | 新しい歯1本 |
| #1366b | やりすぎ: `>= 0` にする（対象が無くても検査する） | 既存の「投げる入力は増やさない」1本 |
| #1378 | 穴: `release.call(client, err ?? discardWith)` から `err` を落とす | 新しい歯1本（`expected 1 to be 0`、`totalCount`）。同じファイルの既存4本は緑のまま |
| #1378 | `discardWith` を落とす | **捕まらなかった**（下の「縛っていないもの」） |
| #1378 | やりすぎ: 常に `new Error` を渡して捨てる | 新しい歯1本（対照の `release()` で `totalCount` 0）と既存の「release は冪等」1本 |

## 外したもの

マネージャーの下調べによる。この PR の担い手は、次の3つを再検証していない【判断】。

- **#1335**: 「重複を除かずに保存」の約束が既に歯を持っているので、足さない。
- **#1308**: #1527 以降の main では、その穴を作る入力が作れない。
- **#1318 の InMemory の書きかけ**: 届かない等価変異。

## 縛っていないもの

- **#1378 の `discardWith` 側**: `release.call(client, err)`（`discardWith` を落とす）は、`transaction-rollback-error`・`transaction-begin-release`・`savepoint-rollback-error`・`drizzle-pool-proxy` の4ファイル（27本）がすべて緑のまま通った【実測】。`discardWith` は、`ROLLBACK` が失敗したあとに、その接続を捨てるための値である。いまのテストで `ROLLBACK` を失敗させる手は接続を切ることで、切れた接続は pg-pool が `_queryable` で捨てるので、`discardWith` が無くても結果が変わらない【判断。この機序は読んだだけで、別の手での再現はしていない】。生きた接続で `ROLLBACK` だけを失敗させる口が要るため、歯は足していない。
- 並行の2本・1回目が候補の一部だけを書いて止まる形は、[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md) が既に歯の外と書いている。
- #1318 の `reextract` 側（退けた記憶があれば飛ばす確認）は、既存の歯に任せ、この PR では変異を入れていない。

## これが覆るとしたら

ADR 0347 決定1（再配達は status を問わず「在る」に数える）・Issue #1229 の行3（Invalid Date の `at` でも、対象が無ければ空で返す）・ADR 0444（`begin` が落ちた接続は捨てる）の約束が変わるとき。
