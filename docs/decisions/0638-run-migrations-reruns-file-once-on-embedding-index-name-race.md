# ADR 0638: `runMigrations` は、`registerEmbeddingSpace` と索引名がぶつかって `23505` で落ちたファイルを、1回だけ流し直す（ADR 0464 の負債 D1b、逆向き）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

> **⚠ 出所**: オーナーへのまとめ問い 374f6f88 の問30（「全部推奨」）による。**オーナーが決めたのは、推奨の採否だけ**である。
> 推奨の中身（案 (b)。下の「検討した代替案」）はクローンと担い手が書いた。細部（接頭辞での絞り込み・ROLLBACK 成功の条件）は担い手の判断で、オーナーの判定ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> 出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。
> この ADR は [ADR 0464](./0464-register-embedding-space-absorbs-migration-index-race.md) の上に積んである。0464 の負債 D1b の行は書き換えない。

## 文脈

- 【現物】0464 の負債 D1b: `registerEmbeddingSpace` が `CREATE INDEX IF NOT EXISTS`（autocommit の1文）で埋め込み表の索引を作っている最中に、`runMigrations` が 0022（零ノルムの部分索引）または 0027（`memory_id` の索引）の DO ブロックで同じ名前の索引を作ろうとすると、register がコミットした時点で migration が `23505`（`pg_class_relname_nsp_index`）で落ちる。migration は1ファイル1トランザクションなので、ファイルごと巻き戻り、台帳に行は残らない。
- 【現物】2つの advisory lock のキーは別（`MIGRATION_LOCK_KEY` と `REGISTER_EMBEDDING_SPACE_LOCK_KEY`）なので、lock は守らない。順序は「register が名前を確保（未コミット）→ migration が同じ名前を入れようとして `transactionid` の `ShareLock` で待つ → register がコミット → migration が `23505`」。
- 【現物】0464 の実測（30万行で register と `runMigrations` を同時に撃つ）: migrate 側が 12 回中 3 回、別の 16 回でも 3 回落ちた。再現手順と 3 案 (a)〜(c) は 0464 に在る。**この ADR はその再現を引かず、決定的な代用で縛り直した**（下）。
- 【現物】確かめ直しの Issue（#1733・#1734・#1724）に、この競合の記録は見つからなかった【未確認: 本文と全コメントは読んでいない。#1733 の本文だけを読み、`registerEmbeddingSpace`・migration の語は無かった】。記録は 0464 に在る。

## 決めたこと

1. **`runMigrations` は、1つのファイルの適用（`BEGIN`〜`COMMIT`）が `23505`・`constraint = pg_class_relname_nsp_index`・`detail` が `Key (relname, relnamespace)=(idx_memory_embeddings_` で始まる、のときに限り、そのファイルを1回だけ流し直す。**
2. **流し直しは、そのファイルを頭（`BEGIN`）からやり直すだけ。** 1回目のトランザクションは `ROLLBACK` で台帳の行ごと巻き戻っている。**適用済みの別のファイルは流さない。** `applied` には成功した回の1回だけ入る。
3. **`ROLLBACK` が通ったときだけ流し直す。** `ROLLBACK` 自体が失敗した（接続が失われた等）なら、流し直さず元の失敗を投げる。
4. **流し直しは1回だけ。** 2回目も落ちたら、2回目のエラーを今までどおり `migration <file> failed: …`（`cause` 付き）に包んで投げる。握りつぶさない。
5. **ほかは今までどおり投げる**: 別の索引名の `23505`、別の制約の `23505`、別の SQLSTATE（`42P07` など）、権限・接続・タイムアウトのエラー。
6. **既存の migration ファイルは1バイトも変えない。** 0022・0027 の DO ブロックに `EXCEPTION WHEN unique_violation` は足さない（案 (c)）。公開 API・既定値・台帳の形は変えない。落ちる入力が減るだけである。`registerEmbeddingSpace` 側の吸収（0464）はそのまま残す。

## 流し直しで本当に収まる根拠

- 【現物】1回目に落ちた時点で、競合の相手（register の autocommit の索引作り）は**コミット済みである**。`23505` が出るのは、相手がコミットしたのを見てからだから。⟹ 2回目に migration の DO ブロックが `CREATE INDEX IF NOT EXISTS` を打つと、相手の索引は `pg_class` に見え、「既にある」で通る。0022・0027 の DO ブロックはどちらも `IF NOT EXISTS` で、冪等である。
- 【現物】0027 の先頭の8本は素の `CREATE INDEX`（`IF NOT EXISTS` 無し）だが、**1回目のトランザクションごと巻き戻っている**ので、2回目は同じ名前が無い状態から作り直す（8本が残って 2回目が `42P07` になることは、巻き戻りが効く限り無い）。
- 【実測】決定的な代用で、2回目が通ること・索引が1本・台帳に行が残ることを確かめた（下の歯）。
- 【判断】2回目にも落ちうる形は残る（別の空間の register が続けて同じ名前の別の索引を作る等）。そのときは 2回目のエラーが出る。無限には流し直さない（変異 (iii) の歯が縛る）。

## 検討した代替案

- **(a) `registerEmbeddingSpace` も `MIGRATION_LOCK_KEY` を取る**: 正方向・逆向きの両方を塞げるが、migration が長い間 lock を握ると register が `lockTimeoutMs` で落ちる入力が増える（新しい失敗）。0331 が避けた「無関係な待ち」も戻る。採らない（0464 と同じ理由）。
- **(c) 0022・0027 の DO ブロックに `EXCEPTION WHEN unique_violation` を足す**: 出荷済みの migration ファイルの中身を変える。別の PR（#1747）が migration の checksum を CI で固定しようとしている最中でもある。採らない。
- **名前の接頭辞で絞らず、`23505`＋`pg_class_relname_nsp_index` だけで流し直す**: 0022・0027 以外が将来作る別の索引の衝突まで 1回流し直す。2回目で同じ衝突が続けば投げるので害は小さいが、本物の重複（人が付けた同名の索引）を1回余計に流す。接頭辞 `idx_memory_embeddings_` で絞るほうが狭い（変異 (v) の歯が縛る）。【判断】
- **何度でも流し直す／どの例外でも流し直す**: 止まらない・本物のエラーを隠す。却下（変異 (i)(ii)(iii) の歯が縛る）。

## 引き受けた負債

| # | 内容 | 緊急度 | 直さなかった理由 | 覆る条件 |
| --- | --- | --- | --- | --- |
| D1 | 接頭辞 `idx_memory_embeddings_` で絞るので、0022・0027 が将来 `registerEmbeddingSpace` と無関係な名前を持つ索引を足し、それが同じ形で競合しても吸収されない | 低 | いま migration が作る `idx_memory_embeddings_*` はこの2本だけ【現物】 | 別の名前の索引で同じ競合の報告が来たとき |
| D2 | `detail` の文面（`Key (relname, relnamespace)=(…`）で照合する。ロケール（`lc_messages`）が変わると `detail` が訳されて照合が外れ、吸収されなくなりうる | 低 | 0464 と同じ前提。外れても今までどおり失敗するだけ | `lc_messages` を変えた環境での報告 |
| D3 | 流し直しの間、1回目の `ShareLock` 待ちと 2回目の索引作りで、ファイルの適用時間が最大で約2倍になる | 低 | 起きるのは競合した回だけ | — |

## これが覆るとしたら

1. 流し直しでも落ちる報告が来たとき（1回では足りない形が在る。無限には流し直さない）。
2. (a) を選び直すとき（register と migration を直列にするなら、この流し直しは不要になる）。
3. migration がほかの `registerEmbeddingSpace` の索引（HNSW など）も作るようになったとき（接頭辞は HNSW も含むが、0464 決定4の前提が崩れる）。

## 測ったこと

【実測】2026-10-06、Postgres 17（UTF8、`C.UTF-8`）、手元で `initdb` した専用インスタンス。

**歯**（先に書いて赤を見せた）:

- `migrate-vs-register-index-race.postgres.test.ts`（2本。0022 の零ノルム・0027 の `memory_id`）。別の接続で `BEGIN; CREATE INDEX IF NOT EXISTS <同じ名前> …`（register の代用）を未コミットで握り、`runMigrations`（その migration を未適用に戻した DB）が `pg_locks` の `transactionid` の待ちに入ったのを見てから COMMIT する。**決定的**（毎回再現）。`pg_locks` を読むので直列の群に入れた。
  - 直す前: 2本中 2本が赤（`rejected: 23505`）。直した後: 緑。
- `migrate-index-name-race-retry.postgres.test.ts`（7本）。走った回数を数えられる migration（sequence は rollback されない）で runner の線を縛る: 1回目が自分の索引名の `23505` で落ちたら 1回だけ流し直して通る／2回目も落ちたら 2回目のエラーを投げる（回数は 2）／別の索引名・別の制約・別の SQLSTATE は流し直さない（回数は 1）／適用済みのファイルは流さない／`applied` に同じファイルが2回入らない。
  - 直す前: 7本中 4本が赤（流し直す3本と「1回だけ」。「流し直さない」の3本は直す前から緑＝陰性対照）。

**変異**（`cp` で退避→変異→`cp` で戻す→`cmp` で一致を確認）:

| # | 変異 | 結果 |
| --- | --- | --- |
| (i) | 流し直しの回数の上限を外す（何回でも） | 「流し直しは1回だけ」が赤 |
| (ii) | 例外の種類を見ない（どの例外でも流し直す） | 「別の索引名」「別の制約」「別の SQLSTATE」の3本が赤 |
| (iii) | 上限を 3 回にする | 「流し直しは1回だけ」が赤 |
| (iv) | 2回目の失敗を握りつぶす（投げずに次のファイルへ進む） | 「流し直しは1回だけ」が赤 |
| (v) | 接頭辞の照合を外す（`Key (relname, relnamespace)=(` で始まれば吸収） | 「別の索引名」が赤 |
| (vi) | 流し直すときに `applied` へも積む（二重計上） | 「1回だけ流し直して通る」「適用済みは流さない」「applied に2回入らない」の3本が赤 |
| (vii) | 流し直しを外す（直す前の状態） | 6本が赤（上の「直す前」） |

**走らせたテスト**: 上の2ファイルのほか、`vector-space-migration-index-race.postgres.test.ts`、`create-index-race.test.ts`、`embedding-zero-norm-migration.postgres.test.ts`、`erase-tenant-fk-indexes.postgres.test.ts`、`migrate-concurrency.test.ts`、`migrate-connection-loss.test.ts`、`migrate-extension-lock.test.ts`、`dedicated-schema.postgres.test.ts`（10ファイル 50本が緑）。全テストは走らせていない。

## 測っていないこと

- 本物の文での再現率（30万行の表で `registerEmbeddingSpace` と `runMigrations` を同時に撃つ形）。0464 の実測はあるが、この ADR の直した後では撃ち直していない。決定的な代用で縛った。
- 「`ROLLBACK` が失敗したら流し直さない」の歯（接続断を作る必要があり、足していない。変異で外しても歯は赤くならない）。
- 別 schema（`options.schema`）で同時に呼ぶ形での、本物の競合。
- SQL_ASCII の DB と、`lc_messages` を変えた環境（負債 D2）。
