# ADR 0659: 09/29 マージ分の確かめ直し（ADR 0645・0646）の後始末——tick のコメントの言い回し・適合テストの穴・ADR 0390 の欄のすり抜け・ADR 0352 と書かれた誤りの訂正

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

クローンのマネージャー（mgr-0495eb46）の依頼で担い手が書いた。直すと決めたのも範囲もクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
[ADR 0645](./0645-merged-0929-recheck-teeth-a.md)（PR A）と [ADR 0646](./0646-merged-0929-recheck-teeth-b.md)（PR B）の確かめ直しが残した「直しが要りそうなもの」「縛っていないもの」のうち、小さく閉じられる3つを塞ぐ。実装の振る舞いは変えない。

## 経緯

ADR 0646 は、#1398 の確かめ直しで「`tick()` の対応していない kind の分岐の直前のコメントが紛らわしい」ことを、直しが要りそうなものとして残した。また #1455 と ADR 0390 の確かめ直し（Issue #1733 のコメント）では、次の2つの穴が見つかっていた。

- 適合テストの「skip は集計を発行しない」の歯は、`digestBand` なしでしか呼ばれない。
- testkit の InMemory は `scopeAggregate: "skip"` で `excludeProvenanceKinds` を渡しても `excludedProvenanceIndexedCount` の欄を足さない（ADR 0390）が、その約束を縛る歯が無い。

## 決定【判断】

1. **コメントだけを直す**（#1398）。コードは変えない。
2. **適合テストに1本足す**（#1455）。適合テストへ足してよいという許可がクローンから出ている。
3. **欄の歯を `__tests__` に足す**（ADR 0390）。実装は変えない。
4. **訂正を ADR に残す**。migration は触らない（下の「訂正」）。

### 1. コメントの言い回し（#1398）

置き場: `packages/core/src/runtime.ts` の `tick()`、対応していない kind の分岐の直前のコメント【現物】。

- 前: 「⚠ この分岐は provider を一切呼ばないため、abort の対象にしない（Issue #1200: 中断が効くのは provider を待っている間と呼ぶ前だけでよい）。」
- 後: 「⚠ この分岐は provider を一切呼ばないので、`signal` を渡す先も待つ相手も無い。ただし abort を無視するわけではない: abort 済みなら、ループ頭の確認（上）ですでに抜けていて、この分岐へは入らない（どのジョブも `fail()` しない。ADR 0359）。ここへ入るのは abort されていない間だけで、入ったあとの `fail()` は中断しない。」

食い違いの理由: ループ頭の `signal?.aborted` の確認がこの分岐より前に在り、abort 済みならこの分岐へ入らない【現物】。前のコメントは「abort の対象にしない」と読めて、abort 済みでもこの分岐が `fail()` を焼くように読めた。

### 2. 適合テストの穴（#1455）

置き場: `packages/testkit/src/memory-store-conformance.ts`、`countScopeAggregateQueries` を渡した adapter にだけ登録される歯の隣。`scopeAggregate: "skip"` に `digestBand` を付けても集計の問い合わせが0本であることを見る。あわせて、目次帯が実際に返っていること（`digests` が入れた記憶の id と等しい）も見る（帯を引かない実装が0本で通る偽陽性を防ぐ）。

数え方の確認【現物】: Postgres 側の `countScopeAggregateQueries`（`packages/postgres/src/__tests__/conformance.postgres.test.ts`）は、`pool.query` に渡る SQL の文面に `GROUP BY subject_id` を含むものだけを数える。skip + `digestBand` の目次帯の `SELECT id, digest ... LIMIT` は `GROUP BY` を持たないので数えられない。つまり帯の SELECT は数えず、集計（`agg` CTE）だけを数える形になっている。

### 3. ADR 0390 のすり抜け

置き場: `packages/testkit/src/__tests__/in-memory-fixtures-aggregate-scope-exclude-provenance.test.ts`（InMemory）と `packages/postgres/src/__tests__/aggregate-scope-exclude-provenance.postgres.test.ts`（Postgres）。`skip` + `excludeProvenanceKinds` では欄 `excludedProvenanceIndexedCount` が無い（`in` で見る）。対照として `exact` では欄が在り、値が2。

Postgres 側の実装【現物】: `skip` は集計に入る前の早い return を持ち、そこが欄を足さない。InMemory の `!skipCounting &&` に当たる条件は無く、同じ変異は作れない。代わりに、早い return へ欄を足す変異を当てた。

## 実測【実測】

PostgreSQL 17（`--encoding=UTF8 --locale=C.UTF-8`、自分専用のインスタンス、ポート 55484）。実装は `cp` で退避し、変異を1つ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめた。

| 変異                                                                                                            | 対象                                                            | 結果                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| InMemory の `!skipCounting &&` を外す                                                                           | `in-memory-fixtures-aggregate-scope-exclude-provenance.test.ts` | 足した1件が赤（他の2件は緑）。戻して3件緑                                                  |
| Postgres の skip の早い return へ `excludedProvenanceIndexedCount: 0` を足す（`excludeProvenanceKinds` 指定時） | `aggregate-scope-exclude-provenance.postgres.test.ts`           | 足した1件が赤（既存の4件は緑＝足す前はすり抜けた）。戻して5件緑                            |
| Postgres の skip + `digestBand` の分岐で `GROUP BY subject_id` の SELECT を余分に1本発行する                    | `conformance.postgres.test.ts`（全件）                          | 足した適合テストの1件だけが赤（683件中、1件赤・682件緑＝足す前はすり抜けた）。戻して全件緑 |

適合テストを変えたので、`in-memory-fixtures.conformance.test.ts`（全件、677件緑・1件は未検査の named it）と `conformance.postgres.test.ts`（全件、683件緑）を `-t` なしで走らせて緑を確かめた。

## 訂正【現物】

`packages/postgres/migrations/0024_tenant_subject_activity.sql` の冒頭コメントなどが「ADR 0352」と書いているのは、ADR 0353（[活動時計の数え方を、呼び出しごとの引数で選べるようにする](./0353-activity-counting-per-call.md)）の誤りである。ADR 0352 は連想枠・必須の同伴取得が返す `score` の話で、活動時計とは関係が無い。

`migrations` の中で「ADR 0352」と書いている箇所は `0024` の2行（3行目と17行目）で、`grep -rn "ADR 0352" packages/postgres/migrations` はほかに当たらない。

- 3行目: `-- Issue #338 / ADR 0352: 活動時計の数え方を、呼び出しごとの引数で選べるようにする。`
- 17行目: `-- （`activityCounting` が制御するのは前進（+1）の対象だけ。ADR 0352 参照）。`

出荷済みの migration は [ADR 0637](./0637-migration-checksums-pinned-and-0027-deadlock-not-fixable-by-new-migration.md)（#1747）で checksum が CI に固定されているので、migration のコメントは直さず、ここに記録する。`0024` を読む人は、「ADR 0352」を「ADR 0353」と読み替えること。

## 縛っていないもの

- 全テストは走らせていない。名指しのファイルと、適合テスト2本の全件だけである。
- 1 はコメントだけなので、歯は足していない（振る舞いは [ADR 0646](./0646-merged-0929-recheck-teeth-b.md) の #1398 の歯が縛っている）。

## これが覆るとしたら

abort 済みでもこの分岐が `fail()` を焼く設計へ変わるとき（ADR 0359）、`scopeAggregate: "skip"` が `excludedProvenanceIndexedCount` を返す設計へ変わるとき（ADR 0390）、migration の checksum の固定を外すとき（ADR 0637）。
