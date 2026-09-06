# ADR 0051: `setEmbeddingStatus` は `ready` を `failed` へ巻き戻さない——禁じるのは1本だけ

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## 前史: ADR 0048 が「特定できていない」と書き残した項目

[ADR 0048](./0048-reinforce-does-not-move-decay-origin-backwards.md) は
「読んでから書く」箇所を数えた台帳の中で、`setEmbeddingStatus` を
**「成立するが、到達する壊れ方を特定できていない」**と判定し、負債として残した
（「**『無い』ではなく『特定できていない』である。**」）。

**本 ADR は、その1件について到達経路を特定し、塞ぐ。**

## 到達経路

**出所: 私が読んだコード**（`packages/core/src/runtime.ts` の `processEmbedJob`、
`packages/postgres/src/memory-store.ts` の `aggregateScope`、
`docs/decisions/0032-outbox-claim-lease.md`）。**この器で実際に走らせて再現したものではない**
（下記「確かめていないこと」）。

1. `failed` を書く**唯一の**呼び出し口は `runtime.ts` の
   `catch (err) { await setEmbeddingStatus(ctx, memory.id, "failed"); throw err; }` である。
2. `ready` は `vectorStore.upsert` が**返った後**にしか書かれない。すなわち
   `embedding_status = 'ready'` は「**ベクトル行が在る**」という主張である。
3. outbox の処理は at-least-once であり（ADR 0032 が明記）、リースを失った古いワーカーも
   同じ Memory の `catch` に到達しうる。⟹ **`ready` が書かれた後に `failed` が届く順序が
   存在する。**
4. **ベクトル行を消す経路は今日のコードに無い**（`VectorStore` に削除の口が無い）。
   ⟹ いちど真になった「在る」は真のまま。
5. その結果、**ベクトル行が在るのに `memories.embedding_status = 'failed'` になる。**
   `aggregateScope` はこの行を `not_indexed_failed` に数え、`recall` は
   `notIndexed.failed` として返す ⟹ **利用者に「埋め込みを疑え」と出す。**
   疑うべき対象が実際には健全である、という誤った説明が出る。

**逆向き（`failed` → `ready`）は正しい。** B が後から成功した場合であり、
反映されなければならない。⟹ **規則は片側だけである。**

## 決めたこと

**現在の `embedding_status` が `ready` のときに `failed` を書く呼び出しは no-op とする。**
それ以外の遷移は今日どおり無条件。

- **例外にはしない。**唯一の呼び出し口が上記 `catch` の中であり、ここで投げると
  **元の埋め込みエラー `err` が握り潰されて別の例外にすり替わる。**呼び出し側の次の一手も
  無い（ADR 0048 が `reinforce` の古い `at` を例外にしなかったのと同じ理由の形。
  判定基準は [ADR 0008](./0008-absence-taxonomy.md) の「呼び出し側の次の一手が変わるか」）。
- **返すのは、更新されなかった現在の行そのもの。**`updatedAt` も動かない
  （「べき等」を「同じ値になる」ではなく**「行を触らない」**の意味で固定する）。

### 比較をどこに置くか

**Postgres 側は比較を SQL の1文の `WHERE` に置く**（ADR 0048 と同じ理由——アプリ側で
現在値を読んで比べてから書くと、読みと書きの間に入った別の書き込みを上書きしうる）。
条件片の組み立ては [ADR 0030](./0030-update-status-compare-and-swap.md) の
compare-and-swap と同じ形にする:

```sql
WITH updated AS (
  UPDATE memories
  SET embedding_status = ${status}, updated_at = now()
  WHERE tenant_id = ${tenantId} AND id = ${id}
    AND embedding_status <> 'ready'   -- status が 'failed' のときだけ付く条件片
  RETURNING *
)
SELECT * FROM updated
UNION ALL
SELECT * FROM memories
WHERE tenant_id = ${tenantId} AND id = ${id} AND NOT EXISTS (SELECT 1 FROM updated)
```

**書こうとしている値（引数 `status`）は*読んだ状態*ではないので JS 側で見てよい。**
`WHERE` に入れなければならないのは*読んだ状態*のほう（現在の `embedding_status`）だけである。

**更新できなかったときに返す行も、同じ1文の中で読む。**別の `SELECT` に分けると、
「上で読んだ古い値をそのまま返す」実装との差が**外から観測できない枝**になる
（ADR 0048 の `reinforce` で同じ形を採ったのと同じ理由）。

擬似物（`InMemoryMemoryStore`・`FakeMemoryStore`）は共有述語
`isEmbeddingStatusRollback`（`packages/core/src/interfaces/memory-store.ts`）を呼ぶ。
`assertValidEventRetentionDays`（[ADR 0050](./0050-tenant-event-retention.md)）と同じ形で、
**禁じる遷移を1箇所に固定する。**

## 採らなかった案

| 案 | 採らない理由 |
|---|---|
| **巻き戻しで例外を投げる** | 唯一の呼び出し口が `runtime.ts` の `catch` の中であり、**元の埋め込みエラー `err` を握り潰して別の例外にすり替える。**呼び出し側の次の一手も無い |
| **`updateStatus` と同じ `expectedStatus` 引数を足す**（ADR 0030 の形） | 呼び出し口は `runtime.ts` の2箇所しかなく、**そこが読んだ値は `processEmbedJob` 冒頭の `get()` 由来である**——リース切れの古いワーカーでは*その読みも同じく古い*。⟹ 引数に載せても解決しない。かつ `MemoryStore` interface の破壊的変更になる |
| **遷移表を全面的に固定する**（`pending`/`ready`/`failed`/`skipped` の全遷移に意味を与える） | `skipped` を含む全遷移の意味を今日決める根拠が無い。[ADR 0024](./0024-remove-exact-counts-option.md)「実装の無いものを『予約』と書き残さない」に反する。**禁じるのは、到達経路を特定できた1本だけ** |

## 引き受けた負債

- **SQL 側は共有述語を呼べず、比較の形が2箇所に書かれる。**値（`from`/`to`）だけを
  `EMBEDDING_STATUS_ROLLBACK` から共有し、比較そのものは SQL に再度書かれる。
  ⟹ **押さえは適合テストの歯だけである**（歯が両実装に走る）。歯を消せば二重化は野放しになる。
- **`OutboxStore.complete`/`fail` のフェンシングは、この ADR では塞がない。**
  同じ「リース切れの古いワーカー」から到達する**別の穴**であり、
  `outbox.completed_at` と `failed_at` が同じ行に両方 non-null で残りうる。
  ADR 0032 自身が「`complete`/`fail` の CAS 化は本 PR の範囲外」と自認している。
- **`ready → pending` の巻き戻しについては決めない。**再埋め込みの経路ができたときに要る
  判断だが、今日そもそも `pending` を書く呼び出し口が（作成時以外に）無い。
  「実装の無いものを予約と書き残さない」（ADR 0024）。

## これが覆るとしたら

- **ベクトル行を削除する経路ができたとき。**`ready` は「ベクトル行が在る」の主張として
  勝っている。削除できるようになると **`ready` は主張でなくなり、この非対称の根拠が消える。**
- **再埋め込みで `embedding_status` を `pending` へ戻す経路ができたとき。**
  そのとき「巻き戻し」の定義そのものを引き直す必要がある（`ready → pending` を
  許すのか、別の名前の操作にするのか）。

## 確かめていないこと

**出所の区別: 以下は私が確かめていない。**

- **この器には Postgres も pgvector も無い**（`docker`・`psql`・コンパイラのいずれも不在）。
  ⟹ **`PostgresMemoryStore` 側の実測は行っていない。**上記の SQL が意図どおり 0 行更新と
  読み戻しに分岐することは、CI の `postgres` job でしか確かめられない。
- ⟹ **「壊れ方を実際に走らせて再現した」とは書かない。**到達経路はコードと ADR 0032 の
  逐語から導いたものであり、ADR 0048 が `reinforce` について行ったような
  本物の Postgres での実測とは**証拠の強さが違う。**
- 擬似物（`InMemoryMemoryStore`・`FakeMemoryStore`）側は、適合スイートの歯が
  この器で実際に緑になることを確かめた。
