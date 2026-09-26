# ADR 0344: 公開済みの版で作った DB の fixture を置き、今の migration で上げる経路を必須ジョブで検査する（Issue #1038）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-27

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> 必須ジョブ（`packages/postgres`）に入れる判断と、下の条件1〜5は、クローン miku
> （オーナーではない）が決めた。

---

## 文脈

`packages/postgres` の歯は、どれも「新しく作った DB に今の migration を当てたもの」を前提に
していた。利用者は公開済みの版（例: v1.0.1）で作った DB を持ったまま更新する。新しい DB で
緑でも、その DB に migration を当てたときに失敗しない・既存の行の意味が変わらない、とは
言えない。

【実測】v1.0.1 のコードでデータを入れた DB に main の migration を当てたところ、
`0022_embedding_zero_norm_index.sql` が同じスキーマに置かれたビューへ `CREATE INDEX` を
発行して止まった（[Issue #1038](https://github.com/takecchi/mnemora/issues/1038)、
修正は PR #1043 / [ADR 0343](./0343-vector-store-search-returns-zero-norm-candidates.md) 追記）。
新しい DB に対する既存の歯は、どれもこれを見ていなかった。

## 決定

1. **公開済みの版ごとに、その版のコードで作った DB のプレーンテキストの SQL ダンプを
   `packages/postgres/src/__tests__/__fixtures__/upgrade-from-<tag>.sql` として置く。**
   gzip にしない（差分を読めるようにするため）。v1.0.1 の分は 約 225KB。
2. **fixture は `scripts/generate-upgrade-fixture.mjs` で作る。** その版の作業木のビルド済み
   `@mnemora/postgres` / `@mnemora/core` / `@mnemora/testkit` を読み込み、
   `DeterministicEmbeddingProvider` と `DeterministicLLMProvider` で合成データを入れる
   （外部 API は使わない）。何を入れたかは道具の冒頭に、どの tag・どの sha で作ったかは
   fixture の冒頭に書く。`pg_dump` は `--no-owner --no-privileges --inserts` で出し、psql 専用の
   メタコマンド行（`\restrict` など）を落とす（歯は node-pg で流すため）。
3. **歯 `upgrade-from-released.postgres.test.ts` は、fixture ごとに別の DB を作って復元し、
   `runMigrations` を2回当て、今のコードで代表的な読み書きを回す。** 見るのは、
   1回目が台帳に無い migration だけを当て2回目は何も当てないこと、記憶の行が変わらないこと、
   zero-norm 索引が重複しないこと、その版の recall 記録を読めること、残った embed ジョブの消化と
   observe → tick → recall、その版のゼロベクトルを search が返すこと、forget → purge、孤児の
   contested の解消。期待値は fixture から引き、migration 名や件数を焼かない。
4. **この歯は `packages/postgres` の必須ジョブで走る**（ファイル名が `*.postgres.test.ts` なので、
   既存の `test:db` に入る）。評価（想起の質）の門ではなく、バグを塞ぐ普通の回帰テストであり、
   【実測】所要は手元で vitest の Duration 3.5〜4.3 秒（UTF8 / SQL_ASCII の両クラスタ）。
5. **版を出したら fixture を1本足す**。手順は [docs/release-v1.md](../release-v1.md) §5.6。
   既存の fixture は消さない。

## 採らなかった案

- **CI で tag を checkout して、その場で古い版のコードからデータを作る。**
  `actions/checkout` は既定で tag を取らず、古い版の install・build も毎回要る。所要が
  数秒から数分へ膨らむ。記録として固定した fixture のほうが、何を当てたかも差分で読める。
- **今のコードで古い migration（`0001`〜`0021`）だけを当ててデータを入れる。**
  「その版のコードが書いた行」にならない（v1.0.1 の forget が残した孤児の contested のような、
  古いコードだけが作る行が入らない）。
- **gzip した fixture。** 小さくなる（約 37KB）が、差分を読めない。

## 引き受けた負債

- fixture のデータは合成であり、実運用の分布（件数・空間の数・本文の長さ）ではない。
  大きなテーブルでの migration の所要やロックの時間は、この歯では測っていない。
- 環境の形のうち、この歯が見るのは既定の public スキーマだけである。`--schema`・拡張機能を
  別スキーマに置いた構成・search_path を非 public にした構成は、Issue #1038 で手で1回当てた
  だけで、常設していない。
- fixture は `pg_dump` 17 で作った。CI の Postgres の版が上がっても読めるはずだが、
  下がると読めない可能性がある（確かめていない）。

## これが覆るとしたら

- fixture の本数が増えて CI の時間を圧迫したら、古い版の fixture を間引く（どの版から直接
  上げる経路を保証するかの判断が要る）。
- migration の形が変わり（例: 手書き migration をやめる）、ダンプの復元そのものが意味を
  失ったとき。
