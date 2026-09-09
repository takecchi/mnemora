# ADR 0079: 索引に載らなかった Memory を積み直す口を開ける — 「見えているのに直せない」を塞ぐ

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-09

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ」と「人から受け取った前提」を
混ぜない（[AGENTS.md](../../AGENTS.md)）。

---

## 文脈

### 診断は「静かに漏れる」ではない。**「見えているのに直せない」である**

この作業は「埋め込みの provider が落ちている間に入った記憶が、**静かに**検索から漏れる」
という見立てから始まった。**現物を読んだ結果、その見立ては崩れた。**

**`recall` は既に「索引されていない N 件」を正しく名乗っている。**
`packages/core/src/recall-runtime.ts`（現物、私が読んだ）:

```ts
for (const reason of NOT_INDEXED_REASONS) {
  const entry = aggregate.notIndexed[reason];
  if (entry.count > 0) {
    omitted.push({ kind: "not_indexed", reason, count: entry.count, countKind: entry.countKind });
  }
}
```

件数の元は `MemoryStore.aggregateScope` が SQL で数えている
（`packages/postgres/src/memory-store.ts`、`count(*) FILTER (WHERE ... embedding_status = 'failed')` ほか2本）。
そして **`runRecall` の本体に早期 `return` は1つも無い**（私が全 `return` を数えた。
関数本体の `return` は末尾の1つだけで、他はすべて helper と callback の中）
——**埋め込みの provider が落ちていて段1が飛んだときでも、この段は必ず走る。**

⟹ **「(A) そもそも記憶が無い」と「(B) 記憶は在るが索引されていない」は、いま区別が付く。**

**壊れているのはその先である。**[docs/recall.md](../recall.md) §4 の `not_indexed` の行は、
`reason` ごとに**利用側の次の一手まで**案内している（逐語）:

> **`reason` によって次の一手が分かれる**——`pending` は待つ・再試行する、
> `failed` は埋め込みパイプラインそのものを疑う、`skipped` は意図した除外なので
> 何もしなくてよい。

**現物では、この3つの一手のうち2つが実行できない。**

| 正典の案内 | 現物（私が読んだ） |
|---|---|
| `pending` は**待つ・再試行する** | ⛔ 再試行の口が無い。`Runtime` は `observe`/`tick`/`recall`/`reextract` の4口だけ |
| `failed` は**埋め込みパイプラインそのものを疑う** | ⛔ 疑って直せる。しかし**直した後に索引へ戻す口が無い**——`fail` は終端であり（`claimBatch` の `WHERE` に `failed_at IS NULL` が在る）、Phase 1 に自動リトライは無い（[ADR 0032](./0032-outbox-claim-lease.md)） |
| `skipped` は何もしなくてよい | — |

そのうえ **「どの記憶が索引されていないか」を列挙する口も無い。**`omitted` は件数しか返さず
（`Omission` に memoryId は載らない）、`MemoryStore` に `embedding_status` で引くメソッドは
無い（列挙口は `listBySourceObservation` の1つだけで、条件が違う）。
⟹ **1件ずつ再埋め込みする口を足しても、呼ぶ相手の id を得る手段が無い。**

**⟹ 診断はこうである（本 ADR が塞ぐもの）:**

> **埋め込みが落ちている間の記憶は、`recall` が「索引されていない N 件」と正しく名乗る。
> しかし正典が案内する次の一手（待つ・再試行する／パイプラインを直す）を実行する口が
> 公開 API に存在しないため、provider が直っても永久に索引へ戻らない。**

[AGENTS.md](../../AGENTS.md) は**「正典と実装が食い違ったら、バグなのは実装のほうである」**と
定めている。⟹ **直すのは実装である。この作業に「入れる価値が在るか」の議論は要らない。**

### `failed` に落ちる経路の数え方（現物）

**`embedding_status = 'failed'` を書く本番の呼び出し口は1本しか無い。**
`grep -rn --include=*.ts -F -- '"failed"'` の本番コードのヒットは
`packages/core/src/runtime.ts` の1行だけで、他はすべて型定義・適合テスト・doc コメントだった
（私が実行した）。`outbox.failed_at` を書く本番の呼び出し口も1本（`tick` の `catch`）。

**数えるべきは呼び出し口ではなく、そこへ到達する `throw` の地点である。**
`processEmbedJob` の中には `throw` が6地点あり、**そのうち2つは `try` の外に在る**:

| 地点 | outbox | `embedding_status` |
|---|---|---|
| `job.payload.memoryId` が文字列でない | `failed_at` | 対象を特定できない |
| `memoryStore.get` が**例外を投げる**（DB の一時障害） | `failed_at` | 🔴 **`pending` のまま残る** |
| memory が存在しない | `failed_at` | 行そのものが無い |
| `embeddingProvider.embed` が例外 | `failed_at` | `failed` |
| provider がベクトルを返さない | `failed_at` | `failed` |
| `vectorStore.upsert` が例外（**provider は健全でも落ちる**） | `failed_at` | `failed` |
| `setEmbeddingStatus(..., "ready")` が例外 | `failed_at` | `failed` |
| `catch` の中の `setEmbeddingStatus(..., "failed")` が**例外を投げる** | `failed_at` | 🔴 **`pending` のまま残る** |

🔴 **の2本が、この ADR がいちばん重く見ているものである。**
`failed` なら正典は「パイプラインを疑え」と案内する。**`pending` は「待て」と案内する**
——待っても永久に解けない行に対して、`recall` は「待て」と言い続ける。
**`failed` より悪い。**

> ### ⚠ 確かめていないこと（この節の位置づけ）
>
> **上の🔴2本は、コードの構造から読める「起こりうる」までである。**
> **発生を観測していない。**この環境には PostgreSQL も docker も無く（`which psql docker`
> がいずれも空、`DATABASE_URL` は未設定。私が実行した）、DB の一時障害を再現していない。
> **「観測した」と読まないこと。**

---

## 決定

**`MemoryStore.requeueEmbedJobs` と、それを素通しする `Runtime.reembed` を足す。**

- 対象は `status IN ('active','contested')` かつ `embeddingStatus` が `opts.statuses` の
  いずれかである Memory。**`aggregateScope` が `notIndexed` に数える集合と同じ条件**であり、
  `recall` が「N 件ある」と言ったものをそのままこの口へ渡せる。
- 選ばれた行は `embeddingStatus` を `'pending'` へ戻し、**同一トランザクションで**
  `kind: 'embed'` の outbox 行を新規に積む。
- **`opts.statuses` の型は `NotIndexedReason`**（`pending | failed | skipped`）である。
  `recall` が `{ kind: 'not_indexed', reason }` として名乗った値をそのまま渡せる形に固定し、
  **`ready` は指定できない**——`ready` は「ベクトル行が在る」という主張であり
  （[ADR 0053](./0053-set-embedding-status-does-not-roll-back-ready.md)）、`pending` へ戻すと
  `recall` が索引済みの Memory を `notIndexed.pending` に数え始める。
- **`statuses` にも `limit` にも既定値を置かない。**`ClaimOutboxJobsOptions.leaseMs`
  （ADR 0032）と同じ理由である——どちらも運用方針であり、`packages/core` が発明してよい
  値ではない。この口は1回の呼び出しで `memories` と `outbox` の両方へ書くので、
  既定値を置くとその影響範囲を core が黙って決めることになる。
- **`Runtime.reembed` は積み直すだけで、埋め込みそのものは行わない。**実際に埋め込むのは
  次の `tick()` である——「キューが無ければ黙って何も起きない」を作らない、という `tick` の
  設計方針をここでも崩さない。**呼んだだけでは索引は埋まらない。**

### 🔴 `fail` の終端性は変えない

**既に `failed_at` が付いた古い outbox 行には触らない。**積み直しは**新しい行**であり、
古い行は失敗の履歴として残る（新しい行の `attempts` は 0 から数え直される）。
⟹ **ADR 0032 の決定「Phase 1 では失敗したジョブの自動リトライを行わない」を覆さない。**
これは自動リトライではなく、**明示操作**である。

### `pending` も対象に取れる

上の🔴2本があるためである。**「待てば解ける」はずの `pending` に、待っても解けない行が
混ざりうる**なら、`pending` を積み直せない口は穴を残す。
⚠ **繰り返すが、この状況が実際に発生することは観測していない。**

---

## 採らなかった案

### 案B: outbox のリトライ（`fail` を非終端にする）— **いまは採らない。永久に採らない、ではない**

`fail()` で `available_at` を後ろへ進め、`attempts` が上限に達したときだけ `failed_at` を
付ける（dead-letter）。**列は `attempts` / `available_at` / `failed_at` がすべて既に在るので、
マイグレーションは要らない。**

**採らなかった理由は4つある。**

1. **ADR 0032 の明文の決定を覆す。**それ自体は ADR を書けば可能である。
2. 🔴 **backoff とリトライ上限を誰が決めるかが、`leaseMs` とまったく同じ形で出る。**
   ADR 0032 は `leaseMs` を「リース長は運用方針であり `packages/core` が決めてよい値ではない」
   として**既定値なしの必須引数**にした。同じ論法なら `maxAttempts` / `backoff` も
   `TickOptions` の必須引数になり、⟹ **公開 API の破壊的変更**になる。
   [docs/autonomy.md](../autonomy.md) §3 は「公開 API の破壊的変更は提起までにする。
   ADR を書き、実装は別 PR にして、承認を待つ」と定めている。
3. **本題を解かない。**provider が長く落ちていたケースは、リトライが `attempts` を焼き切って
   dead-letter になるだけで、結局「後から直す口」が別途要る。
4. **上の表の最初と3番目の地点（payload 不正・memory 欠落）は、何度リトライしても
   永遠に成功しない。**無駄に `attempts` を焼くだけである。

**⚠ 「いま採らない」であって「永久に採らない」ではない。**
本案が要るのは「積み直しを何度も自動でやりたい」場面である。**それが要ると分かってから
提起するほうが、決める材料が揃う**——いまは、自動リトライが要るほど失敗が頻発するのかを
測るデータが無い。**次に同じ問いに来た人は、この節から始めてよい。**

### 案C: 文書だけ直す（正典の「待つ・再試行する」を、実行できない約束だと書き換える）

**却下。**[AGENTS.md](../../AGENTS.md)「正典と実装が食い違ったら、**バグなのは実装のほうである**。
実装の都合で `docs/north-star.md` を書き換えないこと」に正面から反する。

### 案D: `Runtime.reembed(memoryId)` を1件ずつの口として足す（列挙口を足さない）

**却下。**呼ぶ相手の id を得る手段が無い（文脈の節の最後を参照）。
「口は在るが呼べない」になる。**列挙と積み直しを1つの口が兼ねる**ことで、別の口を足さずに
両方を塞いだ。

### 案E: `Omission { kind: 'not_indexed' }` に memoryId を載せる

**却下。**`Omission` は件数を返す型であり、そこへ id の配列を載せるのは公開 API の
破壊的変更である。加えて、`recall` の応答量は
[docs/recall.md](../recall.md) §6 の予算の対象であり、件数に比例して膨らむ欄を足すのは
その計測を壊す。

### 案F: `embedding_status` を索引キーに入れる（部分索引にしない）

**却下。ADR 0032 で一度実測した帰結がそのまま当たる。**`requeueEmbedJobs` は
`embedding_status = ANY(ARRAY['failed','pending'])` のように複数値を指定しうる。
キー列順を `(tenant_id, embedding_status, updated_at)` にすると、`embedding_status` を
等号1点に絞らない限り索引の並びは `updated_at` の全体順序を提供できず、
`ORDER BY updated_at ASC LIMIT n` の早期打ち切りが効かない。
⟹ `embedding_status` は**部分索引の述語**（`<> 'ready'`）で母数を削るのに使い、
具体的にどの値かは残った行への Filter に任せる。

---

## 引き受けた負債

### 1. 🔴 積み直しても provider がまだ壊れていれば、また `failed` が増える。**歯止めが無い**

この口は「もう一度やる」だけで、「何回までやる」を持たない。**呼び出し側が判断する。**
案B の `attempts` 上限が本来やる仕事であり、**それを入れないと決めたのが本 ADR である。**

⟹ **これが痛むとしたら**: 積み直しを cron などで自動化した利用者が、壊れたままの provider に
向かって無限に積み直し、outbox が膨らむ。**その形が実際に現れたら、案B を提起する材料になる。**

### 2. 🔴 `embedding_status <> 'ready'` の冗長な条件片が、SQL と migration の2箇所に書かれる

`requeueEmbedJobs` の `WHERE` にある `AND embedding_status <> 'ready'` は、その下の
`= ANY($n::text[])`（`statuses` の型が `NotIndexedReason` なので `ready` を含まない）から
**論理的には冗長**である。**それでも消せない**——`$n` は実行時の引数であり、
プランナは「その配列に 'ready' が入っていないこと」を証明できないため、部分索引
`idx_memories_requeue_embed` の述語がクエリの `WHERE` から含意されず、**索引が選ばれなくなる。**

⟹ **同じ条件がクエリ側と索引側の2箇所に書かれ、片方だけ直すとずれる。**
ADR 0053 が `EMBEDDING_STATUS_ROLLBACK` の比較について引き受けたのと同じ形の負債である。
**歯は置いた**（`packages/postgres/src/__tests__/memories-requeue-embed-index.test.ts` が、
この条件片を落とした述語では索引が使われないことを EXPLAIN で実測する）。

### 3. `MemoryStore` interface にメソッドが1つ増えた（adapter 実装者にとって破壊的）

`packages/postgres` 以外の `MemoryStore` を実装している利用者は、`requeueEmbedJobs` を
足さないとコンパイルが通らない。**`0.x` であり、[ADR 0031](./0031-supersede-status-and-event-in-one-transaction.md)
が `updateStatusWithEvent` を足したときと同じ形である**が、隠さずここに名乗らせる。
同じ理由で `MemoryStoreConformanceOptions` にも必須フックが1つ増えた（`claimEmbedJobs`）。
**省略可にしなかったのは、この repo が `prepareRecallId` / `listEventsForMemory` /
`prepareMemoryId`（ADR 0034 / 0047）で繰り返し決めてきた線をここでも守るため**——
省略できると「積み直しが本当に運ばれる adapter」と「戻しただけの adapter」が
同じ緑色の出力になる。

### 4. 索引の母数の想定を測っていない

`idx_memories_requeue_embed` が効くのは「大半の Memory が `ready` である」ときである。
**この想定は設計上のものであり、実運用の分布を測ったものではない。**
想定が外れて `ready` 以外が多数を占める系では、部分索引は母数を削れずプランナが
Seq Scan を選びうる。**その場合でも正しさは変わらない**（索引は速さの話である）。

### 5. `not_indexed.reason: 'skipped'` は、この口で受け取れるが本番では発生しない

`embeddingStatus` に `"skipped"` を書く本番コードはリポジトリに0件である（私が
`grep -rn --include=*.ts -F -- '"skipped"'` で数えた。ヒットは型定義・適合テストの
手組みフィクスチャ・ベンチのシード SQL のみ）。**この口が `skipped` を受け取れるのは
「`recall` が名乗る `reason` をそのまま渡せる」という設計を優先したからであり、
到達経路が在ると主張しているのではない。**
⚠ **`skipped` の空白そのものは本 PR の主題ではない。別に扱う。**

---

## これが覆るとしたら

- **`fail` を非終端にする決定がなされたとき**（案B）。そのときこの口は「自動リトライの
  取りこぼしを手で拾う」役へ意味が変わり、既定の `statuses` を持つべきかどうかを
  改めて問い直すことになる。
- **`recall` が `not_indexed` を件数ではなく id で返すようになったとき**（案E）。
  そのとき `requeueEmbedJobs` の列挙の役目は要らなくなり、`memoryIds` だけを取る
  素直な口へ縮められる。
- **`embedding_status` の値が増えたとき。**`NotIndexedReason` と `EmbeddingStatus` の
  包含関係が崩れると、`targetStatuses: readonly EmbeddingStatus[]` への受け直し
  （in-memory 実装と core の Fake の2箇所）が型検査で赤くなる。**そこが警報である。**

---

## 測ったこと

（コマンドと出力は PR 本文に貼る。この節はそこを指す。）

- 6つの門（`typecheck` / `lint` / `format:check` / `test` / `build` / `pack:check`）の終了コード
- 変異試験（置いた歯が実際に噛むこと・**噛まなかった変異**の両方）
- `EXPLAIN` による索引の実測

## 確かめていないこと

- 🔴 **上の表の🔴2本（`pending` のまま残る経路）が実際に発生することを観測していない。**
  コードの構造から読める「起こりうる」までである。
- **手元では DB テストを1本も走らせていない。**この環境に PostgreSQL も docker も無い
  （`which psql docker` が空、`DATABASE_URL` 未設定。私が実行した）。
  `packages/postgres` と適合スイートの postgres 側は **CI の3ジョブでしか見届けていない。**
  ⚠ 手元の `pnpm run test` が緑であることは、**DB 側を見たことにならない**（ADR 0015）。
- **実運用での `embedding_status` の分布を測っていない**（負債4）。
- **積み直しが「実際に想起の質を回復させるか」を測っていない。**この PR が測ったのは
  「索引へ戻る」までであり、北極星の物差し（`examples/chat` の `retrieval`）は動かしていない。
