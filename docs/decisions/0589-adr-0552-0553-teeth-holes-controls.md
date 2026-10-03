# ADR 0589: ADR 0553 の歯が通した閾値の頭打ち（TR2）と、ADR 0552 の歯が無かった runner の2つの振る舞い（P8・P9）を縛る

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンのマネージャー（mgr-9a36f2f4）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポート 55361 で。`C.UTF-8`）、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0580](./0580-adr-0568-nonexistent-id-and-event-get-controls.md) などの試験だけの PR と同じ）。

## 経緯【実測】

[ADR 0553](./0553-lexical-coverage-scale-across-stores.md)（PR #1663）と [ADR 0552](./0552-owner-q7-q8-q16-docs-only.md)（PR #1662）を変異試験で確かめ直したところ、次の3つが緑のまま通った（確かめ直しは前の担い手による）。

| # | 約束 | 変異 | 通った理由 |
|---|---|---|---|
| TR2 | `PostgresTrigramLexicalStore` の日本語側は、渡した閾値そのもので 0/1 を切る（0553） | 閾値を `LEAST(threshold, 0.9)` で頭打ちにする | 閾値の歯は 0.15・0.3・0.85・1 だけで、1 の歯は同じ文字列（`word_similarity` = 1）しか見ていなかった。0.9 と 1 の間に入る入力が無かった |
| P8 | `.sql` が1本も無いフォルダでも、専用スキーマ（と台帳）は作られる（0552 が副作用として書いた） | 0本のとき、最後に専用スキーマを `DROP` する | 空のフォルダの歯は `applied: []` と警告しか見ていなかった |
| P9 | `runMigrations` は `statement_timeout` を設定せず、接続側の値が本体の DDL に届く（0552） | ロックの後に `SET statement_timeout = 0` を挟む | `statement_timeout` を見る歯が無かった（README の実測は手で測ったもの） |

## 決定【判断】

1. 実装は変えない。3つとも実装は約束どおりで、歯が足りなかった。
2. 歯を3本足す（試験だけ）。
   - **TR2**: `packages/postgres/src/__tests__/lexical-coverage-scale-0553.postgres.test.ts` に「閾値が 0.9 と 1 の間でも、その値で切る」。閾値を 0.97 にし、漢字だけ 15 文字の項と、末尾に1文字足した本文（`word_similarity` = 15/16、PostgreSQL 17 で 0.9375）を当てる。日本語だけの本文は返らず、`alpha` を足した本文は ASCII 側の 1/3 で返る（日本語側の 1 にならない）ことを見る。同じ it の中で、その本文の `word_similarity` が 0.9 と 0.97 の間にあり、両側から 0.02 以上離れていることを前提検査として先に測る（版で揺れたら coverage より先にここが赤くなる。0553 の `MARGIN` の作法を、狭い帯に合わせて縮めた）。
   - **P8**: `packages/postgres/src/__tests__/migrate-dir-unreadable-empty.postgres.test.ts` に「`.sql` が1本も無くても、専用スキーマと台帳は作られて残る」。スキーマが在り、台帳が空で在ることを見る。
   - **P9**: `packages/postgres/src/__tests__/migrate-statement-timeout-not-set.postgres.test.ts`（新規）。接続の `options` で `statement_timeout=54321ms` を渡し、migration の本体の中で `current_setting('statement_timeout')` を表に残させて、その値が接続の値のままであることを見る。値を読むだけなので、timeout を起こすための待ちは要らない。接続の `options` が効いていることも前提として先に見る。

## 変異試験【実測】

実装ファイルを `cp` で退避し、変異を Edit で入れ、名指しのテストファイルだけを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。

| 歯 | 変異 | 赤 | 戻して |
|---|---|---|---|
| TR2 | `buildTrigramLexicalSearchSelect` の CASE を `>= LEAST(${opts.threshold}, 0.9)` にする | 1本赤（39本中。`alpha …一` の coverage が 1/3 でなく 1） | 39本緑 |
| TR2 | `search` の `const threshold = Math.min(this.threshold, 0.9)`（GUC と CASE の両方が頭打ち） | 1本赤（39本中。日本語だけの本文まで返る） | 39本緑 |
| P8 | `return` の前に、0本かつ `schema` 指定なら `DROP SCHEMA "<schema>" CASCADE` | 1本赤（4本中。スキーマが無い） | 4本緑 |
| P9 | `RESET lock_timeout` の直後に `SET statement_timeout = 0` | 1本赤（`v` が `54321ms` でなく `0`） | 1本緑 |

P9 の変異を `BEGIN` の中の `SET LOCAL` にした形は走らせていない。歯は本体の中で値を読むので同じく赤になるはずだが、確かめていない【判断・未確認】。

## 直さないもの

- CLI（`packages/postgres/src/bin/migrate.ts`）が `statement_timeout` を設定しないことは、この歯では縛っていない。CLI は `runMigrations` を呼ぶだけだが、CLI の側で `SET` を足す変異はこの歯を通る。
- 0552・0553 の確かめ直しで出たほかの変異には、この ADR では手を付けていない。

## これが覆るとしたら

trigram の閾値に上限を設ける（0.9 で頭打ちにする等）と決めたとき。空のフォルダでは何も作らないと決めたとき。runner が `statement_timeout` を自分で設定すると決めたとき（ADR 0552 の問8 の答えが変わったとき）。いずれもこの歯の期待値を一緒に直す。
