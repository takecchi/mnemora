# ADR 0310: taxonomy の語彙管理（labels / memory_labels）を任意の追加として実装する — PR-A: migration・書き込み経路・語彙 API（Issue #201）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手、
> セッション id `mgr-dc38f2b1`）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0246 / ADR 0282 / ADR 0289 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `git` / `vitest` / `psql` / `pnpm` を走らせて確かめた。
- **【受】** — 報告・Issue コメントとして受け取り、再導出していない（出所を明記する）。

断りの無い【現物】【実測】は `origin/main` = `d4c4363`（本作業の分岐点）の木、および本
ブランチ（`feat/201-taxonomy-labels`）上で、2026-09-25 に行った。

---

## 射程 — 本 ADR は PR-A と PR-B の両方の設計を決めるが、実装するのは PR-A だけ

マネージャーの指示により、本 ADR は taxonomy 全体（PR-A: 保存・語彙、PR-B: recall 側の
絞り込み）の設計を1本で決める。**このブランチが実装するのは PR-A だけである。** PR-B
（`labels` を使った recall の絞り込み・`taxonomy_mode: 'strict'` が実際にフィルタへ効く
経路・`GroupCount.axis: 'taxonomy'` の生成）は別 PR として後日出す。「PR-B に向けた申し送り」
節に見立てを書く。

## 文脈

### Issue #201 とこれまでの棚卸し

[Issue #201](https://github.com/takecchi/mnemora/issues/201) は「taxonomy の strict/open
（`labels`/`memory_labels`）が Phase 2 に送られたまま、型だけが `packages/core/src/recall.ts`
に残っている」という棚卸しから始まった。過去2回の棚卸しコメントはどちらも判定
**C（いつか、優先度の判断）**で止め、実装するかどうかはオーナー判断に委ねていた。直近の
コメント（本セッションの前段）で「着手する（案(1): taxonomy を任意の追加として実装する）」
と決め、本 ADR がその設計を確定する。

### 【現物】着手前の状態（`origin/main` = `d4c4363`）

- `packages/core/src/recall.ts` の `FilteredOmission.condition: "taxonomy"` と
  `GroupCount.axis: "subject" | "taxonomy"` は型として存在するが、生成するコードが
  0件（`packages/core/src/__tests__/unreachable-union-values.test.ts` が機械的に見張って
  いる分類）。
- `labels` / `memory_labels` テーブルは全19本（当時18本）の migration のどこにも無い。
  `0001_init.sql:6` の冒頭コメントが「Phase 2 のテーブルはここに含めない」と明記。
- `tenant_settings.taxonomy_mode`（`open`|`strict`、既定 `'open'`、
  `0001_init.sql:223`、`schema.ts:167`）は列として存在するが、読む側が
  `TenantSettingsStore` interface 自身の doc で「本 interface の範囲外」と明記されている
  ——0件。
- `docs/memory-model.md` §8 は、labels/memory_labels の SQL 案・`registered`/`proposed` の
  状態遷移・strict/open の意味論を、設計としては完全に書いている（未確定なのは設計では
  なくスケジュール）。

### `GroupCount.axis: "taxonomy"` は既に公開 union に在る ⟹ 追加しても union は広がらない

**⭐ 重要な事実確認。** `FilteredOmission.condition` にも `GroupCount.axis` にも
`"taxonomy"` という値は**既に**型として存在する（上記）。したがって、本 ADR・PR-B が
実際にこの値を生成するようにしても、**公開 union に新しい値を足すことにはならない**
——[Issue #541](https://github.com/takecchi/mnemora/issues/541)（判別可能ユニオンへの値の
追加を破壊的変更として扱うかどうかの整理）に依存しない。増えるのは「この値が実際に
生成される経路」であって、「この値という選択肢」ではない。

### Issue #152/#153（呼び手の属性）とは別設計 ⟹ 混ぜない

**⚠ 2026-09-25 訂正・拡充**: 本節は当初【受】として「`attributes` はフィルタにも加点にも
使わない」と書いていたが、これは PR #724（Issue #152/#153、`packages/core/src/attributes.ts`、
本稿執筆時点ではまだ `main` に未着地）の確定した設計と食い違っていた——PR #724 の
[ADR（`docs/decisions/0310-observe-recall-caller-attributes.md`、PR #724 のブランチ上）]
(https://github.com/takecchi/mnemora/pull/724) 決定5は、**`attributes` を段1（ANN・語彙・
連想の3チャンネル）へ AND 等値の絞り込みとして押し下げる**——「フィルタに使わない」は
誤りだった。本節はその訂正を反映する（本 ADR 自身がまだ採用前の初稿であるため、
書き換えて良い——ADR 0223 決定1「まだ採用されていない初稿はこの限りではない」）。

PR #724 の決定8が確定した3本の役割分担の表（逐語ではなく本 ADR の言葉で写す。
`tags`/`labels` の記述は本 ADR の決定と一致することを確認済み）:

| 軸 | 何を入れるか | 誰が値を決めるか | 段1（候補生成）に参加するか |
|---|---|---|---|
| `tags`（Phase 1、既存） | 話題・内容の要約 | **100% LLM の推論**（抽出プロンプトは語彙・粒度を指示しない） | ⛔ しない（段2の加点のみ、`tagMatch`） |
| `attributes`（PR #724、Issue #152/#153） | 公開範囲・区分などの**宣言された属性** | **100% 呼び手の申告**。mnemora は値の意味を解釈しない | ⭕ する（AND 等値の絞り込み。`RecallQuery.attributes?`） |
| `labels`/`memory_labels`（本 ADR、Issue #201） | **統制語彙**（テナントが登録した語彙に `tags` が当たるかどうか） | **repo（スキーマ）が定める状態（`registered`/`proposed`）に、既存の `tags` の値が当たる** | PR-A（本 PR）は不参加。PR-B で「ラベルでの絞り込み」を足す予定（strict/open の分岐はここにだけ効く。「決定5」参照） |

⟹ **3本とも「誰が値を決めるか」が違う——LLM の推論（`tags`）／呼び手の申告
（`attributes`）／repo が定める統制語彙への適合（`labels`）。統合すると、この区別
（北極星の問い4「AI の推論と、ユーザーが言った事実を、区別しているか」）を捨てることに
なる。** ⟹ **ラベルは `attributes` から作らない**（`attributes` は 100% 呼び手申告であり
LLM の推論ではないため、taxonomy の語彙登録が想定する「テナントが `tags` の語彙に対して
`registered`/`proposed` を決める」という枠に馴染まない）。**`attributes` は語彙登録の
対象にしない**（`registerLabel?` は `labels` テーブルのみを操作し、`attributes` を
読み書きしない）。2つの機構は保存先・migration・検索への関与のしかたが全部独立している
——同じ PR・同じテーブルに混ぜない。

**PR 間の整合について（マネージャー指示、2026-09-25）**: PR #724 が `main` へ着地した後、
本 PR は `main` を取り込んで migration 番号（`0019` は PR #724 が
`observations_memories_attributes` として使用済みのため、本 PR の migration は
`0020_taxonomy_labels.sql` へ付け替えた）と ADR 番号を再度確認する。`docs/memory-model.md`
§8 に PR #724 が同じ3本の役割分担の表を追記する見込みであり、本 PR がそこへ重複した
表を追記しないよう、取り込み時に突き合わせて調整する（下記「決定7」参照）。

### ADR 0289 が確立した「任意の追加は非破壊」という数え方を踏む

[ADR 0289](./0289-recalled-memory-speaker-subject.md) は `docs/migration-v1.md` の数え方
（返り値の型に**必須**フィールドが増える形だけが破壊的変更で、**任意**フィールドの追加は
非破壊）を確認し、`RecalledMemory.speaker?`/`subjectId?` を任意欄として実装した。本 ADR は
同じ数え方を、**フィールドだけでなく interface のメソッドにも**適用する——
`MemoryStore`/`TenantSettingsStore` は既に `archiveDecayed?`/`purgeMemory?`/
`markContestedPair?`/`getDecayClock?`/`setDecayClock?` のような**任意メソッド**を何本も
持っており（`@mnemora/core` が npm 公開済みで、必須化すると外部 adapter を壊すため。
ADR 0100 決定1・ADR 0165 決めたこと13 が繰り返し確立した理由）、本 ADR が足す
`listLabels?`/`registerLabel?`/`getTaxonomyMode?`/`setTaxonomyMode?` もこの列に並ぶ。

---

## 決定

### 1. migration `0020_taxonomy_labels.sql` — `docs/memory-model.md` §8 の SQL 案をそのまま採用

`labels`（`id`/`tenant_id`/`name`/`status`/`proposed_count`/`registered_at`/`created_at`、
`UNIQUE (tenant_id, name)`）と `memory_labels`（`tenant_id`/`memory_id`/`label_id`、
複合 PK）を作る。§8 の案からの追加は2つの索引だけ:

- `idx_labels_by_status (tenant_id, status)` — `listLabels?` の「状態で絞って一覧する」
  ため。`UNIQUE (tenant_id, name)` は等値検索にしか効かない。
- `idx_memory_labels_by_label (tenant_id, label_id)` — PR-B が「この label を持つ
  memory_id の集合」を引くための、逆方向の索引。複合 PK
  `(tenant_id, memory_id, label_id)` は「この Memory のラベル一覧」には効くが逆は効かない。
  **PR-A 自身はこの索引を使う読み出しを実装していない**——先取りで足すだけである。

既存 `memories.tags` からの **backfill を含める**（roadmap.md §3 の「未登録のラベルは
既に `proposed` として記録されている」という記述が、`labels` テーブルが存在しない時点
では成り立っていなかったため——「決めたこと」7 で訂正する）。`unnest(tags)` で
`(tenant_id, tag)` ごとに件数を数えて `proposed` ラベルを作り、`memory_labels` を
`DISTINCT` で張る。

【実測】手元の Postgres（`initdb` で自分専用に起動、PostgreSQL 17）で、既存データが
在る状態を模して確認した:

```
tenant-x に4件の Memory: tags=[alpha,beta] / [alpha] / [alpha,alpha,gamma] / (tenant-y, tags=[])
→ labels: alpha(proposed_count=4) / beta(1) / gamma(1)
→ memory_labels: 5行（(mem3,alpha) の重複タグは DISTINCT で1行に潰れる）
→ tenant-y（tags=[]）には labels/memory_labels が1行もできない
```

**⚠ `proposed_count` は同一 Memory 内の重複タグを潰さずに数える**（`unnest` が展開した
ままを `count(*)` する）。書き込み経路（下記「決定2」）は `Set` で1 Memory あたり1回に
潰して数えるため、**backfill とその後の増分で数え方が完全には一致しない**——起動時点の
近似値を揃えるだけであり、厳密な一意カウントを契約しない（`0020_taxonomy_labels.sql`
本文と `LabelSummary.proposedCount` の doc コメントに明記した）。

### 2. 書き込み経路 — 新しい interface メソッドを増やさず、既存3メソッドの内部実装に足す

**この決定が本 ADR で最も議論の余地がある選択なので、理由を厚く書く。**

`tags` は Memory の**作成時にしか書けない列**である（【実測】`grep -rn "\btags\b"
packages/` で全経路を確認——`packages/postgres/src/memory-store.ts` の `tags` への書き込みは
3箇所すべてが `INSERT`、`UPDATE` は0件。抽出・統合・省察はいずれも「新しい Memory を
作る」形であり、既存行の `tags` を書き換える経路は無い）。したがって「`tags` から
`proposed` ラベルを作る」契機は次の3メソッドの**新規挿入が実際に成功したとき**だけである:

- `PostgresMemoryStore.createMemory`
- `PostgresMemoryStore.createMemoryWithOutbox`
- `PostgresMemoryStore.supersedeWithNewMemories`（`news` の各要素）

**同一トランザクションが要る**——Memory の INSERT が成功したのにラベルだけ失われる
（あるいはその逆）状態を作らないため。`createMemoryWithOutbox`/`supersedeWithNewMemories`
は既にトランザクションを開いているのでその中に相乗りさせるだけだが、**`createMemory`は
本 PR 以前はトランザクションを開いていなかった**（単発の `INSERT`、衝突時は単発の
`SELECT`）——本 PR がこのメソッドの実装をトランザクションで包む形に変えた。**返す値・
呼び出し側から見える契約は1バイトも変えていない**（`created`/`existing` の分岐、
`rowToMemory` の呼び方は本 PR 以前と同一。トランザクションで包んだのは実装の都合であり、
公開契約の変更ではない）。

**なぜ新しい `MemoryStore` interface メソッド（例: `attachLabelsForTags`）を増やして
呼び出し側から明示的に呼ばせる形にしなかったか**:

1. **呼び出し側にこの配線を強制すると、既存の呼び出し経路（`runtime.ts` の
   `handleExtractableObservation`・`createMemoriesFromCandidates`・`consolidate`/
   `reflect` の書き戻し）**全部**に新しいステップを差し込む必要が生まれる。**1バイトも
   変えない**という制約（マネージャー指示）に対して、内部実装（3つの既存メソッドの
   中身）だけを変える方が変更点が狭い。
2. **「ラベル＝`tags` に語彙状態を持たせたもの」という設計そのもの**（マネージャー指示
   の境界）が、ラベルの発生をタグの書き込みに**構造的に従属させる**ことを要求している
   ——「`tags` を書いたのに `labels`/`memory_labels` が付いてこない」という状態は、
   任意メソッドの呼び忘れで起こりうる不整合であってはならない。書き込み経路の内部に
   埋め込むことで、**呼び忘れという分岐自体を無くす**。
3. 一方で、`MemoryStore` を実装する**第三者の adapter**（`@mnemora/core` は npm 公開済み）
   はこの自動生成の恩恵を受けない——`createMemory` 系を独自実装する adapter は、
   labels/memory_labels 相当の何かを自分で用意しない限り `listLabels?`/`registerLabel?`
   を実装できない（あるいは実装しても空のまま）。**これは許容する**——`listLabels?`/
   `registerLabel?` 自体が任意メソッドである以上、実装しない adapter は「この機能が無い」
   という今日と同じ状態にとどまるだけであり、既存の契約を壊さない。

**In-Memory adapter（`packages/testkit`）も同じ意味論**——3つの生成経路
（`createMemory`/`createMemoryWithOutbox`/`supersedeWithNewMemories`）は全て
`createMemoryIdempotent` という1つの private メソッドを通る（【現物】既存コードが
既にこの形——ADR 0054 の「判定と挿入を1つの同期区間に閉じる」規律を守るための構造）。
この「新しい行を実際に作った」分岐1箇所に `upsertProposedLabels` を差し込むだけで
3経路すべてを覆える。

**`registered` に昇格したラベルは、以後 `tags` に使われても `proposedCount` を進めない**
——`docs/memory-model.md` §8「`proposed` として記録され...将来 `registered` へ昇格する
候補として表に出る」という筋から、`proposedCount` は「昇格の判断材料」であり、
昇格した後は判断材料としての意味を失う、という読みを採った（postgres 側は SQL の
`CASE WHEN labels.status = 'proposed' THEN 1 ELSE 0 END`、in-memory 側は同じ分岐を
TypeScript で再現。変異試験で両方向を確認——下記「測ったこと」）。

### 3. 語彙 API — `MemoryStore.listLabels?`/`registerLabel?`（任意メソッド）

`LabelSummary { name; status: 'registered' | 'proposed'; proposedCount: number;
registeredAt: Date | null }` を新設し、`MemoryStore` interface に

```ts
listLabels?(ctx: Ctx): Promise<LabelSummary[]>;
registerLabel?(ctx: Ctx, name: string): Promise<LabelSummary>;
```

を足す。**`archiveDecayed?`/`purgeMemory?`/`markContestedPair?` と同じ「🔴 任意メソッド
である」の理由**（必須にすると `@mnemora/core` を実装する第三者 adapter を壊す
破壊的変更になる）。

`registerLabel` は「まだ誰も `tags` に使っていない名前」も直接 `registered` として
作れる（`proposedCount: 0` で新規行）——「テナントが語彙として事前に登録する」運用
（§8 が想定する語彙管理）を妨げないため。既に `proposed` なら `registered` へ更新し
`registeredAt` を今にする。既に `registered` なら**冪等**（`registeredAt` を変えない）
——`COALESCE(labels.registered_at, now())` という1本の UPSERT でこの3分岐を表す。

**`MemoryStore` に置いた理由**（`TenantSettingsStore` や新しい独立の `LabelStore`
interface ではなく）: `labels`/`memory_labels` は `memories.tags` の派生であり、
`archiveDecayed?`/`purgeMemory?` 等の既存の「Memory 関連の補助操作」と同じ性質を持つ。
`EventStore` のように「別 adapter に分離する」設計も検討したが、`EventStore` は
`append`/`get`/`list` という append-only の独立した読み書きが必要なのに対し、
`listLabels?`/`registerLabel?` は Postgres 側では常に `PostgresMemoryStore` が既に
持つ同じ `Db` 接続を使うだけであり、分離する実益が無いと判断した（採らなかった案1参照）。

### 4. `tenant_settings.taxonomy_mode` の読み書き — `TenantSettingsStore.getTaxonomyMode?`/`setTaxonomyMode?`

`decay_clock`（ADR 0165 決めたこと13）と**完全に同じ形**で足す:

- `TaxonomyMode = "open" | "strict"`、`DEFAULT_TAXONOMY_MODE = "open"`
  （`tenant_settings.taxonomy_mode` の DB 側 DEFAULT と一致）。
- `getTaxonomyMode?(ctx): Promise<TaxonomyMode>` / `setTaxonomyMode?(ctx, mode):
  Promise<void>` を interface に足す（`?` 付き、理由は decay_clock と同じ）。
- `assertValidTaxonomyMode`/`TAXONOMY_MODE_INVALID_MESSAGE`/
  `TAXONOMY_MODE_UNSUPPORTED_MESSAGE`/`readTaxonomyMode`/`writeTaxonomyMode`
  を `packages/core` に持ち、**読み書きの唯一の通り道**にする
  （`readDecayClock`/`writeDecayClock` と同じ理由——省略時のフォールバックを
  呼び出し側に散らさない）。`readTaxonomyMode` は未実装 adapter で `'open'` へ倒す
  （既定と一致するので「未実装」でも今日と同じ挙動）。`writeTaxonomyMode` は未実装
  adapter で明示的に失敗する（`decay_clock` と同じ——「設定したのに効かない」を
  黙って許さない）。

**⚠ この読み書きの口を足した時点では、`taxonomy_mode` を実際に読んで何かを変える経路は
まだ存在しない。** PR-A はテーブル・読み書きの口だけを用意する——recall のフィルタ・
加点に反映するのは PR-B である。

### 5. 既存の `tagMatch` 加点は `taxonomy_mode` に関わらず今のまま——PR-A・PR-B とも変えない

**マネージャー指示、および `docs/memory-model.md` §8 との差分を明記する。** §8 の本文
（未訂正の原文）は「`strict` モードが変えるのは『`proposed` なラベルが検索の**フィルタ・
加点**に参加できるか』だけである」と書いている。**本 ADR はこの「加点」の側を実装しない
——今後 PR-B でも実装しない方針である。**

理由: `defaultScoringStrategy` の `tagMatch`（`docs/recall.md` §7・
`packages/core/src/strategies/scoring.ts`）は Phase 1 から**既に**`memories.tags` を
そのままスコアリングに使っている（`docs/memory-model.md` §8 の2026-09 訂正が既に
明記——「`tags` は段2の再スコアの加点要素として参加する。クエリタグとの一致数に応じて
`ScoreBreakdown.tagMatch` を押し上げる」）。**この既存の加点は `registered`/`proposed`
の区別を持たない**——`tags` の生の一致数だけを見る。ここへ `taxonomy_mode: 'strict'` の
分岐を割り込ませると、**strict なテナントの既存スコアが本 PR によって変わる**——
「既存の呼び出しの挙動・出力は1バイトも変えない」というマネージャー指示に真正面から
抵触する。

⟹ **strict が効くのは、PR-B で入る「ラベルでの絞り込み」という新しい任意入力
（例えば `RecallQuery.labels?: string[]` のような、呼び手が明示したときだけ働く口）
に対してだけである。** 既存の `tags`/`tagMatch` の経路は、taxonomy_mode の値に関係なく
今日と同じ計算をし続ける。

`docs/memory-model.md` §8 には、原文を書き換えずにこの差分を追記した（「文書の訂正」節
参照）。

### 6. In-Memory と Postgres の意味論の一致——テストで固定した箇所

`packages/testkit` の適合テスト（`supportsLabels: true`）が両 adapter に対して次を
検査する（【実測】両方で green、下記「測ったこと」）:

- `tags` を持つ Memory を作ると、同名の `proposed` ラベルが自動でできる。
- 同じ tag を複数 Memory へ使うと `proposedCount` が積み上がる。
- 1 Memory 内の `tags` の重複は1回だけ数える。
- `tags` が空なら何もできない。
- `registerLabel` で `proposed → registered` へ昇格でき、`proposedCount` は変わらない。
- `registerLabel` はまだ使われていない名前も直接 `registered` として作れる。
- `registerLabel` は冪等。
- `registered` 昇格後は、同じ名前を `tags` に使っても `proposedCount` が進まない。
- テナント分離。
- ラベルが1件も無いテナントには空配列（例外にしない）。

`TenantSettingsStore` の適合テスト（`supportsTaxonomyMode: true`）が
`getTaxonomyMode`/`setTaxonomyMode` の往復・既定値・不正値の拒否・他の列を壊さないことを
両 adapter に対して検査する。

### 7. 文書の訂正（本文は書き換えず、追記する）

- **`docs/roadmap.md` §3**: 「未登録のラベルは既に `proposed` として記録されている」
  という記述に、「PR-A 以前は `labels` テーブル自体が存在せず成り立っていなかった。
  PR-A（本 ADR）でテーブルと書き込み経路を作ったことで、初めてこの記述が成り立つ」
  という訂正を追記した。
- **`docs/memory-model.md` §8**: 「決定5」の差分（既存 `tagMatch` は `taxonomy_mode` の
  影響を受けない）を追記した。

---

## 採らなかった案

| 案 | 却下の理由 |
|---|---|
| **独立した `LabelStore` interface を新設する** | `EventStore`（append-only の独立した読み書き）とは性質が違う——`listLabels?`/`registerLabel?` は常に `PostgresMemoryStore` と同じ `Db` 接続・同じトランザクション境界を使うだけであり、分離すると呼び出し側（`packages/postgres` の配線）に adapter がもう1つ増えるだけで実益が無い。`MemoryStore` に置く既存の「補助操作は任意メソッドで足す」慣習（`archiveDecayed?` 等）に素直に従う方を採った。 |
| **`listLabels?`/`registerLabel?`/`getTaxonomyMode?`/`setTaxonomyMode?` を必須メソッドにする** | `@mnemora/core` は npm 公開済み。必須化すると第三者の `MemoryStore`/`TenantSettingsStore` 実装がコンパイルできなくなる（ADR 0100 決定1・ADR 0165 決めたこと13 と同じ理由）。 |
| **`tags` から labels を作る経路を、呼び出し側（`runtime.ts`）に明示的なステップとして追加する** | 「決定2」参照。呼び出し経路が複数（抽出・統合・省察）あり、全箇所に配線する変更点が、3つの既存メソッド内部に埋め込む変更点より広く、かつ「呼び忘れ」という新しい失敗分岐を作る。 |
| **`attributes`（#152/#153）から labels を自動生成する** | マネージャー指示で明示的に禁止。2つの機構は意味論が違う（「文脈」節の表）——`attributes` は mnemora が解釈しないことが設計の要であり、そこから mnemora が解釈する語彙を作ると設計が矛盾する。 |
| **既存 `tagMatch` に `taxonomy_mode: 'strict'` の分岐を今から入れる** | 既存スコアを変える破壊的変更になる（「決定5」参照）。 |
| **`proposed_count` を「いまこの名前を持つ生きた Memory の数」として厳密に保つ（Memory が forgotten/purged になったら減らす）** | Memory の状態遷移（`forgotten`/`archived`/`purged`）が起きるたびに `memory_labels`/`labels` を触る新しい書き込み経路が要り、既存のライフサイクル操作（`archiveDecayed?`/`purgeMemory?`等、いずれも任意メソッド）全部に配線が要る——PR-A の射程を大きく超える。「昇格の判断材料になる近似値」で十分という設計判断を、`LabelSummary.proposedCount` の doc コメントに明記して割り切った。 |
| **backfill で `unnest` の重複を `DISTINCT` してから数える** | `memory_labels` への挿入は `DISTINCT` する（正しい多重集合ではなく集合であるべきため)が、`labels.proposed_count` の初期値は書き込み経路の数え方（1 Memory につき `Set` で1回）と完全には一致しない近似で妥協した——backfill だけのために書き込み経路と別の集計クエリ（`unnest` した上でさらに Memory 単位で `DISTINCT` してから数える）を書くコストと、近似値で妥協する設計判断（上記）を天秤にかけ、後者を採った。 |

---

## 引き受けた負債

1. **`proposedCount` は近似値である。** Memory が `forgotten`/`archived`/`purged` に
   なっても減らない。backfill と増分書き込みで数え方が完全には一致しない
   （「採らなかった案」参照）。
2. **`MemoryStore` を独自実装する第三者 adapter は、`tags` を書いても自動でラベルが
   できない。** `listLabels?`/`registerLabel?` を自分で実装しない限りこの機能は
   「無い」ままである——これは任意メソッドの設計そのものが許容する差である。
3. **`taxonomy_mode` を読んで何かを変える経路がまだ無い。** PR-B が実装するまで、
   `getTaxonomyMode?`/`setTaxonomyMode?` は読み書きできるだけで、recall の挙動には
   一切影響しない。
4. **`examples/chat` への配線はしていない。** CLI から `listLabels`/`registerLabel`/
   `taxonomy_mode` を触る経路は本 PR の範囲外。
5. **`packages/postgres/src/__tests__/test-db.ts` の `DOMAIN_TABLES` 漏れを、
   本 PR の適合テストを実際に Postgres へ通して初めて発見した**（`labels`/
   `memory_labels` が `TRUNCATE` の対象に入っておらず、テスト間で状態が漏れて偽陽性の
   赤が出た)。本 PR で修正済みだが、**同種の「新しいドメインテーブルを足したのに
   `DOMAIN_TABLES` を更新し忘れる」という穴は、この配列が手書きである限り再発しうる**
   ——機械で検出する門は本 PR では作っていない。

## これが覆るとしたら

1. **PR-B の設計時に、`listLabels?`/`registerLabel?` の形が recall 側の要求と合わない
   ことが分かったとき**——例えば `memory_labels` を大量に読む必要が出た場合、
   専用の読み出しメソッドを別に足す可能性がある。
2. **`proposedCount` の近似が実運用で問題になったとき**（「引き受けた負債」1）——
   厳密なライブカウントへの作り直しを検討することになる。
3. **オーナーが「`attributes` からラベルを作りたい」と明示的に決めたとき**——本 ADR の
   「文脈」節の境界（2つの機構は混ぜない）を再検討する必要がある。
4. **オーナーが `tagMatch` への `strict` の反映を望んだとき**——「決定5」を覆し、
   既存スコアを変える破壊的変更として別途扱う必要がある。

---

## PR-B に向けた申し送り

- **絞り込みをどこに入れるか**: `RecallQuery` に任意欄（例:
  `labels?: string[]`）を足し、`recall-runtime.ts` の段1（`VectorFilter`/
  `LexicalFilter` への押し下げ）・段5（後置フィルタ）・`aggregateScope`
  （`RecallScope`）の3点セットに同じ述語を伝播する——`includeSubjectless`
  （ADR 0286）が確立した「新しい任意フィルタは3点セットを同時に更新する」規律を
  踏襲するのが自然に見える。**ただし `memory_labels` は `memories` とは別テーブルなので、
  段1の ANN/lexical クエリへ `JOIN`（あるいは `id = ANY(subquery)`）を挟む形になり、
  既存の `idx_memories_recall_gate` 系の索引と組み合わさったときのプラン・コストは
  未検証。** `idx_memory_labels_by_label (tenant_id, label_id)`（本 PR で先取りして作成
  済み）がこの絞り込みの主索引になる想定。
- **strict の効き方**: `taxonomy_mode === 'strict'` のテナントでは、`labels?` で
  指定されたラベルが `proposed` のとき、そのラベルによる絞り込みが**フィルタから
  外れる**（＝そのラベルを条件にしていないのと同じ扱いになる）想定——「決定5」で
  明記したとおり、既存の `tagMatch` 加点には触れない。`registered` なラベルは
  strict/open に関わらず常に使える。
- **被覆不変条件（`docs/recall.md` §5）への影響の見立て**: ラベルでの絞り込みは
  「スコープの外延」を狭める新しい軸になりうる——`docs/recall.md` §2 段0
  「スコープの外延」（tenant + subject + 時間窓 + 有効性 + taxonomy + status ゲート）は
  **既に「taxonomy」を外延の一部として名指ししている**（現状は生成されない分岐として）。
  ⟹ PR-B が `labels?` を段1のフィルタとして実装するなら、それは「フィルタ」（段1〜4で
  落ちたもの、`omitted.kind: 'filtered'`）であって「スコープの外」ではない、という
  `docs/memory-model.md` §8 の既存の整理（「このモデルには専用の『不在の章』を recall.md
  に立てる必要が無い……既存の filtered の一種として表現できる」）にそのまま乗る想定。
  **第3階（群カウント）の `axis: 'taxonomy'` を生成する場合**は、`totalInScope` との
  和が一致することを新たに検証する適合テストが要る——`subject` 軸で既に確立している
  「総和が一致する」歯（`aggregateScope` の conformance）と同じ形を `taxonomy` 軸にも
  複製することになるはず。
- **`GroupCount.axis: 'taxonomy'` の `key`**: `registered` なラベルだけを軸にするのか、
  `proposed` も含めるのかは未決——本 ADR は決めていない。§8 の「strict は検索の
  フィルタ・加点への参加可否を変えるだけ」という筋からは、群カウント自体は open/strict
  に関わらず全ラベルを対象にしてよさそうに見えるが、**確かめていない**。
- **未解決**: `registerLabel` を呼べる主体（テナント管理者相当）を誰が持つかは
  `packages/core` の外側（呼び出し側アプリケーション）の話であり、mnemora 自体は
  認可を持たない——これは PR-A/PR-B どちらの射程でもなく、埋め込み側の責任として
  残る。

---

## 測ったこと

### 【実測】赤→緑（変異試験、`docs/autonomy.md` §2 の要求）

`AGENTS.md`「⛔ 変異を戻すのに `git checkout` を使わない」の手順（`cp` で退避・復元）に
従い、手元の Postgres（`initdb` で自分専用に起動、PostgreSQL 17.6 + pgvector）に対して
実行した。

**M1: 書き込み経路（`upsertProposedLabels` の3呼び出し）を無効化**

```
$ (3箇所の `await this.upsertProposedLabels(tx, ctx, memory.id, memory.tags);` をコメントアウト)
$ pnpm --filter @mnemora/postgres exec vitest run src/__tests__/conformance.postgres.test.ts
 Test Files  1 failed (1)
      Tests  6 failed | 320 passed (326)
```

赤くなった6件はいずれも「ラベルが自動でできる」ことに依存するテストのみ
（`tags` が空・`registerLabel` が新規名を直接 registered にできる、の2件は影響を
受けず緑のまま——期待どおり）。`cp` で復元後、326件すべて緑に戻ることを確認。

**M2: `registered` 昇格後に `proposedCount` を進めない SQL のガードを外す**

```
$ (`+ CASE WHEN labels.status = 'proposed' THEN 1 ELSE 0 END` を `+ 1` に置換)
$ pnpm --filter @mnemora/postgres exec vitest run src/__tests__/conformance.postgres.test.ts
 Test Files  1 failed (1)
      Tests  1 failed | 325 passed (326)
```

赤くなったのは「registered に昇格した後は…proposedCount が進まない」1件だけ
（狙った歯だけが落ちた）。`cp` で復元後、326件すべて緑に戻ることを確認。

**M3: `assertValidTaxonomyMode` の検査を無効化（`packages/core`）**

```
$ (`if (value !== "open" && value !== "strict")` を `if (false)` に置換)
$ pnpm --filter @mnemora/core exec vitest run src/__tests__/tenant-settings-store.test.ts
 Test Files  1 failed (1)
      Tests  1 failed | 23 passed (24)
```

赤くなったのは「それ以外の文字列は…失敗する」1件だけ。`cp` で復元後、24件すべて
緑に戻ることを確認。

### 【実測】適合テスト全体（本物の Postgres、PostgreSQL 17.6 + pgvector 0.8.0、
`btree_gin`/`pgcrypto` 込み）

```
$ pnpm --filter @mnemora/postgres exec vitest run src/__tests__/conformance.postgres.test.ts
 Test Files  1 passed (1)
      Tests  326 passed (326)
```

### 【実測】in-memory 適合テスト（`packages/testkit`）

```
$ pnpm --filter @mnemora/testkit exec vitest run src/__tests__/in-memory-fixtures.conformance.test.ts
 Test Files  1 passed (1)
      Tests  325 passed | 1 skipped (326)
```

### 【実測】`packages/core` 全体

```
$ pnpm --filter @mnemora/core exec vitest run
 Test Files  74 passed (74)
      Tests  1116 passed | 4 expected fail (1120)
```

### 【実測】migration の backfill を、既存データが在る状態を模して確認

`labels`/`memory_labels`/`memories` を `TRUNCATE` した上で、`tags` を持つ Memory 4件
（うち1件は空配列、1件は同一タグの重複あり）を生 SQL で直接挿入し、
`0020_taxonomy_labels.sql` の backfill 部分の SQL をそのまま実行:

```
tenant-x: alpha(proposed_count=4) / beta(1) / gamma(1)、memory_labels 5行
tenant-y（tags=[]）: labels/memory_labels とも0行
```

「決定1」の記述どおりの結果になることを確認した。確認後、このデータは `TRUNCATE` して
元に戻した。

### 確かめていないこと

- `pnpm --filter @mnemora/postgres run test:db`（フルスイート、約4分）は走らせていない
  ——`conformance.postgres.test.ts` を直接 `vitest run` で実行した（AGENTS.md
  「1本に絞って走らせる」手順）。マージ前に CI の `postgres` ジョブがフルスイートを
  走らせる。
- 1,000,000 件規模のテナントで backfill を実行した場合の所要時間・ロック時間は測って
  いない——`labels`/`memory_labels` は新規テーブルへの `INSERT ... SELECT` であり
  `memories` 自体を書き換えないため `docs/memory-model.md` §7 が警告する「表の
  書き換え」には当たらないが、大規模テナントでの実測はしていない。
- `pnpm run lint` / `pnpm run typecheck`（ルート、全パッケージ）と `pnpm api:write`
  による公開 API スナップショットの更新は、本 ADR 執筆と同じ作業の中で別途実行する
  （PR 本文に記録）。
- `examples/chat` からの動作確認はしていない（「引き受けた負債」4）。
