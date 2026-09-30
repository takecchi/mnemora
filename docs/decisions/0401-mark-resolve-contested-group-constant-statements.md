# ADR 0401: `markContestedGroup` / `resolveContestedGroup` の関係の行の INSERT を実表の N² 結合にせず、メンバーごとの UPDATE / events INSERT を定数個の文にまとめる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30
- **PR**: Draft（[Issue #1449](https://github.com/takecchi/mnemora/issues/1449) 1-A の遅さのうち案D・案E。`Refs`、閉じない）

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**
> 案D・案E を入れると決めたのはマネージャー（クローンの委譲元）であり、オーナー本人の確認は取っていない。

---

## 問い

[ADR 0381](./0381-contested-group-write-path-implementation.md) の `markContestedGroup` / `resolveContestedGroup`
（`packages/postgres/src/memory-store.ts`）は、群の大きさ N に対して **遅さが N より速く伸びる**。
Issue #1449 の 1-A の測定が見つけた原因は2つ。

- **案D**: 関係の行の INSERT が `FROM memories a JOIN memories b ON ... WHERE a.id = ANY(ids)` で、
  N² の組を Nested Loop で評価し、b 側は組ごとに実表の Bitmap Heap Scan だった。
- **案E**: メンバーごとに UPDATE と events の INSERT を1本ずつ撃ち、文の数が、store 内で mark は 2N+4、resolve は 2N+5（BEGIN/COMMIT を含む）だった。

## 決めたこと

### 決定1（案D）. 関係の行の INSERT は、対象の memories を `MATERIALIZED` の CTE で1回だけ読み、その N 行どうしを結合する

```sql
WITH m AS MATERIALIZED (
  SELECT id, valid_from, valid_until FROM memories
  WHERE tenant_id = $1 AND id = ANY($2::uuid[])
)
INSERT INTO memory_relations (...)
SELECT gen_random_uuid(), $1, a.id, b.id, 'contradicts'
FROM m a JOIN m b
  ON b.id <> a.id
 AND (a.valid_from IS NULL OR b.valid_until IS NULL OR a.valid_from < b.valid_until)
 AND (b.valid_from IS NULL OR a.valid_until IS NULL OR b.valid_from < a.valid_until)
ON CONFLICT (tenant_id, from_memory_id, to_memory_id, kind) DO NOTHING
```

- **述語は1文字も変えていない**（半開区間の式、`timestamptz` のマイクロ秒精度の比較、`b.id <> a.id`）。
  作る行の集合は、旧 SQL の `SELECT` 部分と同じ入力に対して同じ（歯は下）。
  外した `b.tenant_id = a.tenant_id` と `a.tenant_id = $1` は、CTE が `tenant_id = $1` で絞っているので冗長になった。
- **「ハッシュ結合にする」は採れなかった。** 結合条件が不等式（区間の重なり）だけで、等値のキーが無い。
  N² の組の**評価**は残る（メモリ上の N 行どうしの比較）。減ったのは、組ごとの実表の引き（heap fetch）である。
- 範囲型（`tstzrange(...) && tstzrange(...)`）への置き換えは採らない。旧述語は `valid_from >= valid_until`
  の行（空・逆転した区間）に対しても値を返すが、範囲型は `lower > upper` で例外になる。**集合が変わりうる。**

### 決定2（案E）. UPDATE と events の INSERT を、メンバー数に依らない文にする

- **mark の UPDATE**: SET も WHERE の3条件も全員で同じ式なので、`WHERE id = ANY(ids) AND (...)` の1文にする。
- **resolve の UPDATE**: メンバーごとに `status` と `supersededById` が違うので、`UPDATE ... FROM unnest(ids, statuses, supersededByIds)`
  の1文にする。`COALESCE(v.superseded_by_id, t.superseded_by_id)` は同じ式のまま。
- **events の INSERT**: 1つの JSON 配列を `jsonb_to_recordset` で開く1文にする（`insertMemoryEventsBatch`）。
  行 id は JS 側（`randomUUID`）で採番し、`RETURNING` の順序に依存せず id で入力順へ戻す。
- **`RETURNING` の順序に依存しない。** UPDATE の結果は id を鍵にした Map に入れ、返り値の `members` は `ids`（入力順）で組み直す。
  返り値の `events` も入力順。

### 決定3. `MemoryStatusConflictError` の id と、エラーの種類・順序は変えない

- 条件を確かめる先行チェック（`SELECT ... FOR UPDATE` の後の、入力順の `for (const id of ids)`）は**触っていない**。
  複数のメンバーが条件を外れているとき、投げるのは**入力順で最初**の id である（uuid 昇順ではない）。
- UPDATE が期待より少ない行数しか返さなかったとき（`FOR UPDATE` の後なので通常は来ない、防御的な経路）は、
  旧実装が「入力順に1件ずつ打って最初に0行だった id」を名指ししたのと同じ id
  （`ids.find((id) => !updatedById.has(id))`）で、`conflictAfterEmptyUpdate` が旧実装と同じエラー
  （`MemoryStatusConflictError`、または memory が消えていれば `memory not found`）を作る。

## 【現物】変更前の形

- 関係の行の INSERT は実表 `memories a` × `memories b` の結合だった（`git show origin/main:packages/postgres/src/memory-store.ts`
  の `markContestedGroup`）。
- mark は `UPDATE` × N + events `INSERT` × N、resolve は `UPDATE` × N + events `INSERT` × N（それぞれ `for` ループの中で `await tx.execute`）。

## 【実測】前後（2026-09-30、PostgreSQL 17、自分専用のインスタンス、`bench` DB）

**やり方**: 前（origin/main の実装 + 歯だけの commit `d959d1d`、別 worktree）と後（本枝）を、**同じ DB（`bench`、測定用の群が入った 9.3GB）・同じ
`bench-1449` の道具（未追跡、commit していない）・同じ回数（既定の8回、N≥1000 は4回、完全1000 の mark/resolve は3回。いずれも捨てる1回の助走の後）**で、
前→後を交互に、鎖1000と完全100は3往復、完全1000は2往復。値は往復ごとの中央値の中央値（かっこは往復間の最小〜最大）。p95 は往復間の最大。
「文」は `pg` の `Client.query` を数えた（BEGIN/COMMIT を含む）。resolve と detect の文の数には、runtime 側が撃つ `listRelated`（N 回）が含まれ、この PR は触っていない。

| 対象 | 群 | 前 中央値 ms | 前 p95 | 前 文 | 後 中央値 ms | 後 p95 | 後 文 |
|---|---|---|---|---|---|---|---|
| mark | 鎖1000 | 2806（2631〜2806） | 3033 | 2005 | **321**（275〜349） | 511 | 7 |
| mark | 完全100 | 607（607〜610） | 1002 | 205 | **500**（437〜539） | 1587 | 7 |
| mark | 完全1000 | 56234 / 61772 | 71432 | 2005 | 56011 / 58464 | 61828 | 7 |
| resolve | 鎖1000 | 1724（1620〜1734） | 1978 | 3006 | **568**（480〜570） | 865 | 1008 |
| resolve | 完全100 | 251（233〜261） | 312 | 306 | **129**（109〜149） | 178 | 108 |
| resolve | 完全1000 | 6593 / 7160 | 7950 | 3006 | **4338 / 4711** | 5236 | 1008 |
| detect | 鎖1000 | 5129（4955〜5150） | 6405 | 3034 | **2770**（2605〜2780） | 3099 | 1026 |
| detect | 完全100 | 420（416〜522） | 563 | 345 | **238**（205〜244） | 435 | 129 |
| detect | 完全1000 | 14886 / 15086 | 15804 | 3033 | **13168 / 13206** | 14316 | 1025 |

- resolve の `store` 内だけ（runtime の `listRelated` を除く）: 鎖1000 は 1360 → 113 ms、完全100 は 170 → 33 ms、完全1000 は 4230/4392 → 1911/1864 ms。
  store 内の文の数（BEGIN/COMMIT を含む）は、mark が 2N+4 → 6、resolve が 2N+5 → 7。表の「文」はこれに runtime の `getMany` 1（と resolve・detect では `listRelated` × N など）が加わった全体の数。
- **前回（1-A）の数値との比較**: mark 鎖1000 = 2720（今回の前 2806）、完全100 = 399（今回 607）、完全1000 = 33240（今回 56〜62 秒）、
  resolve 鎖1000 = 1946（1724）、完全100 = 229（251）、完全1000 = 5551（6593/7160）、detect 鎖1000 = 5392（5129）、完全100 = 674（420）、完全1000 = 18349（14886/15086）。
  **器の負荷が違う**（今回は load average が 16〜60 で、他の担当の負荷と重なった）。**絶対値ではなく、同じ往復の前後の比を読むこと。**
  完全100・完全1000 の mark が前回より遅いのは、`bench` DB に前回の測定の行が積み上がった状態（`memory_relations` が約2000万行）でも測ったためで、
  原因の切り分けはしていない【確かめていない】。
- **⚠ ノイズの実例**: 同じ道具の別の往復で、完全100 の mark が前 4125 ms・7165 ms、後 4712〜4764 ms の回があった（`store` の INSERT に時間が出ていた）。
  `memory_relations` の autovacuum と時期が重なったためと推測している【推論。`pg_stat_user_tables` の `last_autovacuum` が近い時刻だったことだけを見た】。
  静かな往復（上の表）ではこの外れ値は出なかった。**表は、前後を交互に測った静かな往復を採っている**（外れ値の回を除いた根拠は「前後とも同じ時期に出た」ことだけで、除いた回の数字はここに写していない）。

### 読み取れること

- **鎖1000 の mark は約 9 倍（2806 → 321 ms）。** 効いたのは、組ごとの実表の引きの消滅（案D）と、文の数（2005 → 7、案E）の両方。
  内訳の分離（案Dだけ・案Eだけ）は測っていない【確かめていない】。
- **resolve は約 1.9〜3 倍。** store 内は 1360 → 113 ms だが、runtime の `listRelated` × N（鎖1000 で約 300〜400 ms、完全1000 で約 2.1〜2.5 秒）が
  この PR の外に残り、全体の下限になる。
- **完全1000 の mark には、差が出ていない**（56 秒 vs 56〜58 秒）。この形は**作る行が 999,000 行**で、時間の大半はその INSERT
  （3本の索引と2本の外部キーの検査）に使われていると推測する【推論。プロファイルは取っていない】。結合の側は N 行×N 行のメモリ上の比較であり、
  行の集合を減らさない限り出力は減らない。**完全グラフを作る限り、ここは下がらない。**
- **detect（`observe` 経由）の完全1000 は 15 → 13 秒に留まる。** `markContestedGroup` が受け取る events の `meta` が、群の全メンバーの id を載せる
  約 40KB の JSON であり（`pg_column_size` で 40,510 bytes を実測、鎖1000 の detect 1回で約 1005 行）、events の INSERT だけで数秒かかる。
  この PR は行の数を減らしただけで、`meta` の大きさは変えていない。
- **途中の版の実測（採らなかった形）**: events を列ごとの `text[]`（JSON 文字列）+ `::jsonb` キャストで1文にした最初の版は、
  detect 完全1000 で **前 15.6〜15.8 秒に対し後 20〜22.9 秒**（3往復すべて）と**遅くなった**。`meta` の二重のエスケープと二重の構文解析が効いたと見ている【推論】。
  1つの JSON 配列を `jsonb_to_recordset` で開く形に直し、上の表（13.2 秒）になった。**この失敗は、測ったから見つかった**——文の数の歯だけでは見えない。

## 歯（先に書いた。赤→緑）

すべて `packages/postgres/src/__tests__/` にある。歯は commit `d959d1d`（実装より前）。

| 歯 | 何を縛るか | 実装前 | 実装後 |
|---|---|---|---|
| `mark-resolve-contested-group-statement-count.postgres.test.ts` | mark / resolve の store 内の文の数が N=3/10/30 で等しい | **赤**（mark 10,24,64 本、resolve 11,25,65 本。別 worktree で実測） | 緑 |
| `mark-contested-group-relation-set-equivalence.postgres.test.ts` | 関係の行の集合が、旧 SQL の `SELECT`（参照実装として歯の中に持つ）・有効期間からの JS（BigInt マイクロ秒）での計算と一致。鎖・星・完全・乱数5種（null・境目ちょうど・1マイクロ秒のずれ）、冪等、群の外・別テナント | 緑（既存の振る舞いの固定） | 緑 |
| `contested-group-conflict-id.postgres.test.ts` | `MemoryStatusConflictError` の id（入力順で最初、uuid 昇順ではない）、`memory not found` の id、成功時の `members`/`events` が入力順、resolve の status・`supersededById`・COALESCE | 緑（既存の振る舞いの固定） | 緑 |
| `mark-contested-group-microsecond-boundary.postgres.test.ts`（既存） | マイクロ秒精度の境目 | 緑 | 緑 |

**変異試験**（実装に1か所ずつ変異を入れ、狙った歯が赤になり、戻すと緑に戻ることを確かめた）:

| 変異 | 赤になった歯 |
|---|---|
| mark の先行チェックのループを uuid 昇順にする | `contested-group-conflict-id`「複数のメンバーが条件を外れているとき、入力順で最初のものを指す」 |
| resolve の先行チェックのループを uuid 昇順にする | 同「複数のメンバーが contested でないとき、入力順で最初のものを指す」 |
| events を memory_id の昇順で返す | 同「成功時」の2件（mark / resolve） |
| mark の `members` を uuid 昇順で返す | 同「成功時」（mark） |
| 述語の `a.valid_from < b.valid_until` を `<=` にする | `relation-set-equivalence`「乱数の有効期間…」（境目の格子で赤） |
| `b.id <> a.id` を外す | `relation-set-equivalence` の6件 |

## 非破壊である根拠

- 公開の型・port・返り値の意味は変えていない。`MemoryStore.markContestedGroup?` / `resolveContestedGroup?` の契約（3条件の CAS、
  エラーの種類と id、返り値の並び）は上の歯が固定している。
- DB マイグレーションは足していない。書く行の集合（`memory_relations`・`memories` の更新・`memory_events`）は同じ。
- 変わりうる観測: (1) 文の数（性能）。(2) events の行の `id` が DB の `gen_random_uuid()` から JS の `randomUUID()` に変わる（どちらも v4 の uuid）。
  (3) UPDATE の `updated_at = now()` はトランザクション内で同じ値（旧実装も同じトランザクション内）。

## 【確かめていないこと】

- 案Dだけ・案Eだけの寄与の分離。
- 並行呼び出しでのロックの振る舞い（`FOR UPDATE` の後に UPDATE が0行になる防御的な経路は、通常は到達できず、歯では踏んでいない。コードを読んだだけ）。
- 完全1000 の mark の時間の内訳（INSERT の索引・外部キー検査が支配的、という推測はプロファイルで確かめていない）。
- 前回の測定との絶対値の差の原因（器の負荷と DB の状態の違いと思われるが、切り分けていない）。
- `conformance` 以外の実装（`InMemoryMemoryStore` 等）は触っていない。

## 採らなかった案

- **範囲型 `&&` による結合**: 空・逆転した区間で例外になり、集合が変わりうる（決定1）。
- **`ORDER BY` した掃引（sweep）で N² を避ける**: SQL の1文では書けず、JS 側に重なりの式を持つことになる
  （ADR 0381 が「JS 側に同じ式を二重に持たない」と決めた）。この PR の範囲では、残る N² の比較はメモリ上のものなので許容した。
- **列ごとの `text[]` で events を渡す形**: 上の【実測】で遅くなった。
- **`events` の `meta` を群の全 id から縮める**: runtime 側の変更で、この PR の範囲外（下の負債）。

## 引き受けた負債

1. **完全グラフの mark は、作る行数（N(N-1)）に比例して遅いまま。** 1000 で約 1 分。行を作らない設計（群の表現の変更）でしか下がらない。
2. **`meta` に群の全 id を載せる runtime の events は、1件約 40KB × N 件のまま。** detect（`observe` 経由）の下限を決めている。
3. **runtime の `resolveContestedGroup` が撃つ `listRelated` × N** はそのまま（resolve 全体の下限）。

## これが覆るとしたら何が起きたときか

- 最初の版（`text[]` + `::jsonb`）のように、`meta` が大きい経路で一括 INSERT が個別 INSERT より遅くなる測定が別の器でも出たら、
  一括の形を見直す。
- 別のストア実装（`describeMemoryStoreConformance`）が、UPDATE の対象を1件ずつ確かめる契約を課したら、決定2は変える。
