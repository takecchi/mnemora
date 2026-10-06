# ADR 0621: 09/30 にマージされた #1465（活動時計の書き込みが記憶自身の subject の時計を使う）の確かめ直しで見つかった穴に歯を足す（書く側の相関サブクエリのテナントの絞り）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1734](https://github.com/takecchi/mnemora/issues/1734) の #1465 のコメント（前の担当の確かめ直しの結果を写したもの）。そこで見つかった重さ「高」の2本（#40・#48）だけをこの PR で塞ぐ。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】はマネージャーの判定。
これは試験だけの変更で、実装・migration・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0614](./0614-merged-0927-postgres-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯

#1465（[ADR 0394](./0394-activity-clock-writes-use-memorys-own-subject.md)）は、`ReinforceOptions.addOwnSubjectSeq: true` のとき、Postgres の `reinforce`・`reinforceMany`（`recordUsageAndReinforce` を含む）が、行ごとに `S_x`（その行の subject の `tenant_subject_activity.activity_seq`）を相関サブクエリで引いて足すようにした【現物】。サブクエリは `packages/postgres/src/activity-decay-sql.ts` の `subjectActivitySeqOrZero` で、`sa.tenant_id = <行のテナント>` で絞る。
確かめ直しで、この絞りを外す変異（`sa.tenant_id` 自身との比較にする）がどの歯にも捕まらなかった。テナントの絞りを見ている歯は、読む側（`activity-subject-counter-tenant-qualification`）にしかなかった。

## 決定【判断】

1. 実装は変えない。
2. 歯を足す。今の main で緑、穴の変異で赤、`cp` で戻して `cmp` で一致させた後に緑、を実測した【実測。自分専用の PostgreSQL 17 + pgvector、`C.UTF-8`】。

| 変異 | 足した歯 | 置き場 | 赤の形 |
| --- | --- | --- | --- |
| #40：`reinforce` の `tenantIdExpr` を `sa.tenant_id` にする（絞りが恒真になる） | 3つの口（`reinforce`・`reinforceMany`・`recordUsageAndReinforce`）を `it.each` で回す。2つの形: (a) 2つのテナントに同じ subject id・別々の `S_x` のカウンタ行があるとき、各テナントの起点・床が自分の `T + S_x`、(b) カウンタ行が別のテナントにだけあるとき、自分のテナントの起点・床が `T` のみ | `packages/postgres/src/__tests__/activity-clock-own-subject-tenant.postgres.test.ts`（新規） | (a) は例外（`more than one row returned by a subquery used as an expression`、SQLSTATE 21000）、(b) は値が違う（起点 17 が期待 10 のところ） |
| #48：`reinforceMany` の同じ箇所を同様に外す | 同上（`reinforceMany` と `recordUsageAndReinforce` が同じ文を通る） | 同上 | 同上の2つの形。`reinforce` の2件は緑のまま |

`recordUsageAndReinforce` は `reinforceMany` の本体を呼ぶので、#48 の変異はその2つの口を同時に赤にする。#40 は `reinforce` の2件だけを赤にする。
