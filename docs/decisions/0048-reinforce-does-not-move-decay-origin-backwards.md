# ADR 0048: `reinforce` は減衰の起点を巻き戻さない——比較を DB の1文へ入れる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## まず数え直した: 「読んでから書く」は今日いくつ成立するか

**出所: 私が実行した**（`packages/postgres/src` の全 SQL 文を列挙し、書き口ごとに
「読んだ値が WHERE 句に入っているか」を読んだ。加えて本物の Postgres で実測した項目がある）。

**受け取った一覧（6件）に対して、成立するのは2件、うち壊れ方を実測できたのは1件だった。**

| 受け取った項目 | 判定 | 根拠 |
|---|---|---|
| `reinforce` | **成立する**（実測で赤） | 下記 |
| `setEmbeddingStatus` | **成立するが、到達する壊れ方を特定できていない** | 重複ジョブは at-least-once として明記されている。`content` は作成後に書き換わらない（`UPDATE` が1件も無い）ので、重複した埋め込みジョブは**同じベクトル**を書く |
| `claimBatch` の `claimed_at` 欠落 | **成立しない** | `claimBatch` は `SET claimed_at = ${opts.now}` を書いている。CTE も `FOR UPDATE SKIP LOCKED` と `claimed_at IS NULL OR claimed_at <= leaseExpiresBefore` で塞がっている（ADR 0032） |
| `complete` / `fail` | **決めてある** | `OutboxStore` の doc が「処理は at-least-once」「`complete`/`fail` は対象が既に完了/失敗していても例外を投げない（べき等な終端更新）」と逐語で書いている |
| supersede ループのトランザクション境界 | **決めてある** | `updateStatusWithEvent` の doc に「🔴 **買わない不変条件**」として明記（ADR 0031） |
| in-memory 実装 | 別担当（ADR 0047） | 触っていない |

**私が足した候補（本 ADR では直さない）:**

- **`createMemoryWithOutbox` / `createObservationWithOutbox` の読み戻しが 0 行を想定していない。**
  `ON CONFLICT ... DO NOTHING` が 0 行を返したあとの `SELECT` が空だと
  `rowToMemory(undefined)` になる。**到達性は測っていない**——READ COMMITTED の投機的挿入が
  相手のコミットを待つなら到達しない。**測っていないので「穴がある」とは書かない。**
- **`VectorStore.upsert` の last-writer-wins。**`content` が不変なので重複ジョブは同じベクトルを
  書く。⟹ 実害を特定できない。

### ⭐ 「決めた記述が無い」を主張する前の対照

**この repo は、この種の判断を明示的に書く repo である。**同種の判断が明示されている場所:

- [ADR 0030](./0030-update-status-compare-and-swap.md): `updateStatus` に `expectedStatus` の
  compare-and-swap を**足すと決めて**、`expectedStatus` を単数にした理由まで書いている。
- `updateStatusWithEvent` の doc: 買わないほうも「🔴 **買わない不変条件**」として書いている。

**⟹ `reinforce` の順序について何も書かれていないことは、「書き忘れた決定」ではなく抜けである、
と言える。**（`reinforce` の interface doc は「`last_reinforced_at`/`decay_floor_at` を更新する」
としか書いていない。`docs/memory-model.md` §7 の「単調」は「時間の経過そのものでは変化しない」の
意味であり、**書き込みが後ろへしか動かないとは書いていない**。）

## 測った: 何の値が壊れるのか

**出所: 本物の PostgreSQL 17.9 + pgvector に対して、実装を直す前に走らせた。**

| 撃ち方 | 実測（直す前） |
|---|---|
| 直列に `reinforce(48h)` → `reinforce(1h)` | `last_reinforced_at` が **1h へ戻った** |
| **本物の並行**（別々の `Pool` 4本、`at` は 1h/48h/12h/24h） | 行に残ったのは最新の 48h ではなく **12h**——最後に書いた者が勝つ |

**壊れる値は `decay_floor_at` である。**これは段1（索引が効く段）のゲートそのもの
（`decay_floor_at > now()`）であり、巻き戻ると**その Memory は候補集合から早く消える。**
使われた記憶ほど残るはずが、**使われたことを記録しようとして寿命を縮める。**

## 決めたこと

**比較を `WHERE` 句に入れる。**

```sql
UPDATE memories
SET last_reinforced_at = ${at}, decay_floor_at = ${decayFloorAt}, updated_at = now()
WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
  AND (last_reinforced_at IS NULL OR last_reinforced_at < ${at})
RETURNING *
```

0行だったときは「行が無い」ではなく「すでに同じか新しい起点が入っている」。
**そのときは行を読み直して返す**——上で読んだ値をそのまま返すと、読みと書きの間に入った
別の強化を見落とした古い値を返すことになる。読み直して 0 行なら、既存どおり
「memory not found」を投げる。

### 古い `at` を失敗にしない

**出所: 私の判断。**`updateStatus` の compare-and-swap（ADR 0030）は例外を投げるが、
ここは投げない。違いは**呼び出し側の次の一手が変わるか**である
（[ADR 0008](./0008-absence-taxonomy.md) の判定基準）:

- `updateStatus` の CAS 不一致は「置き換えようとした相手が別の状態だった」——次の一手が変わる。
- `reinforce` の古い `at` は「すでにもっと新しい強化が入っている」——**次の一手は無い。**
  例外にすると `runtime.observe` の使用報告ループが途中で止まり、**残りの Memory の強化が
  落ちる**という新しい壊れ方が増える。

## 採らなかった案

| 案 | 採らない理由 |
|---|---|
| **アプリ側で `memory.lastReinforcedAt` と `at` を比べて、書くかどうか決める** | **それがいま在る欠陥そのものである。**読みと書きの間に入った強化を上書きする |
| **古い `at` で例外を投げる**（`MemoryStatusConflictError` 相当） | 上記。呼び出し側の次の一手が無い |
| **`expectedLastReinforcedAt` の任意引数を足す**（ADR 0030 と同じ形） | 今日それを渡す呼び出し元が無い。[ADR 0024](./0024-remove-exact-counts-option.md)「実装の無いものを『予約』と書き残さない」に反する |
| **`decay_floor_at` の計算を SQL へ移して SELECT を消す** | 減衰の式は `packages/core` の純関数（`defaultDecayStrategy`）が持つ。SQL へ複写すると、**同じ式が2箇所になる**——[ADR 0038](./0038-vector-hit-distance-is-cosine.md) が測った「実装が2つあると食い違う」形をこちらから作りにいくことになる |

## 引き受けた負債

- **契約の本文（`MemoryStore` interface の doc）を更新していない。**
  そのファイルは私の作業範囲の外に置かれている。⟹ **今日の状態は「本物のアダプタだけが
  巻き戻さない」であり、契約はそれを要求していない。**
- **`InMemoryMemoryStore` は巻き戻す。**本 PR で Postgres 側だけを直したので、
  **2つの実装が食い違う状態を新しく作った。**これは ADR 0047（in-memory を本物に揃える）の
  範囲であり、そちらへ回すべき差である。**適合テストはこの点を見ていない**——
  見ていないので、食い違っても赤くならない。
- **`setEmbeddingStatus` は残っている。**成立はするが、到達する壊れ方を特定できていない。
  **「無い」ではなく「特定できていない」である。**

## これが覆るとしたら

- **`strength` / `half_life_hours` / `recorded_at` を作成後に書き換える経路が入る**とき。
  今日それらは `INSERT` でしか書かれない（数えた）ので、`reinforce` の冒頭の `SELECT` が
  古くなることは無い。書き換える経路が入ると、**この ADR が塞いだのとは別の穴が開く。**
- **「強化」が起点を前へ動かすこともある、と決まる**とき（例: 誤って強化したものを取り消す）。
  ⟹ その操作は `reinforce` ではない別の名前を持つべきである、というのが本 ADR の立場。
