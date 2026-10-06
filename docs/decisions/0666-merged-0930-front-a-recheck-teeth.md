# ADR 0666: 09/30 にマージされた PR の前半（A 群）の確かめ直しで見つかった穴に歯を足す（Issue #1734）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1734](https://github.com/takecchi/mnemora/issues/1734)（2026-09-30 マージ分の確かめ直し。PR ごとの結果はそのコメント）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【受】は自分で測らずに受け取ったもの、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・CHANGELOG・公開の適合テスト（`*-conformance.ts`）は触らない（[ADR 0663](./0663-merged-0923-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯

Issue #1734 の A 群のうち、結果がもうコメントされている10本（#1458・#1474・#1484・#1491・#1492・#1507・#1514・#1517・#1518・#1520）に、変異試験で「すり抜けた」と報告された変異が**31本**ある（#1458 が8、#1474 が2、#1484 が2、#1491 が2、#1492 が1、#1507 が2、#1514 が2、#1517 が1、#1518 が5、#1520 が6）。#1465 の歯は PR #1742 でマージ済みなので対象に含めない。

報告は main `48e297e6`〜`8c2b450c` で測られている。main はその後も動いている（この作業は `d645a1f6` から）。そこで、**すり抜けた変異をいまの main でもう一度当て**、いまも緑のものにだけ歯を足した。変異は `cp` で控えを取ってから1度に1つ当て、`cp` で戻して `cmp` で一致を確かめた。歯を足したものは、歯を入れた状態で「変異で赤・戻して緑」を実測した。環境は手元の Postgres 17（`C.UTF-8`、専用ポート）。

## 決定【判断】

1. **実装は変えない。**公開の適合テストにも足さない。歯は、パッケージに固有のテスト（core・testkit・postgres・bullmq・local-embedding の `__tests__`）に新しいファイルとして置く。
2. 31本のうち**26本に歯を足す**。**5本は、いまの main の歯で既に赤になる**ので足さない（下の表）。
3. 31本はどれも、報告のとおり約束の内の変異で、**約束の外・元と同じ働き（同値）・後の ADR で撤回／逆になった約束に当たるものは、この31本の中にはなかった**（約束が後の ADR で変わっていないかは、報告者の照合に加え、いまのコードの TSDoc と照らして確かめた。ADR の本文を全部読み直してはいない）。約束の外・同値・約束が逆になったものは、すり抜けの表の外の補足（「歯にしなかったもの」）にだけ在る。
4. 歯の種類は3つ。(a) 結果を見る歯、(b) 引数・発行した SQL を見る歯（`aggregateScope` の第3引数、`Client.prototype.query` を差し込んで集めた SQL の文面）、(c) 道具そのものに誤った入力を渡して落ちることを見る歯（`error-guards.ts`）。(b) は、結果では差が出ないもの（受け取る側がどちらも no-op にする、DB の照合順序が `C` 系で外しても同じ並びになる）にだけ使った。

## すり抜け1本ごとの扱い【実測】

「歯」は足した歯、「main」はいまの main の歯で塞がっているもの。赤の数は、その変異を当てたときに赤になった `it` の数。

| PR | 変異（報告の記号） | 扱い | 歯／塞いでいる main の歯 | 変異での赤の形 |
| --- | --- | --- | --- | --- |
| #1458 | core が除外の指定なしでも `aggregateScope` に `excludeProvenanceKinds` を常に渡す | 歯 | `core/.../recall-exclude-provenance-call-shape.test.ts` | 2（省略・空配列。「キーを足さない」） |
| #1458 | testkit が skip でも欄を返す | **main** | `testkit/.../in-memory-fixtures-aggregate-scope-exclude-provenance.test.ts` の skip の `it` | 1 |
| #1458 | testkit が archived の行も数える | 歯 | `testkit/.../in-memory-fixtures-aggregate-scope-exclude-provenance-scope.test.ts` | 1（3 が 2 でない） |
| #1458 | Fake が archived の行も数える | 歯 | `core/.../fake-aggregate-scope-exclude-provenance-scope.test.ts` | 1（3 が 2 でない） |
| #1458 | Postgres が FILTER から `has_qualifying_label` を外す | 歯 | `postgres/.../aggregate-scope-exclude-provenance-scope.postgres.test.ts` | 1（3 が 2 でない） |
| #1458 | D1: core が `totalInScope` から除外した行を引く | 歯 | 上の `recall-exclude-provenance-call-shape.test.ts` | 1（3 が 5 でない） |
| #1458 | D3a: Postgres が skip でも `excludedProvenanceIndexedCount: 0` を返す | **main** | `aggregate-scope-exclude-provenance.postgres.test.ts` の skip の `it`、`store-boundary-diff.postgres.test.ts` | 2 |
| #1458 | D3b: Postgres が skip でも集計 SQL を1本余計に撃つ | 歯 | 上の `aggregate-scope-exclude-provenance-scope.postgres.test.ts` | 2（SQL が0本のはずが1本。digestBand 付きで1本のはずが2本） |
| #1474 | F1: Fake の `link` が別テナントの記憶を端に取れる | 歯 | `core/.../fake-relation-link-endpoint-tenant.test.ts` | 2（from・to） |
| #1474 | F2: Fake の `link` が存在しない id を端に取れる（検査のループを空にする） | **main** | `fake-relation-link-kind-before-endpoints.test.ts` の陽性対照の `it` | 1。同じファイルの新しい歯も、存在しない id（uuid の形・形でない文字列、from・to）の表を持ち、同じ変異で6本赤になる |
| #1484 | P3: Postgres の `listActiveClaimPredicates` が同着の副キーを持たない | 歯 | `postgres/.../claim-predicates-tie-break.postgres.test.ts` | 3（同着300件が昇順でない・新旧の群の内側が昇順でない・`ORDER BY` の文面） |
| #1484 | P2: 同じ副キーから `COLLATE "C"` を外す | 歯 | 同上（`ORDER BY` の文面） | 1。**結果を見る歯は `C.UTF-8` の DB では緑のまま**（既存の7ファイル1062件も緑）。文面で縛った |
| #1491 | Z1: testkit の `peerDependencies` から `zod` を外す | 歯 | `testkit/.../zod-peer-dependency.test.ts` | 2（存在・core と同じ範囲） |
| #1491 | B6: bullmq が成功した tick の `'completed'` でも `onTickError` を呼ぶ | 歯 | `bullmq/.../tick-driver.non-failure-events.test.ts` | 1 |
| #1492 | R2: sync observe が `complete` の例外を全部握る | 歯 | `core/.../observe-sync-extract-complete-error.test.ts` | 2（接続断・`TypeError` を投げ直さない） |
| #1507 | C3: 名乗らない adapter で consolidate が `created: false` にも `created` を積む | 歯 | `core/.../created-event-claim-existing-row.test.ts` | 1 |
| #1507 | C4: 同じく reextract | **main** | `fake-runtime-tick-jobs-and-correction-reextract-parity.test.ts` | 1。（`if (created)` を `created \|\| !created` にして当てた＝常に積む） |
| #1514 | T1: `expectStoreError` が判定関数の結果を見ない | 歯 | `testkit/.../error-guards.test.ts` | 5 |
| #1514 | T2: `expectRejectsWithoutStoreError` が判定関数の結果を見ない | 歯 | 同上 | 1 |
| #1517 | K2: Postgres の `link` が kind の検査を uuid の形の検査の後ろへ動かす | 歯 | `postgres/.../relation-link-kind-before-malformed-ids.postgres.test.ts` | 3（from・to・両端が形でない） |
| #1518 | M4: `dispose()` を並行に呼ぶと上流を2回呼ぶ | 歯 | `local-embedding/.../dispose-concurrency.test.ts` | 2（M4 の `it` と、M8 の `it` が巻き込まれる） |
| #1518 | M6: 読み込みの最中に `dispose()` を呼び、その後の読み込みの失敗で `dispose()` が reject する | 歯 | 同上 | 1 |
| #1518 | M8: 上流の `dispose()` の reject を握りつぶす | 歯 | 同上 | 1 |
| #1518 | M9: `#disposed` を解放の完了後に立てる | 歯 | 同上 | 1 |
| #1518 | Lc1: testkit の `buildNewMemoryFixture` の既定 half-life を定数と違う値にする | **main** | `in-memory-fixtures-float4-underflow.test.ts`・`in-memory-fixtures-half-life-hours-float4-overflow.test.ts`・`readme-unbound-promises.test.ts` | 3。いまの main では既定の `720` を前提にする歯が増えていた（足そうとした歯は、足さずに捨てた） |
| #1520 | S2: Postgres の `aggregateScope` が `scope.subjectId` を断らない | 歯 | `postgres/.../identifier-well-formed-store-entries.postgres.test.ts` | 3 |
| #1520 | S3: Postgres の `listActiveClaimPredicates` が `query.subjectId` を断らない | 歯 | 同上 | 3 |
| #1520 | S4: Postgres の `createRecall` が `record.subjectId` を断らない | 歯 | 同上 | 3 |
| #1520 | IM1: InMemory の `createMemoryWithOutbox` が `input.subjectId` を断らない | 歯 | `testkit/.../in-memory-fixtures-identifier-well-formed-write-entries.test.ts` | 3 |
| #1520 | I7: `isMalformedIdentifierError` が `instanceof` だけになる | 歯 | `core/.../identifier-error-guard-and-stack.test.ts` | 2（別 realm の `kind` あり・`name` だけ） |
| #1520 | E2: `omitParamsFromError` が `stack` を書き換えない | 歯 | 同上 | 2（本体・`cause` の連鎖） |

**戻して緑**【実測】: 歯を足した26本すべてで、`cp` で戻して `cmp` で一致を確かめたあと、同じ歯を走らせ直して緑に戻った。

**同じ型の口は、報告に無くても同じ表で見た**（歯が1本のすり抜けだけを見る形になるのを避けるため。変異はそれぞれ当てて赤を確かめた）: Postgres の `findActiveByClaimKey`・`findContestedByClaimKey`・`createMemoryWithOutbox` の `subjectId`（各3赤）、InMemory の `createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の `news[].input.subjectId`（各3赤）。

**変異を当てる前（歯を足す前）に、いまの main の歯が緑だったことの測り方**【実測】: core の変異は core 全体（300本超のファイル、4500件超）、testkit の変異は testkit 全体（6300件超）、bullmq は Redis の要らない全ファイル、local-embedding は名指しの13ファイル、Postgres の変異は報告の歯のファイル（#1458 は5ファイル、#1520 は10ファイル、ほか各5〜7ファイル）で緑を確かめた。#1491 の Z1 は、`scripts/__tests__` のうち pack・publish・cjs の4ファイルも緑だった。

## 歯にしなかったもの

すり抜けの31本の外にある補足も、扱いを書いておく（再測定はしていない）。

- **#1484 C2・C3**（連想枠の `searchMany` へ渡す `limit` の値、アンカー1件のときの束ね方）: 報告が「すり抜けには数えていない」とした形の補足で、既存の Postgres の recall 系の歯が赤にしている。単体テストでの直接の縛りは足していない（重さ：低）【受】。
- **#1492 F1・F2**（Fake の claim 済みの行の `attempts`、Fake が job の複製を返すこと）: 同じく「すり抜けには数えていない」補足で、ADR 0555・0578 の歯が赤にしている【受】。
- **#1517 R2**（InMemory の `link` の kind の検査の位置）: 報告は「PR の歯ではなく別の歯が噛んだ」とした。今回の新しい歯（K2 の歯）は InMemory の fixture も同じ表で見るので、位置の入れ替えは、uuid の形でない端の入力でも縛られる。
- **#1520 E1・I4・I5**: 報告は「別の歯が噛んだ」とした【受】。
- **同値（元と同じ働き）**: #1518 M11（`dispose` を持たない extractor にも空の `dispose` が付く。呼んだ結果が同じ）、#1514 T3（`expectStoreError` が受けた例外を返さない。呼び出し側が戻り値を使っていない）。観測できる違いが無いので数えない。
- **約束が後の ADR で逆になったもの**: #1491 の F-3（recalls purge の EXPLAIN の歯。ADR 0412 が索引を足す向きに改めた）。当てていない。
- **公開の適合テスト（`*-conformance.ts`）への歯**: 決定1のとおり足さない。#1520 の store の口ごとの入口検査（S2〜S4・IM1）は、報告の「歯の案」が適合テストの表を挙げていたが、決定1に従い、store 固有のテストの表にした。**外部の adapter には、この口ごとの入口検査は届かない**（負債。下）。

## 引き受けた負債

- **P2・P3 の `ORDER BY` の文面の歯は、SQL を書き換えたときに赤になる**（偽陽性は、同じ意味で書き方を変えたとき）。結果で差が出ない変異を縛る代わりに払う。C でない照合順序の DB を CI の脚に足せば結果で見えるが、この PR では足していない。
- **#1520 の口ごとの入口検査は、Postgres と InMemory にしか効かない。**外部 adapter には、公開の適合テストに足さない限り届かない（足すかどうかは別の判断）。
- **core の Fake（`FakeMemoryStore`）の識別子の入口検査は、今回の対象に含めていない**（報告の変異が Postgres・InMemory の口だった）。

## 確かめていないこと

- #1491 B6 の歯は Redis の要らない fake の歯。実 Redis の歯（`tick-driver.failed.redis.test.ts`）は、この環境に Redis が無いので走らせていない（CI で走るかは PR の CI の結果を見ること）。
- #1484 P2 は、C でない照合順序の DB（ICU など）では測り直していない（文面の歯で縛った）。
- 約束が後の ADR で変わっていないことは、報告者の照合と、いまのコードの TSDoc で確かめた。ADR 0390・0398・0407・0416・0418・0419・0423・0329・0582 の本文を、この作業で全部読み直したわけではない。
- 報告に無い変異（31本の外）は探していない。
- ⛔ 2026-09-20〜09-26 にマージされた PR の確かめ直しは別の担当の受け持ちで、触っていない。
