# ADR 0363: `describeJobFailure`（outbox の `lastError`）は drizzle の `params:` を落とし、長さに上限を掛ける（Issue #1064）

- **状態**: 採用 (2026-09-29)
- **日付**: 2026-09-29

> **⚠ この判定は、自動化された担い手（クローンのマネージャーのセッションから委譲された、
> クローン miku のさらに委譲先）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)・
> [ADR 0358](./0358-local-embedding-provider-splits-large-batches.md) の同種の注記と同じ——
> repo 上の署名だけではオーナー本人と区別が付かない。
> **この決定を担い手が自分で下してよい根拠は
> [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)** である。
> 方向そのものの変更が要るなら、オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0358 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で node/vitest/psql を走らせて確かめた。
- **推測** — 出所を明示していない考察・見立て。

---

## 文脈

[Issue #1064](https://github.com/takecchi/mnemora/issues/1064)【現物】: `tick()` がジョブの失敗を
outbox の `last_error` に記録するとき、`@mnemora/postgres` で DB への書き込みが失敗した場合、
drizzle が包んだエラー文（`Failed query: <SQL>\nparams: <値>`）をそのまま使う。**`params:` には
失敗したクエリに渡した値そのもの——Memory の本文などの利用者データ——が丸ごと入る。**
実測は1,490,781文字に達した例が Issue 本文に在る。

[Issue #969](https://github.com/takecchi/mnemora/issues/969)（クローズ済み）の決定により、
`describeJobFailure`（`packages/core/src/runtime.ts`）は「先頭の `message` は今までどおりそのまま
使う（drizzle が既に含めている params は、増やしも減らしもしない）」と明記していた。
**これはバグではなく意図した現状維持だった**——ただし、この判断自体に ADR は無く、TSDoc と
テストの doc コメントだけが記録していた【現物、`docs/decisions/` を `969`/`1064`/
`describeJobFailure` で grep して確認。専用の ADR は無かった（当時の最新は ADR 0358）】。

Issue #1064 のコメント2件目【現物】は、書き込み失敗以外の経路も指摘している:
`@mnemora/openai` の拒否の文面（`OpenAILLMProviderError`、[ADR 0075](./0075-openai-refusal-and-truncation.md)、
`packages/openai/src/errors.ts` の `defaultMessage`）が、モデルが引用した利用者の
本文をそのまま含み、`throwIfLlmFailed` 経由で `last_error` に届く経路である。`@mnemora/anthropic`
は拒否の分類（`category`）のみを持ち、文面を持たない（API 自体が返さない）。

**約束との緊張**: `OutboxJob.lastError` の TSDoc（[PR #1344](https://github.com/takecchi/mnemora/pull/1344)）
と `describeJobFailure` 自身のコメントは、pg エラーの `detail`（制約違反のキー値など）は
「利用者のデータが入りうるから載せない」と決めている。**同じ理由が、先頭の `message` に
入る drizzle の params（`detail` よりもさらに大きな利用者データ——本文そのもの）にも
当てはまる**——この2つの判断の釣り合いが、これまで明示的に決まっていなかった。

さらに、`forget()`/`purge()` で本文を消しても、`last_error` に同じ本文が残る
（outbox 行に purge/削除の仕組みが無いことは【実測】節で確認済み）。**正典
（`docs/north-star.md`）が約束する「忘却」と、消したはずの本文が別の場所（`last_error`）に
残り続けることは、正面からぶつかる。**

---

## 測ったこと

### 1. 既存の歯が今の main で成り立つこと【実測 2026-09-29】

`packages/postgres/src/__tests__/outbox-last-error-carries-body.postgres.test.ts`（PR #1346、
今回 `outbox-last-error-omits-params.postgres.test.ts` へ書き換えた）は、変更前の main
（`ca27946`）で緑だった。合成本文（`"あ".repeat(2000)` + NUL）を使った実測:
`last_error` の長さ5,892文字、`params:` は1,165文字目から出現、本文（合成の目印・繰り返し文字）が
削られずに残ることを確認した。

### 2. `describeJobFailure` が唯一の合流点であること【現物】

`tick()` が `outboxStore.fail()` を呼ぶのは2箇所だけ（`packages/core/src/runtime.ts`）:
1. 未対応の `job.kind`——`UNSUPPORTED_KIND_ERROR_PREFIX` だけを渡す。利用者データは載らない。
2. ハンドラ（extract/embed/consolidate/reflect）が例外を投げたとき——`describeJobFailure(err)`
   を渡す。**ここが唯一の「本文が載りうる」入口。**

drizzle 経由の書き込み失敗（写経路A）と openai 拒否の文面（写経路B、`throwIfLlmFailed` が
`detail = result.llmFailure?.message` を無加工で埋め込む）は、どちらもこの1箇所を通る。

### 3. 姉妹の問題を先に解いた実例が同じファイルに在ること【現物】

`describeDroppedCandidate`（Issue #1063、[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md)）は、
同じ「drizzle の外側の message に本文が載る」問題を、①外側の message を使わず cause の
最も内側だけを使う、②NUL・孤立サロゲートを見える形に変換、③`DROPPED_CANDIDATE_MESSAGE_MAX_CHARS
= 500` で切る、という形で既に解いている（出力先は `created` イベントの
`meta.droppedCandidates` で、`last_error` とは別）。

### 4. 主要な書き込み SQL の長さ【実測 2026-09-29】

`packages/postgres/src` の `sql\`...\`` ブロック（ソース上のテキスト、プレースホルダの式を
評価する前の長さ。実行時は `$1`/`$2` に短縮されるのでこれより短くなる）を機械的に数えた
（`node -e` で `sql\`([^\`]*)\`` を全ファイルから抽出）:

| 順位 | 長さ | ファイル | 内容 |
|---|---|---|---|
| 1 | 4339 | memory-store.ts | `WITH scoped AS (...)`（recall 候補選択の複合 CTE、読み取り専用） |
| 2 | 1938 | memory-store.ts | `INSERT INTO memories (...)`（`createMemoryWithOutbox`、書き込み最大） |
| 3 | 1868 | memory-store.ts | `INSERT INTO memories (...)`（別の書き込み経路、2箇所で同着） |

書き込み系（INSERT/UPDATE）で最大のものは1,938文字。実際の drizzle の失敗メッセージでも
（測ったこと1番）、`INSERT INTO memories` の SQL 文（params 抜き）は1,165文字だった
——ソースの静的長より短く、上の見積もりは安全側（余裕を持たせる側）に振れている。

### 5. pg の生エラーが値をメッセージに直接含む経路があること【実測 2026-09-29】

```
$ psql ... -c "SELECT 'ab-my-secret-body-xyz'::int;"
ERROR:  invalid input syntax for type integer: "ab-my-secret-body-xyz"
```
型変換の失敗は、値が `.detail` ではなく **`.message` に直接**入る。一方、一意制約違反は:
```
ERROR:  duplicate key value violates unique constraint "t_pkey"
DETAIL:  Key (id)=(1) already exists.
```
値は `.detail` 側であり、`describeJobFailure` は `.detail` を読まないので**この経路は
今のままで塞がっている**。⟹ **`params:` という目印を持たない経路（型変換失敗・openai の
拒否の文面）が、`omitDrizzleParams`（下記）だけでは塞がらないことを裏付ける。**

### 6. 変更後の歯が緑になること【実測 2026-09-29】

- `packages/postgres/src/__tests__/outbox-last-error-omits-params.postgres.test.ts`
  （本物の Postgres）: 1 passed。
- `packages/core/src/__tests__/tick-last-error-redacts-params.test.ts`
  （fixture、DB 無し）: 4 passed。
- 既存の `tick-last-error-cause.test.ts`・`tick-last-error-cause.postgres.test.ts`・
  `outbox-fail-nul-last-error.postgres.test.ts`・`embed-job-error-cause.test.ts`・
  `consolidate.test.ts`・`reflect.test.ts` は変更後も全て緑（回帰なし）。

---

## 決定

### 決定1. `describeJobFailure` の各段の `message` から、drizzle の `params:` 以降を落とす

`\nparams: ` という drizzle 固有の目印（`DrizzleQueryError` のメッセージ組み立て、
`node_modules/drizzle-orm/errors.js` 【現物】）が**最初に**現れた位置で切り、
`(omitted by mnemora, N chars)`（`N` は落とした文字数）に置き換える。**SQL の文そのもの
（`params:` の直前まで）は変えない**——テーブル名・列名・クエリの形は運用上の手がかりとして
残す。

**最初の出現で切る理由**: SQL の文の中に `params:` という文字列が偶然含まれることは
まず無いが、万一含まれていても、それは実際の params（値そのもの）より前には現れない
——drizzle は SQL 全体を書いた後に `\nparams: ` を1回だけ足す。⟹ 最初の出現で切る判断は、
実際の params の開始位置と一致するか、それより手前（＝より多く削る側）にしか倒れない。
**見落として本文を残す方向のずれは無い。**

**cause チェーンの全段に適用する理由**: `describeJobFailure` は各段の `message` を連結する。
drizzle のラップが cause の1段目とは限らない（トランザクション経由で入れ子になる可能性を
排除できない）ため、全段に一律で適用する——見つからなければ no-op（安全側）。

### 決定2. `describeJobFailure` の戻り値全体に長さの上限（4096文字）を掛ける

決定1だけでは塞がらない経路（openai の拒否の文面、pg の型変換エラーの生メッセージ）を、
長さの上限で抑える。上限を超えたら `sliceWithoutSplittingSurrogatePair`
（`packages/core/src/text-truncation.ts`、既存の共通部品——`truncateForFallbackDigest`・
`packDigestBand` と同じものを再利用）でサロゲートペアの内側を割らずに切り、末尾に
`… (truncated by mnemora, original length N chars)` という印を付ける。

**4096 を選んだ理由**（測ったこと4番）: 決定1で params を落とした後に残る本体は、
SQL の文（既知の最大の書き込みクエリでも2000文字強）＋ cause の連鎖（pg の生エラー・
SQLSTATE、数十〜百文字程度）＋ `" <- caused by: "` の連結である。4096は、既知の最大の
書き込みクエリを2倍近い余裕で収めながら、`params:` を持たない経路（openai の拒否の文面等、
上限が無い）の暴走を止める値として選んだ。

**500（`DROPPED_CANDIDATE_MESSAGE_MAX_CHARS`）に揃えなかった理由**: 500ではSQLの文
そのものが本体の途中で切れてしまい、`describeJobFailure` の狙い（SQL の形と cause の連鎖を
保つ——Issue #969 の decision そのもの）が壊れる。**`describeDroppedCandidate` とは
目的が違う**——`describeDroppedCandidate` は「候補を書けなかった理由の短い要約」を
`created` イベントの `meta` に残すためのものであり、SQL の形を保つ必要が無い（測ったこと
3番）。

### 決定3. 新しい定数はどちらも export しない（`DROPPED_CANDIDATE_MESSAGE_MAX_CHARS` の扱いに揃える）

`DESCRIBE_JOB_FAILURE_PARAMS_MARKER`・`DESCRIBE_JOB_FAILURE_MAX_CHARS` は、
`DROPPED_CANDIDATE_MESSAGE_MAX_CHARS`（`runtime.ts` 内で `export` されていない）と同じ扱いで
モジュール内定数のままとする。⟹ `pnpm run api:check`（[ADR 0178](./0178-public-api-surface-gate.md)）
は今回の変更で赤くならない——公開 API の型シグネチャは1バイトも変わらない。

### 決定4. openai の拒否の文面・pg の型変換エラーの値そのものは、今回は塞がない（長さの上限だけで抑える）

**理由**: これらは `params:` という共通の目印を持たず、経路ごとに個別の対応
（openai 側の `errors.ts` を直す・pg エラーを型ごとに判定する等）が要る——スコープが
`describeJobFailure` 1箇所の変更を超える。今回は Issue #1064 が指した最大の実測
（1.49MB、drizzle 経由）を塞ぐことを優先し、他の経路は長さの上限で「際限なく育たない」
ことだけを保証する。**塞がらない経路として明記し、残す。**

### 決定5. 既存行（過去に書き込まれた、本文入りの `last_error`）の掃除はしない

**理由**: 対象範囲・影響（行数・ロック・CAS との競合）の見積もりに、この PR の範囲を超える
検討が要る。判断材料（SQL の形の案・見積もり手順）は本 ADR の「これが覆るとしたら」と
実装 PR の報告に残し、実行はオーナー判断に委ねる。

---

## 採らなかった案

### (a) `describeDroppedCandidate` と同じ形（外側の message を捨て、内側の cause だけを使う）

**却下の理由**: `describeJobFailure` の目的（Issue #969）は「SQL の文の形と cause の連鎖の
両方を運用者に見せる」ことであり、外側を丸ごと捨てると Issue #969 が解決した問題
（DB 由来の失敗で理由が分からない）を一部再導入してしまう。params だけを削り、SQL の
形は残す方が Issue #969 と #1064 の両方の要求を満たす。

### (b) `PostgresOutboxStore.fail`（adapter 層）だけで対応する

**却下の理由**: openai の拒否の文面は adapter を経由しない（写経路B）。adapter 層だけの
対応では、この経路を塞げない。`describeJobFailure`（core、両経路の唯一の合流点）で
対応することで、1箇所の変更で両方をカバーできる。

### (c) 正規表現で `params:\s*.*$` のような全体一致パターンを使う

**却下の理由**: `indexOf` による最初の出現位置での単純な文字列分割の方が、正規表現の
バックトラックに伴う計算量の心配が無く、動作の説明もしやすい（決定1参照）。

---

## 引き受けた負債

1. 🔴 **openai の拒否の文面・pg の型変換エラーの値は、依然として `last_error` に丸ごと
   （長さの上限までは）載りうる**（決定4）。上限（4096文字）はあるので Issue #1064 の
   1.49MBのような極端な例は防げるが、数KB規模の利用者データが載ることはまだある。
2. **既存行の掃除をしていない**（決定5）——この変更より前に書き込まれた `last_error` は、
   本文を含んだまま残り続ける。
3. **4096という上限値は、この repo の現在の SQL の形からの見積もりであり、将来 SQL が
   大きく変わったら（例: より複雑な CTE が書き込み経路に増えたら）見直しが要る**——
   「これが覆るとしたら」参照。
4. **openai の refusal メッセージが `params:` を含む可能性を排除していない**——
   `omitDrizzleParams` は文字列 `"\nparams: "` の有無だけで判定するので、たまたま
   その文字列を含む拒否の文面があれば、そこだけ意図せず切られる（安全側のずれではあるが、
   意図した動作ではない）。

## これが覆るとしたら何が起きたときか

- **drizzle-orm が `DrizzleQueryError` のメッセージの組み立て方（`"Failed query: ...\nparams:
  ..."`）を変えたとき** ⟹ `omitDrizzleParams` の目印（`\nparams: `）が一致しなくなり、
  何も削れなくなる（安全側の劣化——「削らない」に戻るだけで、誤って余計に削ることは無い）。
  歯（`outbox-last-error-omits-params.postgres.test.ts`）が赤くなることで気づける。
- **書き込み系の SQL が、決定2で見積もった2000文字強を大きく超える複雑な文になったとき**
  ⟹ 4096という上限の余裕が失われ、SQL の形自体が切り詰められる可能性が出る。再測定と
  見直しが要る。
- **openai・anthropic 以外の LLM provider が追加され、`params:` を持たない別の形で
  利用者データを埋め込むメッセージを投げるようになったとき** ⟹ 決定4の「塞がらない経路」が
  増える。長さの上限は引き続き効くが、根本的な対応（決定4を再検討）が要る。
- **outbox 行の purge/削除の仕組みが新設されたとき** ⟹ 決定5（既存行の掃除をしない判断）を
  そのタイミングで見直す機会になる。

---

## 測ったこと・確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

上の「測ったこと」節に記載のとおり——既存の歯の実測、`describeJobFailure` の合流点の確認、
姉妹実装（`describeDroppedCandidate`）の確認、主要な書き込み SQL の長さの実測、pg の生エラーの
実測、変更後の歯（Postgres・fixture 両方）が緑になることの実測。

### 確かめていないこと

- openai・anthropic の HTTP エラー本文（SDK の例外）が実 API で利用者データを含むかどうか
  （`@mnemora/openai/src/errors.ts` 自身が「実 API では確かめていない」と明記している範囲を
  超える検証はしていない）。
- 既存行（本 PR より前に書き込まれた `last_error`）の実際の分布（件数・最大長）——
  実運用の DB に対する調査はしていない（決定5、掃除をしない理由の一部）。
- `maxBatchSize`（ADR 0358）のような、上限4096が実際の運用でどの程度の頻度で発動するかの
  実測——この変更を実運用へ入れてからでないと測れない。
