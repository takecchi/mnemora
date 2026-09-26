# ADR 0258: `restoreSuperseded` を「1回の操作」単位に絞る（方向①）—— 鍵は新設せず、既にある情報で絞る

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-21

> **⚠ この ADR が採る方向（①）は、クローンが [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)
> に基づいて自分で決めたものである。⛔ 人間オーナー本人の判断ではない。**
> 投稿者名・commit の署名からは、オーナー本人と担い手を見分けられない
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ この ADR の記述を「オーナーがそう決めた」と読まないこと。

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0183 / 0192 / 0228 / 0230 / 0237 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `vitest`/`psql`/`node`/`git` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、この書き手自身は再導出していない（出所を明記する）。

---

## 文脈

[Issue #515](https://github.com/takecchi/mnemora/issues/515) は、`Runtime.restoreSuperseded`
が戻す「群」（`superseded_by_id` が一致する行の集合）が、**1回の統合操作とちょうど
一致するとは限らない**ことを報告した——`resolveContested` の勝者は新規作成された
Memory ではなく前から在る Memory であるため、同じ `superseded_by_id` の下に別々の
操作の敗者が積み上がりうる（[ADR 0230](./0230-restore-superseded-recovery-path.md)
冒頭の訂正）。

issue が並べた「考えられる方向」4つのうち、方向3（戻す前に何が戻るかを返す
dry-run）は [ADR 0237](./0237-restore-superseded-dry-run-preview.md) が既に実装した。
issue のクローンによる判定コメントは、方向3を v1.0.0 に入れる一方で、
**方向2（`memory_events` に操作 id を新設し、群をもっと細かい鍵で絞る）は
「v1.0.0 の要件ではない」として先送りし、「将来 方向2 を採るときは
`docs/roadmap.md` §5 級として扱う」**と決めていた。

**本 ADR は、その先送りを再検討したものではない。** issue が残した4つの方向のうち
**採らなかった方向1（記述を正しく名乗るだけ）・方向4（`resolveContested` 由来だけ
別扱い）とも別**の、**5つ目の方向（①）**——**鍵を新設せず、既に `restoreSupersededBy?`/
`previewRestoreSupersededBy?`（ADR 0237）が持っている情報（`memories.id` と
`supersededReason`）だけで、操作単位に絞れるところまで絞る**——を、クローンが
ADR 0156 の委譲に基づいて自分で選び、実装したものである。

---

## ①②③の比較 —— なぜ②（新しい鍵）を採らないか

| 方向 | 中身 | 採るか |
|---|---|---|
| **②** | `memory_events` に操作 id（uuid）を新設し、`superseded_by_id` の代わりに（または加えて）その id で群を絞れるようにする | ⛔ **採らない** |
| **③** | 戻す前に何が戻るかを返す dry-run | ✅ 既に採用済み（ADR 0237） |
| **①（本 ADR）** | 鍵を新設せず、既にある `id`/`supersededReason` だけで、絞れる範囲だけ絞る | ✅ **本 ADR が採る** |

**②を採らない決定的な理由 —— 鍵を作っても過去の行は1件もバックフィルできない。**
操作の境界は発生時にしか記録されておらず、後から再構成できない。⟹ **鍵を作る費用を
払っても、いま `superseded` として積み上がっている既存の `memory_events` 行は
1件も直らない**——新しい鍵を持つのは、この変更より後に書かれる行だけである。
これは issue の判定コメントが方向2を「v1.0.0の要件ではない」とした理由（「方向3が
入れば事故は起きる前に止まる」）とは**別の、より強い理由**であり、**この ADR が
新たに立てた根拠**である。

**①が③と違う点** —— ③（dry-run）は「何が戻るか」を*見せる*だけで、群を*絞る*
手段は増やさなかった。①は、③が既に見せている情報（`supersededReason`）を使って、
実際に絞り込む口（`onlyMemoryIds`）を足す。⟹ **①は③の上に立つ——③が無ければ
①は成立しない**（呼び出し側が絞り込みの材料を持てないため）。

**①が新しい索引・マイグレーションを1本も要らない理由**は「実装」節で現物を引いて示す。

---

## `resolveContested`/`consolidate`/`reextract` の非対称 —— どこまで絞れるか

`superseded_by_id` の群を、`previewRestoreSupersededBy?` が返す `supersededReason`
（`"consolidated"` / `"reextract_superseded"` / `"contested_resolved"` / `null`）で
分けたとき、**どこまで「1回の操作」と一致させてよいかは、経路ごとに異なる。**

| 経路 | 1回の操作が作る敗者 | 群を reason で絞ると1操作と一致するか | 根拠 |
|---|---|---|---|
| **`consolidate`** | N件（統合元） | ⭕ **一致する** | **構造的な保証**——統合先の `sourceObservationId` は常に `null`（`packages/core/src/strategies/consolidate.ts:128` 付近、【現物】）。`createMemoryWithOutbox` の冪等 `ON CONFLICT (tenant_id, source_observation_id, extractor_version, content_hash) WHERE source_observation_id IS NOT NULL DO NOTHING`（`packages/postgres/src/memory-store.ts:635` 付近、【現物】）は、この述語を満たさない行（`source_observation_id IS NULL`）を対象に入れないため、**衝突判定そのものが起こらず、統合先は必ず新規作成される**。⟹ 1アンカーの下に consolidate 群は高々1つ |
| **`resolveContested`** | ⭐ **ちょうど1件**（下記「不変条件」参照） | ⭕ **一致する。ただし reason ではなく「1件=1操作」で絞る** | `resolveContested(ctx, firstId, secondId, { kind: "supersede", winnerId })` は、勝者が2度以上使い回されても、**1回の呼び出しにつき必ずちょうど1件の敗者しか作らない**——歯で固定（下記） |
| 🔴 **`reextract`** | N件 | ⛔ **一致しない場合がある** | `reextract` のアンカーは候補列の先頭 `memoryIds[0]` を**位置で**選ぶ（`created` の真偽を見ない、`packages/core/src/runtime.ts:2635`/`:2643` 付近、【現物】）。その候補が上記と同じ冪等 `ON CONFLICT` 経由で**既存の Memory に解決される**と、複数回の別々の `reextract` 呼び出しが同じアンカーを共有しうる。このとき `meta.reason`/`sourceObservationId`/`extractorVersion` は複数回の呼び出しの間で**完全に一致しうる**ため、既存の情報からはどちらの呼び出しの敗者かを区別できない（両 adapter で再現。【受】——このチェックアウトの書き手は再現していない。[ADR 0230](./0230-restore-superseded-recovery-path.md) 訂正4参照） |

⟹ **`consolidate`/`resolveContested` は「割れる」、`reextract` は「割れない場合がある」。**
⛔ **`reextract_superseded` の候補を、割れるかのように扱わない**——これが本 ADR の
中心的な設計判断である（下記「`boundaryConfidence`」節）。

### 🔴 `resolveContested` が依存している不変条件と、それを縛る歯

①（特に `contested_resolved` を「1件=1操作」として扱う扱い）は、次の前提の上に
立っている:

> `resolveContested(ctx, firstId, secondId, { kind: "supersede", winnerId })` は、
> 1回の呼び出しにつき、ちょうど1件の敗者（`status: "superseded"`）と、ちょうど
> 1件の `kind: "superseded"` `memory_events` 行を作る。

これは `resolveContested` の interface doc コメント（手順5、`runtime.ts`）が
記述している振る舞いであり、【実測】でも確認済みだが、**記述と実測だけでは
将来の変更で黙って崩れうる**。⟹ **専用の歯を置いて固定した**:
`packages/core/src/__tests__/resolve-contested-loser-invariant.test.ts`。

この歯の冒頭コメントは、逐語でこう書いている（歯そのものの引用）:

> 🔴 この歯が守っているのは `resolveContested` の実装の詳細ではない。……
> ここで固定するのは「振る舞いの詳細」ではなく「他所（`restoreSuperseded` の
> 操作単位絞り込み、`groupSupersededCandidatesByOperation` の `"per_item"` 分類）が
> 依存している契約」である。**この歯が赤くなったら、実装のバグではなく、上の
> 前提そのものを変える設計判断をしている**——その変更をするときは、この歯を
> 直すだけでなく `RestoreSupersededTarget.onlyMemoryIds` の doc コメントと
> ADR 0258 も見直すこと。

歯は3本:

1. `kind:'supersede'` を1回呼ぶと、敗者はちょうど1件——0件でも2件でもないことを、
   呼び出し前後の差分（`status`/`memory_events` の両方）で確認する。
2. 同じ勝者が2回勝っても（ADR 0230 の再現2と同じ形）、**そのつどの呼び出し単体の
   増分はちょうど1件のまま**であることを確認する——累積2件と混同しない。
3. `kind:'both_active'` は敗者を作らない——`'supersede'` に固有の不変条件である
   ことを明示する（対象外のケースを対象内と取り違えないため）。

【実測】変異試験で歯が実際に噛むことを確認した（「測ったこと」節）。

---

## `boundaryConfidence` の3値と、なぜ `"unknown"` は「まとめて返す」ことにしたか

`groupSupersededCandidatesByOperation`（`@mnemora/core`、`previewRestoreSupersededBy?`
の候補を推定される操作単位へグルーピングする補助関数）は、各グループに
`boundaryConfidence: "structural" | "per_item" | "unknown"` を付ける:

- **`"structural"`**（`consolidated`）: 統合先が常に新規作成されるという構造的な
  保証により、同じ reason の候補は必ず1操作分である。
- **`"per_item"`**（`contested_resolved`）: 上記の歯が固定する不変条件により、
  1件が必ず1操作である——このときグループの `memoryIds` は常にちょうど1件。
- **`"unknown"`**（`reextract_superseded`、および `supersededReason` が
  取れなかった候補・将来の未知の reason 文字列）: 既存の情報だけでは操作単位に
  分割できるとは断言できない。

### 🔴 `"unknown"` のとき、1件ずつに分割しない——まとめて返す

**これが本 ADR の決定である。** `"unknown"` の候補は、同じ `supersededReason` の
値ごとに**まとめて**1グループとして返し、`boundaryConfidence: "unknown"` を
付けるだけで、1件ずつには分割しない。

**理由**: 1件ずつに分割すると、「この1件が1回の操作である」という**偽の構造**を
呼び出し側に与える。分割するという行為そのものが、**「分からない」を「分かって
いる」に化けさせる操作**である。`docs/north-star.md` の迷ったときの問い3
（この記憶が選ばれた理由を、後から説明できるか）に照らすと、分けた場合
呼び出し側は「なぜこの1件だけが戻ったのか」を**説明できると誤認する**——実際には
mnemora 側はそれを1件と確認したわけではなく、単に「まとめて返した集合を、
呼び出し側が勝手に1件ずつに割った」だけである。

⟹ ⛔ **`"unknown"` は「安全側に倒して1件ずつ扱う」という意味ではない。**
「同じ操作かもしれないし、別の操作かもしれない。mnemora はこれを区別する情報を
持たない」という宣言であり、**その先の判断（1件ずつ呼ぶか、まとめて呼ぶか、
呼ばずに置いておくか）は呼び出し側に委ねる**（ADR 0223 決定2「機械は検出まで」の
踏襲）。

### 方向4（`resolveContested` 由来だけ別扱い）を採らない理由の継承

ADR 0237 は方向4（`resolveContested` 由来だけを特別扱いする API）を、
「由来の区別を API の意味（型・分岐）に持ち込む必要が無い」「持ち込むと、
経路が増えたときに契約が壊れる」という理由で退けた（ADR 0223 決定8）。

本 ADR は `onlyMemoryIds` というフィルタ自体には**経路の区別を一切持ち込まない**
——`consolidated`/`contested_resolved`/`reextract_superseded` のどれであっても、
`onlyMemoryIds` は単に「渡された id 集合に絞る」だけの汎用機構である。区別を
持ち込んでいるのは `groupSupersededCandidatesByOperation`（任意の補助関数、
`Runtime.restoreSuperseded` の必須経路ではない）の**グルーピングの判断**だけであり、
これは検出のための道具であって、書き込みの契約そのものではない。

---

## 決定 —— 公開面の形

### 1. `RestoreSupersededTarget` に `onlyMemoryIds?: MemoryId[]` を追加

```ts
export type RestoreSupersededTarget = {
  supersededById: MemoryId;
  onlyMemoryIds?: MemoryId[];
};
```

**既定（省略）は1バイトも変えない**——`onlyMemoryIds` を渡さない既存の呼び出しは、
この PR 以前と同じ「群全体」を対象にする。空配列を渡すと対象0件になる
（`id = ANY('{}')` は常に偽であるため、特別扱いのコードは要らない）。

**検討した代替案**: `target` を `{ supersededById } | { supersededById; onlyMemoryIds }`
の判別可能 union にする案は採らなかった——単純な optional field のほうが、
呼び出し側のコードが1行変わるだけで既存の呼び出しを壊さない。

### 2. `MemoryStore.restoreSupersededBy?`/`previewRestoreSupersededBy?` に末尾の任意引数

```ts
restoreSupersededBy?(
  ctx: Ctx,
  supersededById: MemoryId,
  event: { reason?: string; actor?: EventActor; at: Date },
  filter?: { onlyMemoryIds?: MemoryId[] },
): Promise<{ restored: Memory[] }>;

previewRestoreSupersededBy?(
  ctx: Ctx,
  supersededById: MemoryId,
  filter?: { onlyMemoryIds?: MemoryId[] },
): Promise<{ candidates: Array<{ memoryId: MemoryId; supersededReason: string | null }> }>;
```

⛔ **第2引数を `{ supersededById; onlyMemoryIds? }` という構造化した1つの target に
変える案は採らない**——それだと第2引数の**型そのもの**を `MemoryId`（文字列）から
object へ変える必要があり、`supersededById` をそのまま SQL テンプレートへ埋めている
既存実装（`packages/postgres` 自身がそうである）を壊す。「末尾に任意引数を足す」
形は、TypeScript のメソッド構文の下で、その引数を受け取らない既存実装が
そのまま型として合法であり続ける。

### 3. `groupSupersededCandidatesByOperation`（任意の補助純関数）を追加

```ts
export type SupersededOperationGroup = {
  supersededReason: string | null;
  memoryIds: MemoryId[];
  boundaryConfidence: "structural" | "per_item" | "unknown";
};

export function groupSupersededCandidatesByOperation(
  candidates: ReadonlyArray<{ memoryId: MemoryId; supersededReason: string | null }>,
): SupersededOperationGroup[];
```

**検出だけである。書き込みには一切触れない**（ADR 0223 決定2）。呼び出しは
任意——`Runtime.restoreSuperseded` の必須経路には組み込んでいない。

### 4. `MemoryStoreConformanceOptions.supportsOnlyMemoryIdsFilter?: boolean`（任意）

```ts
export interface MemoryStoreConformanceOptions {
  // ...既存の8本の必須フラグ...
  supportsOnlyMemoryIdsFilter?: boolean;
}
```

#### ⛔ なぜ任意にしたか —— PR #524 の前例を繰り返さない

[PR #524](https://github.com/takecchi/mnemora/pull/524) は
`MemoryStoreConformanceOptions.supportsPreviewRestoreSupersededBy` を**必須**
フィールドとして足した。これは `@mnemora/testkit`（`PUBLISH_TARGETS` 6本の1つ・
非 private・出荷済み）を使ってこの適合テストを呼び出す既存の第三者コードに
対して**破壊的**であり、ADR 0237 冒頭の訂正（[PR #526](https://github.com/takecchi/mnemora/pull/526)）
がこれを「承知のうえで破壊的変更を選んだ」と訂正するに至った。

**この新しいフラグでは、同じ轍を踏まない。** 必須にすると、`onlyMemoryIds`
フィルタに対応するかどうかを誰も申告していない既存の第三者 adapter の
`MemoryStoreConformanceOptions` オブジェクトリテラルがコンパイルエラーになる
——同じ形の破壊を、今度は「訂正」ではなく最初から避ける。

#### ⭐ ただし「省略可にすると検査していないのに緑を許す」問題は放置しない

**この repo に既にある2つの前例を組み合わせた**（新しい形を発明する前に、
既存の形に倣った）:

1. **既存の8本の必須フラグが `false` のとき**、`it.skip` にはせず
   `expect(store.xxx).toBeUndefined()` を積極的に assert する形
   （`memory-store-conformance.ts` 各所）。
2. **`docs/decisions/0015-root-test-gate-reports-skipped-db-tests.md`** の核心
   ——「困っていたのは走らなかったことではなく、**走らなかったことが走って
   通ったことと区別できないこと**」。直すべきは実行範囲ではなく**門が報告する
   内容**である。

⟹ 3状態を、それぞれ別の顔にする:

| `supportsOnlyMemoryIdsFilter` | 走る歯 | 意味 |
|---|---|---|
| `true` | 契約の歯本体 | **検査した緑** |
| `false` | 「渡しても無視される」ことを積極的に assert する歯 | **検査した緑**（実装していないことを確認） |
| **省略** | ⛔ `it.skip` ではなく、**常に実行され常に緑で終わる named it** を1本——テスト名の文字列自体が「⚠ 未検査: supportsOnlyMemoryIdsFilter が指定されていない……」と名乗る | **検査していない** |

`it.skip` を避けた理由: `it.skip` は vitest の要約で「skipped」件数に紛れ、
**他の理由での skip**（`maybeIt` による自動 skip、`docs/conformance.md` §3 の
env gate 系 skip）と区別が付かなくなる。対して、常に実行され常に緑で終わる
named it は、**test 名の文字列そのものが唯一の情報を運ぶ**——CI のログ・
`vitest run` の出力・GitHub Actions の summary のどれを見ても、この名前が
そのまま出る。

---

## 実装

- `packages/core/src/runtime.ts`:
  - `RestoreSupersededTarget.onlyMemoryIds?: MemoryId[]` を追加。
  - `SupersededOperationGroup` 型と `groupSupersededCandidatesByOperation` 関数を追加。
  - `restoreSuperseded` の実装（`dryRun` 分岐・実際に戻す分岐の両方）で
    `target.onlyMemoryIds` を `filter: { onlyMemoryIds }` として素通しする。
- `packages/core/src/interfaces/memory-store.ts`: `restoreSupersededBy?`/
  `previewRestoreSupersededBy?` に `filter?: { onlyMemoryIds?: MemoryId[] }` を追加。
- `packages/postgres/src/memory-store.ts`: 両メソッドの `target` CTE に
  `AND id = ANY(${sql.param([...filter.onlyMemoryIds])}::uuid[])`（`filter?.onlyMemoryIds`
  が在るときだけ）を1行足す。**`digestBand.excludeMemoryIds`（本ファイル、
  `aggregateScope` 実装）の除外方向の同型パターンを、包含方向（`NOT` を外す）に
  転用しただけ**——新しい仕組みではない。

  **新しい索引・マイグレーションは1本も要らない**——現物で確認した:
  - `idx_memories_superseded_by`（`packages/postgres/migrations/0001_init.sql:120-122`、
    `ON memories (tenant_id, superseded_by_id) WHERE superseded_by_id IS NOT NULL`）が
    `tenant_id`/`superseded_by_id` の絞り込みを今日どおり担う。
  - `memories.id` は `PRIMARY KEY`（同ファイル:53）——追加した `id = ANY(...)` は
    この暗黙の一意索引の上に乗るだけである。
  - 【実測】まっさらな `initdb` 専用インスタンスに `0001`〜`0018`（18本、変更なし）を
    通しで適用し、エラー無く完了した。
- `packages/testkit/src/__fixtures__/in-memory-memory-store.ts`・
  `packages/core/src/__tests__/runtime-fakes.ts`: 両メソッドに同じ意味の
  積集合フィルタを実装。
- `packages/testkit/src/memory-store-conformance.ts`:
  `supportsOnlyMemoryIdsFilter?: boolean` と、3状態の分岐（上記）を実装。
- `packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts`・
  `packages/postgres/src/__tests__/conformance.postgres.test.ts`: どちらも
  `supportsOnlyMemoryIdsFilter: true` を渡す（この2つの adapter は「検査した緑」）。
- `packages/core/src/__tests__/resolve-contested-loser-invariant.test.ts`（新規）:
  条件1の歯（上記「不変条件」節）。
- `packages/core/src/__tests__/superseded-operation-grouping.test.ts`（新規）:
  `groupSupersededCandidatesByOperation` の歯（`structural`/`per_item`/`unknown` の
  3分岐、混在入力、空入力）。
- `packages/core/src/__tests__/restore-superseded.test.ts`:
  `target.onlyMemoryIds` の Runtime レベルの歯（積集合になる・省略時は従来どおり・
  `dryRun` との組み合わせ・空配列・群に含まれない id）。
- [`docs/memory-model.md`](../memory-model.md) 行15への追記（本 ADR を指す）。
- [`docs/conformance.md`](../conformance.md) §9（新設）: 3状態の適合フラグの一般形。
- [`docs/decisions/0230-restore-superseded-recovery-path.md`](./0230-restore-superseded-recovery-path.md)
  訂正4: `reextract` の行も「1回の操作と一致する」が偽だったことの追記
  （本 ADR とは独立した事実の記録——実装は変えない）。

---

## 破壊的変更かどうか

⚠ **自己申告で済ませない**——[ADR 0230](./0230-restore-superseded-recovery-path.md)と
[ADR 0237](./0237-restore-superseded-dry-run-preview.md)が2回とも自己申告を誤った
（0230 は必須メンバ追加を一度も申告せず、0237 は本文が自己矛盾していた）前例がある。
⟹ **`node scripts/check-public-api-surface.mjs` による公開 API の実 diff で
機械的に裏取りした。**

【実測 2026-09-21】6つの publish 対象パッケージ全てを `pnpm run build` した後、
`node scripts/check-public-api-surface.mjs` を実行:

```
[@mnemora/openai] 差分なし
[@mnemora/anthropic] 差分なし
[@mnemora/local-embedding] 差分なし
✗ 違反が 3 件見つかりました
[@mnemora/core] 公開型シグネチャが snapshot と一致しません。
[@mnemora/testkit] 公開型シグネチャが snapshot と一致しません。
[@mnemora/postgres] 公開型シグネチャが snapshot と一致しません。
```

**差分3件の中身**（unified diff から）:

- `@mnemora/core`: `MemoryStore.restoreSupersededBy?`/`previewRestoreSupersededBy?`
  へ `filter?: { onlyMemoryIds?: MemoryId[] }` が**追加**。`RestoreSupersededTarget`
  へ `onlyMemoryIds?: MemoryId[]` が**追加**。新しい型 `SupersededOperationGroup` と
  新しい関数 `groupSupersededCandidatesByOperation` が**追加**。
- `@mnemora/testkit`: 上記と同じ `filter?` の**追加**。
  `MemoryStoreConformanceOptions.supportsOnlyMemoryIdsFilter?: boolean` が**追加**
  （`?` 付き＝任意）。
- `@mnemora/postgres`: 上記と同じ `filter?` の**追加**。

**削除された・型が狭まった・必須化されたメンバは0件。** すべて末尾の任意引数、
任意プロパティ、または新しい型・関数の追加のみである。

**`SupersededOperationGroup`/`boundaryConfidence` を分岐する網羅的 `switch`
が出荷対象パッケージに存在しないことも確認した**（【実測】`rg -n "switch"
packages/core/src packages/postgres/src packages/openai/src packages/anthropic/src
packages/local-embedding/src packages/testkit/src` の結果に、この型・
`RestoreSupersededOutcome` を分岐する箇所は無い——ADR 0117/`event.ts` が
`MemoryEventKind` について行った確認と同じ手順）。

⟹ **追加のみであり、破壊的変更ではない。** `check-public-api-surface.mjs --write`
で snapshot を更新済み。

---

## 測ったこと

すべてこのブランチの HEAD で、この作業者自身が実行した。

- `pnpm run typecheck`（`pnpm -r --if-present run typecheck`、全8ワークスペース）—— 成功。
- `pnpm run lint` —— 成功（差分無し）。
- `pnpm run format:check` —— 3ファイルの整形漏れを `prettier --write` で直した後、成功。
- `pnpm --filter @mnemora/core exec vitest run`（core 全体）—— **937件成功**（67ファイル）。
- `pnpm --filter @mnemora/testkit exec vitest run`（testkit 全体）—— **344件成功・1件skip**
  （既存の skip で本 PR とは無関係）。
- **本物の Postgres 17 + pgvector**（`initdb` で自分専用インスタンス、既定の5432を
  使わず専用ポートを割り当て、`AGENTS.md`「手元で Postgres を立てる」手順どおり）:
  - `pnpm --filter @mnemora/postgres run migrate` —— 18本のマイグレーションが
    まっさらな DB へ適用済み（`0018_memory_events_kind_unsuperseded.sql` まで、
    新しいマイグレーションは0本）。
  - `pnpm --filter @mnemora/postgres run test:db`（フルセット）—— **595件成功**
    （55ファイル、約413秒）。⚠ **1回目の実行**では、この作業者自身が同時に別の
    `-t` 絞り込み実行を同じ DB に対して走らせてしまい、無関係なテスト
    （`count-over-window.test.ts`）が外部キー違反で1件だけ落ちた——**同時実行を
    止め、単独で走らせ直したところ595件全て成功した**。単独再実行でも
    その1件だけを切り出して実行し、2/2成功することを確認済み——この失敗は
    本 PR の変更とは無関係な、自分自身の同時実行が原因の見せかけの赤である。
  - `pnpm --filter @mnemora/postgres exec vitest run src/__tests__/conformance.postgres.test.ts
    -t "onlyMemoryIds"` —— **6件成功**（`onlyMemoryIds` 系の歯のみを絞って実行）。
- `node scripts/check-public-api-surface.mjs`（`pnpm run build` を先に実行してから）——
  差分は上記の追加のみであることを確認し、`--write` で snapshot を更新した。

### 変異試験（`docs/autonomy.md` §2、`cp` で退避・復元）

1. **Postgres・`restoreSupersededBy` の `onlyMemoryIds` 節を無効化**（`AND id = ANY(...)`
   を常に空にする）→ `restoreSupersededBy に onlyMemoryIds を渡すと、その積集合だけが
   戻る`・`空配列の onlyMemoryIds を渡すと対象0件になる`・`restoreSupersededBy と
   previewRestoreSupersededBy は…同じ対象を選ぶ` の3本が**赤**（積集合ではなく群全体が
   戻った）。`cp` で復元 → 同じ3本が**緑**に戻ることを確認。
2. **Postgres・`previewRestoreSupersededBy` の `onlyMemoryIds` 節だけを無効化**
   （`restoreSupersededBy` 側は残す）→ `previewRestoreSupersededBy に onlyMemoryIds を
   渡すと…返す`・パリティの歯の2本が**赤**。`cp` で復元 → **緑**に戻ることを確認。
3. **Core・`resolveContested` の `buildSide` を変異**（`id === resolution.winnerId` の
   判定を常に偽にし、`kind:'supersede'` で両側が `superseded` になるようにする）→
   条件1の歯（不変条件）3本中2本（「ちょうど1件」を確認する2本）が**赤**
   （増分が1ではなく2になった）。`kind:'both_active'` の歯は影響を受けず**緑**の
   まま——`'supersede'` に固有の不変条件であることの裏付けにもなった。`cp` で復元 →
   3本とも**緑**に戻ることを確認。
4. **Core・`groupSupersededCandidatesByOperation` を変異**（`boundaryConfidence ===
   "unknown"` の候補も1件ずつに分割するようにする）→ `reextract_superseded`/`null`
   をまとめて返すことを確認する2本が**赤**（1件ずつの配列になった）。`cp` で復元 →
   **緑**に戻ることを確認。
5. **`supportsOnlyMemoryIdsFilter` の「未検査」named it**: 実際に既存の呼び出し
   （`in-memory-fixtures.conformance.test.ts`）から `supportsOnlyMemoryIdsFilter: true`
   を一時的に外し、`vitest run … -t "未検査" --reporter=verbose` で
   `⚠ 未検査: supportsOnlyMemoryIdsFilter が指定されていない — adapter "in-memory
   placeholder" に対して onlyMemoryIds フィルタの歯は検査していない` という named it が
   実際に1本登録され、**緑**で終わることを確認した。元に戻して
   `supportsOnlyMemoryIdsFilter: true` の6本が改めて緑になることも確認した。

**すべて `cp` で退避・復元し、`git status --porcelain` が変異前後で空/元どおりで
あることを確認した**（`git checkout` は使っていない）。

---

## これが覆るとしたら

- **`reextract` のアンカー選定が「常に新規作成される」よう変わったとき**——
  そのときは `reextract_superseded` を `"structural"` へ格上げできる。ただし
  それ自体が `reextract` の出荷済みの挙動を変える別の判断であり、この ADR は
  それを決めない（下記「確かめていないこと」）。
- **`resolveContested` が2件以上を同時に解決する形へ拡張されたとき**——
  `resolve-contested-loser-invariant.test.ts` の歯が赤くなる。そのときは
  `contested_resolved` を `"per_item"` のままにできない。
- **方向2（`memory_events` への操作 id 新設）が将来採られたとき**——①はそれと
  排他ではない。①が入れた `onlyMemoryIds`/`groupSupersededCandidatesByOperation`
  は、鍵が増えても引き続き使える汎用の絞り込み・グルーピング機構である。

## 確かめていないこと

- **非アトミック経路（`MemoryStore.supersedeWithNewMemories?`/`resolveContestedPair?`
  を持たない adapter）での `reextract`/`resolveContested` の挙動は実測していない。**
  コード上はアトミック経路・非アトミック経路の両方が同じ「位置でアンカーを選ぶ」
  構造を持つため同型のはずだが、この作業では確認していない——この2つの任意メソッドを
  持たない adapter をこの PR のために新しく用意しなかったため。
- **R2（`reextract` のアンカー選定を `created === true` の候補優先に変える案）の
  実装費用と、「全候補が既存解決になる」縮退ケースは測っていない。** この ADR では
  実装しない——出荷済みの `reextract` の挙動を変えるうえ、縮退ケースが未検証で
  あるため。
- **`memory_events.at` の衝突を意図的に短い間隔で作る実験はしていない。**
  「同じ呼び出し内の書き込みは同じトランザクションの `now()` を共有しうる」という
  ヒューリスティック（R4 案）自体をこの ADR は採らない——採らない理由も含め、
  Issue #515 への報告コメントで既に「死んでいる」と記録されている
  （マネージャーからの伝聞【受】: Postgres は同一操作の2敗者が3〜5msずれて
  不一致、インメモリは30回連続で回すとuniqueが3個。この作業者自身は再現していない）。
- **大きな群（数千件規模）での `onlyMemoryIds` フィルタの性能は測っていない。**
  ADR 0237 が残した同じ「確かめていないこと」を、この ADR も引き継ぐ——絞り込みが
  効けば走査対象は減るはずだが、配列が大きい場合のコストは別途未測定。
- **`reextract` の非アトミック/アトミック両経路が同じ「同じアンカーの共有」を
  起こすかは、両 adapter の実測でしか確認されていない**——この作業者自身は
  再現していない（【受】、ADR 0230 訂正4参照）。

---

## 追記（2026-09-26、[Issue #821](https://github.com/takecchi/mnemora/issues/821)）: 保持期間の掃除が、この ADR の判断材料を経年劣化させる

クローン miku の委譲先が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**上の本文（決定・却下した案・これが覆るとしたら・確かめていないこと）は書き換えていない。**当時の記録として残す。
コード（`packages/*/src`）の挙動は変えていない——この追記は記録だけである。

**この ADR の①（`onlyMemoryIds`/`groupSupersededCandidatesByOperation`）は、
`MemoryStore.previewRestoreSupersededBy?` が返す `supersededReason` を判断材料にする。**
その `supersededReason` は `kind: 'superseded'` の `memory_events` 行の `meta.reason` を
読むだけであり、この ADR も [ADR 0237](./0237-restore-superseded-dry-run-preview.md) も、
その `memory_events` 行がいつまでも残り続けることを前提にしていた——**どちらの ADR も、
[ADR 0115](./0115-event-retention-purge.md) の `MemoryStore.purgeExpiredEvents?` が
`memory_events` を保持期間で削除することを一度も検討していない**
（`grep -n "previewRestoreSupersededBy\|restoreSuperseded" 0115-event-retention-purge.md`・
`grep -n "retention\|purgeExpiredEvents" 0258-restore-superseded-operation-scope.md`
は、Issue #821 が本 PR 以前に確認した時点でどちらも0件だった）。

**実測（Fake、`packages/core`、Issue #821 本文）**: `consolidate` の敗者 A（`meta.reason:
'consolidated'`）と `resolveContested` の敗者 B（`meta.reason: 'contested_resolved'`）を
同じ勝者 W の下に作る。掃除前は `previewRestoreSupersededBy(ctx, W)` が2件を別々の
`supersededReason` で返し、`groupSupersededCandidatesByOperation` は正しく
`"structural"` グループと `"per_item"` グループに分ける。`purgeExpiredEventsForTenant`
（保持期間30日、`now` を60日後にずらす）を挟むと、A・B どちらの `superseded` イベントも
削除され（`purged: 2`）、掃除後は両方とも `supersededReason: null` になり、
`groupSupersededCandidatesByOperation` は**A と B を1つの `"unknown"` グループへ
まとめる**。このグループをそのまま `restoreSuperseded` の `onlyMemoryIds` へ渡すと、
本来は `consolidate` の取り消しのつもりで A だけを戻したかった呼び出しが、無関係な
`resolveContested` の敗者 B まで一緒に戻してしまう。

**クローン miku の判断（2026-09-26）**: 挙動は変えず、この相互作用を4箇所の doc コメント
（`RestoreSupersededTarget.onlyMemoryIds`・`groupSupersededCandidatesByOperation`・
`MemoryStore.previewRestoreSupersededBy?`・`MemoryStore.purgeExpiredEvents?`。いずれも
`packages/core/src`）と `docs/memory-model.md` §9・本 ADR・ADR 0115・ADR 0237 に明記する
に留めた（Issue #821 が挙げた方向4）。

**採らなかった案**:
1. **`purgeExpiredEvents` が `kind = 'superseded'` を対象から除外する。** 却下——
   ADR 0115 決定1・`docs/memory-model.md` §9 が約束する「保持期間を超えたイベントは
   種類を問わず本当に消える」という契約の意味を変える、公開の振る舞い変更になる。
   この追記の範囲（委譲された記述のみ）を超える。
2. **`RestoreSupersededOutcome`/`SupersededOperationGroup` に「由来が最初から無いのか、
   掃除で消えたのか」を区別する第三の値を足す。** 却下——公開型の拡張であること自体は
   小さいが、**「消えた」ことを機械的に見分ける手段が無い**（`memory_events` に一致する
   行が無いことしか観測できず、それが保持期間の掃除によるものか、そもそも記録されな
   かったものかを、現在のスキーマは区別しない）。区別を型に持たせても、実装がその型を
   正しく埋められない。

反映先: `packages/core/src/runtime.ts` の `RestoreSupersededTarget.onlyMemoryIds`・
`groupSupersededCandidatesByOperation`、`packages/core/src/interfaces/memory-store.ts` の
`previewRestoreSupersededBy?`・`purgeExpiredEvents?`、`packages/core/src/event-retention-purge.ts`
の `purgeExpiredEventsForTenant`、`docs/memory-model.md` §9（保持方針）。
