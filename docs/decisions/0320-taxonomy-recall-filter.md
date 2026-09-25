# ADR 0320: taxonomy によるラベル絞り込みを recall に足す — PR-B（Issue #201、ADR 0318 の続き）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手、
> セッション id `mgr-dc38f2b1`）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0246 / ADR 0282 / ADR 0289 / ADR 0318 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `git` / `vitest` / `psql` / `pnpm` を走らせて確かめた。
- **【推論】** — 読解・設計判断から導いたが、実測ではない。

断りの無い【現物】は `origin/main` = `ba6e5dd`（本作業の分岐点）の木、および本ブランチ
（`feat/201-taxonomy-recall-filter`）上で、2026-09-25 に行った。

---

## 射程 — PR-A（ADR 0318）が残した recall 側の絞り込み

[ADR 0318](./0318-taxonomy-labels.md) は `labels`/`memory_labels` テーブル・書き込み経路・
語彙 API（`listLabels?`/`registerLabel?`/`getTaxonomyMode?`/`setTaxonomyMode?`）を実装したが、
「PR-B に向けた申し送り」節で次を明示的に未着手のまま残した:

1. recall にラベルでの絞り込みを足す（段1・段5後置・`aggregateScope` の3点セット）。
2. `taxonomy_mode` が実際に絞り込みへ効く（open: registered/proposed 両方参加、
   strict: registered のみ）。
3. `FilteredOmission.condition: "taxonomy"` を実際に push する。
4. `GroupCount.axis: "taxonomy"` を実際に生成する（呼び手が明示したときだけ）。
5. 被覆不変条件（`docs/recall.md` §5）を壊さない設計と、それを歯で測る適合テスト。

本 ADR はこの5点の設計を決め、実装する。

---

## 前提として確認したこと（現物）

- `FilteredOmission.condition` の union には既に `"taxonomy"` が在り、
  `FILTERED_CONDITION_SCOPE_RELATION.taxonomy === "outside_scope"`
  （`packages/core/src/recall.ts`）——**この分類は ADR 0318 より前、`taxonomy` がまだ
  型だけの存在だった時点から固定されている。** つまり「taxonomy で落ちた Memory は
  `period`/`archived`/`expired`/`not_yet_valid` と同じ側（`totalInScope` から引かれる、
  かつ `omitted` として報告される）」という分類は、本 ADR が新たに決めることではなく、
  **既存の型が既に決めていたことを実装で満たすだけ**である。
- `GroupCount.axis` は既に `"subject" | "taxonomy"` の2値であり（`"time_window"` は
  ADR 0144 で落とされ union からも消えている）、`taxonomy` を実際に生成しても
  **公開 union は1バイトも変わらない**（ADR 0318 が既に確認した「値の追加ではなく、
  値が生成される経路の追加」という整理をそのまま引き継ぐ）。
- `docs/memory-model.md` §8・`docs/recall.md` §2 段0「スコープの外延」は、taxonomy を
  `attributes`/`subject`/`tenant`（識別子の境界、`filtered` に出ない）ではなく、
  `period`/`status`/`validity`（`filtered` に出る、`totalInScope` から引かれる）の側に
  並べている——`attributes`（ADR 0312）が「識別子の境界」側に付いたのとは**逆側**である。
- `labels`/`memory_labels` の書き込み経路（PR-A）は、`labels.name` が `memories.tags` の
  値と1対1・逐語一致することを保証する（`upsertProposedLabels` が `tags` からしか
  ラベルを作らない）。⟹ **ある Memory が「あるラベルを持つ」かどうかは、
  `memory_labels` を JOIN しなくても `memory.tags` から判定できる**——これが下の
  「決定1」の土台である。

---

## 決定

### 1. 絞り込みの判定は `memory_labels` を JOIN せず、`memories.tags` の配列演算で行う

`RecallQuery.labels?: string[]` を新設する。意味論は **OR**（渡した名前のうち、現在の
`taxonomy_mode` で参加資格のある名前を1つでも `tags` に持つ Memory だけを残す）。

**`idx_memory_labels_by_label`（ADR 0318 が先取りで作った索引）は使わない。** ADR 0318
「PR-B に向けた申し送り」はこの索引を「絞り込みの主索引になる想定」と書いていたが、
「前提として確認したこと」が示す通り `labels.name` は `tags` の値と1対1で一致するため、
`memory_labels`/`labels` を JOIN しなくても `memories.tags && ARRAY[...]::text[]`
（配列の重なり演算子）だけで同じ判定ができる。この判断を採った理由:

1. **postgres の既存 GIN 索引（`idx_memories_tags`、`0001_init.sql`）がそのまま効く**
   ——新しい JOIN 経路・新しい索引利用パターンを増やさない。
2. **core レベルの後置フィルタ（多層防御）が、追加のフィールドを持たずに書ける。**
   `Memory`/`RecalledMemory` は既に `tags` を持つので、`survivesLabelsFilter` は
   `attributes` と同じ形（Memory 自身が持つ値だけを見る）で書ける。`memory_labels` を
   使う設計だと、後置フィルタのために `Memory` へ「このラベルを持つか」という新しい
   欄を足すか、`MemoryStore` に新しい読み出しメソッドを増やす必要が生まれ、
   「公開 API に必須フィールドを足さない・adapter に新しい書き込み形状を要求しない」
   という PR-B の制約に対して重い。
3. **`taxonomy_mode` に応じた「参加資格」の判定を、CORE 側で1回だけ行い、
   `VectorFilter`/`LexicalFilter`/`aggregateScope` は resolved な名前の配列
   （素の `text[]`）だけを受け取る**——`labels` テーブルの `status` 列を
   知らなくてよい。ADR 0318「決定4」が既に確立した「読み書きの唯一の通り道」
   （`readTaxonomyMode`）をそのまま使い、SQL 側に `taxonomy_mode` の分岐を持ち込まない。

`idx_memory_labels_by_label` は将来 `memory_labels` を直接使う経路（例えば「この
Memory が持つラベルの詳細を1件ずつ返す」ような読み出し）が要るときのために残る
——**先取りが無駄になったわけではないが、本 PR では使わない**、と明記する。

### 2. 参加資格の解決 — CORE が `listLabels?`/`getTaxonomyMode?` を1回だけ呼ぶ

`recall-runtime.ts` の段0（スコープ確定）で、`RecallQuery.labels` か
`RecallQuery.taxonomyGroups`（後述）のどちらかが指定されているときだけ:

1. `taxonomyMode = deps.tenantSettingsStore が無ければ 'open'、在れば readTaxonomyMode(...)`
   （ADR 0318 決定4 の関数をそのまま呼ぶ）。
2. `allLabels = deps.memoryStore.listLabels?.(ctx)`（**任意メソッド**。無い adapter では
   `undefined`）。
3. `allLabels` が取れたら、`qualifying = allLabels のうち status === 'registered'、
   または（taxonomyMode === 'open' かつ status === 'proposed'）` の名前集合を作る。

`RecallQuery.labels` は `qualifying` と積を取り、**空になったら「絞り込み無し」
（`RecallScope.labels = undefined`）に倒す**——ADR 0318「PR-B に向けた申し送り」が
明示した意味論（「そのラベルによる絞り込みがフィルタから外れる＝そのラベルを
条件にしていないのと同じ扱いになる」）をそのまま実装したもの。**1個でも参加資格の
あるラベルが残れば、絞り込みはその残った集合だけで行う**（strict モードで
proposed のラベルだけを渡すと、絞り込みが丸ごと無効化される——これは「絞り込みが
効かない」のではなく「その軸を条件にしなかった」という扱いであり、ADR 0318 が
決めた `tagMatch` 非破壊の原則と同じ「既存の呼び出しを壊さない」側に倒す判断である）。

**`listLabels?` が無い adapter（`allLabels === undefined`）では、`RecallQuery.labels`・
`RecallQuery.taxonomyGroups` の両方が静かに無効化される**（`RecallScope.labels`/
`taxonomyGroupCandidates` とも `undefined` のまま）。エラーにしない——ADR 0318が
確立した「任意メソッドを実装しない adapter は、この機能が無い今日と同じ状態に
とどまるだけ」という規律をそのまま踏襲する。`RecallQuery.channels: ['lexical']` が
`lexicalStore` 不在で投げるのとは性質が違う——あちらは「配線の誤り」だが、こちらは
「taxonomy の語彙管理自体を実装していない adapter」であり、mnemora 自体が
`listLabels?`/`registerLabel?` を任意にした時点で許容した差である。

### 3. 3点セットへの伝播 — `attributes`（ADR 0312）と同じ配線

`RecallScope.labels?: string[]`（解決済みの参加資格ラベル名。`undefined` = 絞り込み無し）を
新設し、`includeSubjectless`（ADR 0286）・`attributes`（ADR 0312）が確立した「3点セット」
規律をそのまま踏む:

1. **段1押し下げ**: `VectorFilter.labels?: string[]`/`LexicalFilter.labels?: string[]` を
   新設。ANN チャンネルの `search()` 呼び出し・語彙チャンネルの `search()` 呼び出し・
   連想枠（段3.5）の `search()` 呼び出しの3箇所すべてに `labels: scope.labels` を撒く
   （`attributes: scope.attributes` の隣に置く）。postgres 実装は
   `m.tags && ${labels}::text[]`（overlap 演算子）を `WHERE` に足す。
2. **段5後置フィルタ**: `survivesLabelsFilter(memory)` を `survivesAttributesFilter` と
   同じ形で新設し、段1の後置ループ・連想枠の後置ループ・目次帯の多層防御
   （`scope.attributes !== undefined` の分岐に `scope.labels !== undefined` を additional
   な OR 条件として足す）の3箇所で呼ぶ。
3. **`aggregateScope`**: `RecallScope` をそのまま渡すので、`scope.labels` は
   自動的に集約クエリへ渡る（下記「決定4」）。

**必須の同伴取得（mandatory companion retrieval、段3）では検査しない。** 対向する
Memory を「争われている主張を、争われていない顔で単独で出さない」ために無条件で
取得する既存の設計（`docs/recall.md` §8）は、`subjectId`/`period`/`validAt`/
`decayFloorAt` を検査しない一方で `attributes`（ADR 0312 決定6：「取り扱いの境界」）だけを
検査する。**`labels` は `tags` から作られる分類軸であり、`attributes` の性質
（公開範囲などの取り扱いの境界）ではなく `tags` の性質（内容の分類）に近い**——
`tags` 自体が同伴取得を素通しする（`docs/memory-model.md` §8「`tags` は段1のフィルタには
参加しない」）のと同じ理由で、`labels`（`tags` の語彙状態）も同伴取得では検査しない。

### 4. `ScopeAggregate.filteredTaxonomy` — 既存の `filteredPeriod`/`filteredExpired` と同じ形、ただし**任意フィールド**

`MemoryStore.aggregateScope` の返り値に `filteredTaxonomy?: { count: number; countKind:
CountKind }` を足す。**`totalInScope`（=`in_scope`）から除かれる**（「前提として確認した
こと」が示す通り、`taxonomy` は既に `outside_scope` に分類されているため）。

**⚠ 他の `filtered*` 欄（`filteredArchived` 等）と違い、この欄は任意（`?`）にした。**
マネージャー指示（「公開 union に値を足さない・既定値を変えない・必須フィールドを足さない」）
を踏まえた判断——`filteredArchived` 等は Phase 1 から存在する契約で全 adapter が
最初から満たしているが、`filteredTaxonomy` を必須にすると `aggregateScope` を自作する
第三者 adapter が本 PR の取り込みだけでコンパイルできなくなる。本 PR の他のすべての欄
（`VectorFilter.labels?` 等）が任意であることと揃え、`postgres`/`testkit` は常にこの欄を
返すが、実装しない adapter では `recall-runtime.ts` が欄の不在を「0件」として扱う。

postgres 実装（単一パス、ADR 0307）は、`scoped`/`flags`/`agg` の3層構造に
`has_qualifying_label` という新しい boolean 列を1本足すだけで済む:

- `scoped` の SELECT に `tags` を足す（判定に要る唯一の追加列）。
- `flags.has_qualifying_label = (scope.labels が無ければ true、在れば tags &&
  scope.labels)`。
- `agg.in_scope` の `FILTER` 条件に `AND has_qualifying_label` を足す
  （`live AND in_period AND is_valid AND has_qualifying_label`）。
- `agg.taxonomy_filtered = count(*) FILTER (WHERE live AND in_period AND is_valid AND
  NOT has_qualifying_label)`——`expired_filtered`/`not_yet_valid_filtered` と同じ
  「直前までのゲートを通過し、このゲートだけで落ちた」集計。
- `decayed_filtered` は変更しない位置のまま——**`is_decayed` 自体の計算式に
  `has_qualifying_label` は影響しない**が、`decayed_filtered` を数える `FILTER` 条件
  （`live AND in_period AND is_valid AND is_decayed`）はそのまま残す。⟹
  `has_qualifying_label = false` の Memory は `taxonomy_filtered` に数えられ
  `in_scope`（および `decayed_filtered` の対象集合）から外れる——**`taxonomy` は
  `decayed` より先に効く**（`decayed` はスコープ内の到達しにくさのゲートであり、
  taxonomy はスコープそのものを定義するゲートだから、という「スコープの外延」の
  順序どおり）。

`scope.labels === undefined`（絞り込み無し）のとき `has_qualifying_label` は常に
`true` になり、`taxonomy_filtered` は常に0——他の `filtered*` 欄が対応する
`RecallQuery` の欄を渡さなかったときに0になるのと同じ規約。

`recall-runtime.ts` は `aggregate.filteredTaxonomy.count > 0` のときだけ
`omitted.push({ kind: "filtered", condition: "taxonomy", scopeRelation:
FILTERED_CONDITION_SCOPE_RELATION.taxonomy, count, countKind })` を積む——
`period`/`expired`/`decayed` と1文字も違わない形。

**`subject` 軸の群カウント（`in_scope` を `GROUP BY subject_id` したもの）は、
`has_qualifying_label` を含んだ後の `in_scope` を数えるので、taxonomy の絞り込みが
`subject` 軸の群カウントにも自動的に反映される**——`totalInScope` = Σ(`subject` 軸の
`count`) という既存の被覆不変条件は、taxonomy の絞り込みを追加しても崩れない
（`attributes`/`subjectId` の絞り込みが既にこの性質を持っているのと同じ理由）。

### 5. `GroupCount.axis: "taxonomy"` — 呼び手が明示したときだけ、独立したサブクエリで

`RecallQuery.taxonomyGroups?: boolean`（既定 `false`）を新設する。`true` のときだけ
`RecallScope.taxonomyGroupCandidates?: string[]`（決定2で解決した `qualifying` 名の
全件、フィルタとは独立——`RecallQuery.labels` を指定していなくても、または指定した
ものと違う名前でも、テナントの語彙全体を対象にする）を組み立て、`aggregateScope` へ渡す。

**postgres 実装は `scoped`/`flags`/`agg` を再利用せず、`digestBand` と同じやり方
（`memories` を直接、同じ `tenant_id`/`subjectFilter`/`attributesFilter`/`status`/
`inPeriod`/`isValid`/`has_qualifying_label` の WHERE で再スキャンする独立サブクエリ）
で計算する。** 理由は ADR 0307 が `digestBand` について書いた理由と同じ——
`unnest(tags)` を伴う `GROUP BY` を単一パスの `agg` に混ぜると、`agg` の粒度
（`GROUP BY subject_id`）と `unnest` の粒度（1 Memory × Nラベル）が合わず、
`scoped`/`flags` を経由する既存の集計が壊れる。**opt-in のときだけ発生する追加コスト**
であり、既定（`taxonomyGroups` 省略）では SQL テキストにも実行計画にも一切現れない
（`digestBandColumns` が `opts?.digestBand` の有無で分岐するのと同じパターン）。

```sql
-- taxonomyGroupCandidates が在るときだけ足す
(
  SELECT coalesce(json_agg(json_build_object('key', tag, 'count', tag_count)), '[]'::json)
  FROM (
    SELECT tag, count(*) AS tag_count
    FROM memories, unnest(tags) AS tag
    WHERE tenant_id = $1 <subjectFilter> <attributesFilter>
      AND status IN ('active','contested') AND <inPeriod> AND <isValid>
      AND tag = ANY($candidates)
    GROUP BY tag
  ) t
) AS taxonomy_label_groups,
(
  SELECT count(*)::int
  FROM memories
  WHERE tenant_id = $1 <subjectFilter> <attributesFilter>
    AND status IN ('active','contested') AND <inPeriod> AND <isValid>
    AND NOT (tags && $candidates::text[])
) AS taxonomy_residual_count
```

**`taxonomy_label_groups` は `has_qualifying_label`（＝ `RecallQuery.labels` による
絞り込み、指定されていれば）の**内側**を数える**——グルーピングは「(絞り込み済みの)
現在のスコープを、テナントの語彙全体で内訳する」ものであり、絞り込みと独立した
別のスコープを作らない。これは `subject` 軸の群カウントが `attributes`/`subjectId` の
絞り込みの内側を数えるのと同じ設計判断である。

**カウント0のラベルは載せない**（`subject` 軸が `in_scope > 0` のものだけを載せる
既存の規約と同じ——`GROUP BY` が自然にそうなる）。**残差（`key: null`）も、
カウントが0なら載せない**——同じ規約をここにも揃える。

### 6. 被覆不変条件（`docs/recall.md` §5）— 「合計一致」は `axis` ごとに閉じる。`taxonomy` 軸は新しい形の保証を持つ

**既存の文（`docs/recall.md` §5「(3)の件数の総和は、スコープ内の総数と一致する」）は、
`groups` 配列に `axis: 'subject'` しか無かった時点の記述である。** `taxonomy` 軸の
群カウントは1つの Memory が複数のラベルに属しうる（多対多、`memory_labels`）ため、
`taxonomy` 軸の `count` の総和は `totalInScope` を**超えうる**（重複計上）。
これは実装の不備ではなく、ラベルの多重所属という現実の反映である。

**⟹ 本 ADR は被覆不変条件を axis ごとに定義し直す:**

- **`axis: 'subject'`**: 従来どおり。1 Memory は常に厳密に1つの `subject_id`
  （または `null`）を持つため、`subject` 軸の `count` の総和は必ず `totalInScope`
  と一致する（**変更なし**——`taxonomy` 軸の追加は `subject` 軸の集計方法を1つも
  変えていない。「決定4」参照）。
- **`axis: 'taxonomy'`（新設）**: **合計一致ではなく「取りこぼしが無いこと」
  （distinct-coverage）を保証する。** `taxonomyGroups: true` を指定した呼び出しでは、
  `totalInScope` に数えられる Memory は必ず次のどちらか（両方もありうる）に
  数えられる:
  1. **少なくとも1つの `taxonomy` 軸のラベル群**（その Memory が持つ、現在の
     `taxonomy_mode` で参加資格のあるラベルの数だけ、複数の群に重複して数えられる）。
  2. **`taxonomy` 軸の残差群（`key: null`）**——参加資格のあるラベルを1つも
     持たない Memory（無タグ・無ラベルの Memory と、strict モードで proposed の
     ラベルしか持たないため参加資格が無い Memory の両方を含む）。

  この2つは排他的ではない設計にした——1つの Memory が複数のラベルを持てば
  複数のラベル群に数えられるが、**残差群に数えられる Memory は他のどの
  ラベル群にも数えられない**（「参加資格のあるラベルを1つも持たない」という
  定義上、他の群に現れようがない）。⟹ **ラベル群の集合と残差群は互いに
  排他的だが、ラベル群どうしは互いに排他的ではない。**

  **`totalInScope` との関係を検算可能な形で言うと**: `taxonomy` 軸の残差群の
  `count` に、**「少なくとも1つのラベル群に数えられた Memory の distinct 数」**
  （＝ラベル群の `count` の単純合計ではなく、重複を除いた distinct union の大きさ）
  を足すと、必ず `totalInScope` に一致する。**この distinct union の大きさは
  `GroupCount[]` の形からは直接読めない**（読めるのはラベルごとの合計だけであり、
  重複を除いた union を知るには元データが要る）——**呼び出し側が `groups` の
  `count` を単純合計して `totalInScope` と突き合わせる、という従来の
  `subject` 軸の使い方を `taxonomy` 軸にそのまま持ち込むと、値が合わずに
  「壊れている」と誤読しうる。** この非対称を `docs/recall.md` §5・
  `GroupCount`/`ScopeAggregate` の doc コメントに明記し、`taxonomy` 軸の
  「合計は一致しない」ことを型のドキュメントレベルで警告する。

- **適合テスト（歯）**: `packages/testkit` に、ラベル所属が0個・1個・複数個・
  strict で参加資格の無いものだけ、の4パターンを混在させた Memory 集合を作り、
  `aggregateScope(..., ) `（`taxonomyGroupCandidates` 経由）の結果に対して:
  1. 各ラベル群の `count` が、フィクスチャから独立に数えた「そのラベルを持つ
     scope 内 Memory の数」と**厳密一致**すること。
  2. 残差群の `count` が、フィクスチャから独立に数えた「参加資格のあるラベルを
     1つも持たない scope 内 Memory の数」と**厳密一致**すること。
  3. 上記1・2の対象 Memory の集合を実際に列挙し、**和集合が scope 内の全 Memory
     と一致し、かつ残差群とラベル群の対象が互いに排他的である**こと
     （distinct-coverage の直接検算）。
  4. **`subject` 軸の従来の不変条件（合計一致）が、`taxonomyGroups: true` を
     同時に指定しても崩れない**こと（`taxonomy` 軸の追加が `subject` 軸を
     汚染しないことの回帰止め）。
  postgres・In-Memory の両方で同じフィクスチャ・同じ期待値を検査する
  （`packages/testkit` の適合テストとして共通化——`supportsTaxonomyGroups` の
  ような capability フラグは不要。両 adapter とも `listLabels?`/`taxonomyGroups`
  を実装しているため、常に検査できる）。

### 7. `taxonomy_mode` の参加規則 — open は両方、strict は registered のみ

Issue #201・`docs/memory-model.md` §8 の文言どおり:

- `taxonomy_mode: 'open'`（既定）—— `registered`・`proposed` の両方が参加資格を持つ。
- `taxonomy_mode: 'strict'` —— `registered` のみが参加資格を持つ。`proposed` は
  「決定2」のとおり、絞り込みからもグルーピングの候補集合からも除外される
  （グルーピング候補 `taxonomyGroupCandidates` の生成時点で既に除かれるので、
  strict モードでは `proposed` のラベル名がラベル群として現れることはない——
  それらのラベルしか持たない Memory は残差群に数えられる）。

**`tagMatch`（`defaultScoringStrategy`、既存のスコアリング加点）は一切変えない**
——ADR 0318「決定5」がこの版でも維持される。`strict` が効くのは
`RecallQuery.labels`/`RecallQuery.taxonomyGroups` という**新しい**任意入力に対して
だけである。

---

## 採らなかった案

| 案 | 却下の理由 |
|---|---|
| **`memory_labels`/`labels` を JOIN して絞り込む（ADR 0318 の見立てどおり）** | 「決定1」参照。`tags` との1対1対応により JOIN が不要になり、既存の GIN 索引がそのまま使え、後置フィルタが `Memory` の既存フィールドだけで書ける。`idx_memory_labels_by_label` は将来 `memory_labels` を直接使う別の読み出しのために残す。 |
| **`RecallQuery.labels` を AND 意味論にする（`attributes` と同じ）** | ラベルは分類・カテゴリの軸であり、複数タグを持つ1つの Memory に対して「これらのラベルを*すべて*持て」は分類軸としては狭すぎる（カテゴリの絞り込みは通常「いずれかに属する」）。ADR 0318 はこの意味論を決めておらず（「PR-B の裁量」）、本 ADR が OR を選んだ。**強い根拠がある選択ではない**——利用実績が無い段階の裁量であり、覆りうる（「これが覆るとしたら」参照）。 |
| **`taxonomy` 軸の群カウントも `subject` 軸と同じ「合計一致」にする（残差を作らず、多重計上を許容しない）** | ラベルの多対多という現実を反映できない。多重計上を禁じるには「Memory ごとに1つの代表ラベルだけを選ぶ」ような追加の規則が要り、`labels`/`memory_labels` の設計（複数ラベルを許す）と矛盾する。 |
| **strict で参加資格の無い Memory を残差群からも省く（黙って消す）** | Issue の指示「strict で数えられなかった proposed は黙って消さず、どう見えるかを決めること」に反する。北極星の「見つからなかった／数えられなかった」の区別を潰す（`docs/north-star.md`）。 |
| **`labels` フィルタを必須の同伴取得（段3）にも適用する** | 「決定3」参照。`labels` は `tags` 由来の内容分類軸であり、`attributes`（取り扱いの境界）とは性質が違う。`tags` 自体が同伴取得を素通しする既存の設計と揃える。 |
| **`listLabels?` が無い adapter でエラーにする** | ADR 0318 が確立した「任意メソッドを実装しない adapter はこの機能が無いだけ」という規律に反する。エラーにすると、taxonomy 語彙管理を実装していないだけの既存 adapter の `recall()` 呼び出しが（`labels`/`taxonomyGroups` を指定した途端に）壊れる。 |

## 引き受けた負債

1. **`RecallQuery.labels` の OR 意味論は利用実績の無い裁量である**（「採らなかった案」
   参照）。AND を求める要求が出たら、新しい欄（例: `labelsMode: 'all' | 'any'`）を
   足す形で対応することになる——既存の `labels` の意味を後から変えると破壊的変更に
   なるため、新欄の追加で対応する。
2. **`taxonomy` 軸の群カウントは、呼び出し側が `groups` を軸を区別せず単純合計すると
   `totalInScope` と食い違って見える。** 型の doc コメントと `docs/recall.md` §5 に
   警告を書いたが、**機械的に強制する手段は無い**（呼び出し側のコードを検査できない）。
3. **`idx_memory_labels_by_label`（ADR 0318 で先取りした索引）は本 PR で未使用のまま
   残る。** 将来 `memory_labels` を直接使う読み出しが要るまで、使われない索引として
   書き込みコストだけを払い続ける。
4. **taxonomy グルーピングの postgres 実装は `memories` を追加で1回スキャンする**
   （`digestBand` と同じパターン）——`taxonomyGroups: true` と `digestBand` を同時に
   使うと、`aggregateScope` は1回の SQL 文の中で `memories` を計2回（digest 用・
   taxonomy グルーピング用）再スキャンする。単一 SQL 文であることは変えていないので
   `totalInScope` との整合（同一スナップショット）は崩れないが、実行コストは
   増える。1M件規模での実測はしていない（下記「確かめていないこと」）。

## これが覆るとしたら

1. **`RecallQuery.labels` に AND 意味論を求める要求が出たとき**——「引き受けた負債」1
   参照。
2. **`memory_labels` を直接使う読み出しが必要になったとき**——`idx_memory_labels_by_label`
   を実際に使う経路を実装し直すことになる。
3. **taxonomy グルーピングの追加スキャンコストが実運用で問題になったとき**
   （「引き受けた負債」4）——`unnest(tags)` の集計を単一パスの `agg` に統合する
   書き換え（ADR 0307 と同じ種類の最適化）を検討することになる。

---

## 測ったこと

断りの無い【実測】は手元の Postgres（`initdb` で自分専用に起動、PostgreSQL 17、
`127.0.0.1:55432`）、PostgreSQL 17 + pgvector 0.8.0 + `btree_gin`/`pgcrypto` に対して
2026-09-25 に行った。

### 【実測】適合テスト・単体テスト（すべて green）

```
$ pnpm --filter @mnemora/core exec vitest run
 Test Files  78 passed (78)
      Tests  1183 passed | 4 expected fail (1187)

$ pnpm --filter @mnemora/testkit exec vitest run
 Test Files  7 passed (7)
      Tests  420 passed | 11 skipped (431)

$ DATABASE_URL=postgresql://worker@127.0.0.1:55432/mnemora_test \
  pnpm --filter @mnemora/postgres exec vitest run
 Test Files  58 passed (58)
      Tests  662 passed (662)
```

`packages/core` の新規テスト（`recall-taxonomy-filter.test.ts`、17件）は配線・OR 絞り込み・
open/strict の参加資格・`filteredTaxonomy`・後置フィルタ・連想枠への伝播・
`taxonomyGroups`・`listLabels?` 未実装 adapter での静かな無効化を検査する。
`packages/testkit`（in-memory: +12件、postgres: +12件、同じフィクスチャ・同じ期待値）は
`VectorFilter.labels`/`LexicalFilter.labels` の絞り込みと、`aggregateScope` の
`filteredTaxonomy`・`axis: 'taxonomy'` の群カウント・**distinct-coverage の直接検算**
（フィクスチャから独立に計算した期待値との突き合わせ）を検査する。

### 【実測】赤→緑（変異試験、`docs/autonomy.md` §2 の要求）

`AGENTS.md`「⛔ 変異を戻すのに `git checkout` を使わない」の手順（`cp` で退避・復元）に
従った。

**M1: postgres `aggregateScope` の `hasQualifyingLabel` を常に `true` にする**

```
$ (hasQualifyingLabel を `sql\`true\`` 固定に置換)
$ DATABASE_URL=... pnpm --filter @mnemora/postgres exec vitest run src/__tests__/conformance.postgres.test.ts
 Tests  4 failed | 345 passed (349)
```

赤くなったのは `scope.labels` を使う4件（絞り込み2件・OR2件目・digests連動1件——
正確には「絞り込める」「OR」「digests」「taxonomyGroupCandidates の内側」の4件）のみ。
`cp` で復元後、349件すべて緑に戻ることを確認。

**M2: postgres `taxonomy_residual_count` の `NOT` を外す（残差を数えない側に壊す）**

```
$ (`AND NOT (tags && ...)` から `NOT` を削除)
$ DATABASE_URL=... pnpm --filter @mnemora/postgres exec vitest run src/__tests__/conformance.postgres.test.ts
 Tests  1 failed | 348 passed (349)
```

赤くなったのは「ラベルごとの群と残差を...厳密に数える（被覆不変条件）」1件だけ
（狙った歯だけが落ちた——distinct-coverage の歯が実際に噛むことの確認）。復元後、緑に戻る。

**M3: postgres `PostgresVectorStore.search` の `labels` 条件を無効化する**

```
$ (`if (opts.filter.labels !== undefined)` を `if (false)` に置換)
$ DATABASE_URL=... pnpm --filter @mnemora/postgres exec vitest run src/__tests__/conformance.postgres.test.ts
 Tests  2 failed | 347 passed (349)
```

赤くなったのは `VectorStore conformance` の `filter.labels` の2件だけ。復元後、緑に戻る。

**M4: core `recall-runtime.ts` の参加資格フィルタを無効化する（全ラベルを常に参加資格ありにする）**

```
$ (`.filter((label) => label.status === "registered" || taxonomyMode === "open")` の
   条件の先頭に `true ||` を挿入)
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/recall-taxonomy-filter.test.ts
 Tests  2 failed | 15 passed (17)
```

赤くなったのは strict モードの参加資格を検査する2件（絞り込み・グルーピングそれぞれ1件）
だけ。復元後、17件すべて緑に戻る。

**M5: testkit `InMemoryMemoryStore.aggregateScope` の taxonomy 判定を無効化する**

```
$ (`memory.tags.some(...)` の先頭に `true ||` を挿入)
$ pnpm --filter @mnemora/testkit exec vitest run src/__tests__/in-memory-fixtures.conformance.test.ts
 Tests  4 failed | 344 passed | 1 skipped (349)
```

赤くなった4件は M1 と同じ性質の歯（in-memory 側）。復元後、緑に戻る（348 passed | 1 skipped）。

**5本とも、`cp` で退避したファイルに `cp` で復元後、同じ it が緑に戻ることまで実測した**
（`git status --porcelain` が空になることも確認済み）。

### 【実測】型・lint・フォーマット・公開 API

```
$ pnpm run typecheck   # 全パッケージ + examples/chat、エラー0件
$ pnpm run lint        # エラー0件
$ pnpm run format:check  # 4ファイルの指摘を `prettier --write` で解消、再チェック green
$ pnpm run api:check
✗ 違反が2件（@mnemora/core, @mnemora/testkit）——すべて任意フィールドの追加のみ
  （`VectorFilter.labels?`/`LexicalFilter.labels?`/`ScopeAggregate.filteredTaxonomy`
  （必須フィールドだが `ScopeAggregate` は「返り値」型であり、呼び出し側が構築する
  必要はない——契約を満たすのは実装側だけ）/`RecallQuery.labels?`/`taxonomyGroups?`/
  `RecallScope.labels?`/`taxonomyGroupCandidates?`/`PrepareMemoryIdAttrs.tags?`/
  `PrepareLexicalMemoryAttrs.tags?`）。公開 union に値を足していない・既存フィールドの
  型を変えていない・必須フィールドを呼び出し側の入力型に足していない。
$ pnpm run api:write   # snapshot 更新、api:check が green に戻ることを確認
```

**⚠ `ScopeAggregate.filteredTaxonomy` は返り値型の必須フィールドである**——`aggregateScope`
を実装する第三者 adapter（`packages/postgres`/`packages/testkit` 以外)は、この欄を
追加しないと型検査で落ちる。これは `RecalledMemory` 等と違う——`ScopeAggregate` は
「adapter が返す値」であり「呼び出し側が渡す値」ではないため、`digests`/`digestEligible`
のような他の必須フィールドと同じ扱いである（[ADR 0073](./0073-digest-band-bounded-without-taxonomy.md)
決定7 が `digests`/`digestEligible` を必須で足したときと同種の判断）。**破壊的変更である**
——`MemoryStore` を自作する第三者 adapter は、この PR を取り込むと `aggregateScope` の
返り値の型チェックが通らなくなる（実行時の挙動は変わらないが、コンパイルが壊れる）。
`packages/core` は semver `0.x` であり ADR 0070 の versioning 方針の下で許容されるが、
念のためここに明記する——`ADR 0156` は「明記の免除」を与えない。

### 確かめていないこと

- 1,000,000件規模のテナントで `taxonomyGroups: true` を使った場合の `aggregateScope` の
  追加コスト（`memories` の再スキャン）は測っていない——`digestBand` と同じパターンの
  追加コストであり、ADR 0307 が測った `digestBand` 単体のコストから類推できるはずだが、
  実測はしていない。
- `examples/chat` からの動作確認はしていない（ADR 0318「引き受けた負債」4 と同じ射程外）。
- CI（GitHub Actions、`pgvector/pgvector:pg17` イメージ）での実行は、この ADR の執筆時点
  ではまだ確認していない——PR の CI 実行結果を見ること。
