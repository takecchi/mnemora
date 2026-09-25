# ADR 0292: 関係グラフ本体（Issue #207）の段0 — テーブル形・探索の深さ上限・`omitted` への出し方を決める（設計のみ）

- **状態**: 提案 (2026-09)
- **日付**: 2026-09-25

**⚠ 各主張の出所を分ける**（[ADR 0185](./0185-contradiction-detection-path.md)・[ADR 0291](./0291-primary-probe-coverage-map-correction-candidate-domain.md) の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の担当者が自分で読んで確かめた。
- **【実測】** — この手元の器で実際にコマンドを走らせて得た。
- **【受】** — マネージャー・Issue コメントからの前提として受け取り、自分では再導出していない。

⛔ **この ADR はマイグレーション・コードを1行も書かない。**`memory_relations` テーブルは
作らない。`RelationStore` interface も実装しない。実 API も叩いていない。**設計のみ。**

---

## 0. 依頼の要旨と、この ADR が答える範囲

[Issue #207](https://github.com/takecchi/mnemora/issues/207) の「まず決めてほしいこと」3点——

1. `memory_relations` テーブルを作るのか、今日の一対一ポインタ（`status`/`superseded_by_id`/
   `contested_with_id`）を拡張するのか。
2. 探索の深さに上限を置くか。
3. 探索結果（辿らなかった枝）を `omitted` にどう出すか。

——に、**設計として**答える。マージ・実装・マイグレーションは含めない。

**この ADR が答えないこと**: Issue #197 の後半（「何を矛盾と見なすか」の検出ロジック）は
[ADR 0134](./0134-mark-contested-explicit-operation.md)/[ADR 0150](./0150-resolve-contested-explicit-operation.md)
で「明示操作による検出」までは決着済みだが、[ADR 0185](./0185-contradiction-detection-path.md)
（状態: 提案・未採用）が描く「自動検出」の設計（主張キー・カセット鍵の再計算等、同 ADR
分割表の順5〜6）はこの ADR の範囲外。本 ADR は同表の**順4**
（「`memory_relations` の最小形」）だけに答える。

---

## 1. 文脈 — 現状の現物確認

### 1.1 Issue #207 本文の「#197 が先」はもう成立していない【現物・委】

Issue #207 は「#197 が先（辿るエッジが1本も作られていない）」としていたが、2026-09-17 の
Issue コメントが訂正している：ADR 0134（`Runtime.markContested`）/ ADR 0150
（`Runtime.resolveContested`）が着地し、`examples/chat/src/correction-demo.ts:142,146`
が実際に呼ぶ。⟹ **「エッジが作れない」という依存の理由は消えた。**ただし #207 が
求めているもの自体（`memory_relations` テーブル・`RelationStore`）は今日も無い
（同コメント、再確認は §1.3）。

### 1.2 今日在る「一対一ポインタ」【現物】

`docs/memory-model.md` §5「スキーマ上の帰結」:

```sql
status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','superseded','contested','archived','forgotten')),
superseded_by_id   uuid NULL REFERENCES memories(id),
contested_with_id  uuid NULL REFERENCES memories(id),
```

同節が明記する理由：**「グラフ探索ではなく索引で引けるようにするため」**。`superseded_by_id`
は `WHERE superseded_by_id IS NOT NULL` で単純な索引アクセスになる。`contested_with_id` は
一対一の対向関係だけを Phase 1 で成立させる補助列——「**一つの Memory が複数の Memory と
同時に争われている**」ケースは一対一では表現できず、これが `memory_relations`（Phase 2）を
要求する、と同節が既に明言している。

### 1.3 `memory_relations` の既存ドラフトと、2箇所の食い違い【現物】

`docs/memory-model.md` §10:

```sql
CREATE TABLE memory_relations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL,
  from_memory_id  uuid        NOT NULL REFERENCES memories(id),
  to_memory_id    uuid        NOT NULL REFERENCES memories(id),
  kind            text        NOT NULL CHECK (kind IN
                     ('contradicts','supersedes','consolidates_from','derived_from')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_memory_id, to_memory_id, kind)
);
CREATE INDEX idx_memory_relations_from ON memory_relations (tenant_id, from_memory_id, kind);
CREATE INDEX idx_memory_relations_to   ON memory_relations (tenant_id, to_memory_id, kind);
```

`docs/architecture.md` §5.3:

```ts
type RelationKind = 'contradicts' | 'supports' | 'derived_from';
```

🔴 **この2つは食い違っている。**`memory-model.md` の `kind` CHECK に `supersedes`/
`consolidates_from` があるが `architecture.md` の `RelationKind` には無く、逆に
`architecture.md` にだけ `supports` がある。**`supports` は他のどの docs にも出所が無い**
（`grep -rn "supports" docs/` は `architecture.md` のこの1箇所のみ）。**§2 決定1 でこの
食い違いを解く。**

### 1.4 `consolidates_from`/`derived_from` は、実は既に別の場所に保存されている【現物】

`docs/memory-model.md` §2「Provenance」:

```ts
type Provenance =
  | { kind: 'stated';       sourceObservationId: string; speaker?: string; at: string }
  | { kind: 'inferred';     model: string; promptVersion: string;
      basis: { memoryIds: string[]; observationIds: string[] }; confidence: number }
  | { kind: 'consolidated'; sources: string[] /* memoryIds */ }
  | { kind: 'reflected';    sources?: string[] /* memoryIds, 省略可 */ }
  | { kind: 'imported';     batchId: string }
```

`consolidates_from` に当たる情報（統合元 memoryId の一覧）は `provenance.sources`（`consolidated`）
として、`derived_from` に当たる情報（推論の根拠）は `provenance.basis.memoryIds`
（`inferred`）として、**Phase 1 の時点で既に `memories` 行自身に jsonb として保存されている**。
`docs/memory-model.md` §11 行12・行13の遷移表がこれを裏づける（`consolidate()`/`reflect()`
は新規行の `provenance.sources`/`provenance.basis` を書くだけで、別テーブルへの書き込みは
持たない）。

### 1.5 探索の深さ・上限について、既存の docs は何も決めていない【実測】

```
grep -rln "深さ\|depth" docs/decisions/*.md docs/*.md
```

は `docs/autonomy.md`・`docs/migration-v1.md` と、無関係な6本の ADR（HNSW の再帰・移行の
コメント除去など）だけを返す。**「探索の深さ」を関係グラフの文脈で扱った ADR・docs は無い。**
今日の `contested_with_id` 経由の同伴取得（`recall.md` §2 段3）は**常に1段**であり、
「上限を置くかどうか」という問い自体、多段（`memory_relations` を再帰的に辿る）探索が
実在して初めて意味を持つ——今日はまだ実在しない。

### 1.6 `omitted`（`Omission`）union の現状と、拡張が破壊的とされている先例【現物】

`docs/recall.md` §4 が `Omission.kind` の一覧を持つ。`docs/migration-v1.md` は、この
union に値を足すことを**繰り返し破壊的変更として数えている**——

- 項目4「`FilteredOmission.condition` の union に `"expired"`/`"not_yet_valid"` が増えた」
- 項目9「`FilteredOmission` に必須フィールド `scopeRelation` が増えた」
- 項目10「`Omission` の `over_limit` に必須フィールド `stage` が増えた」
- 項目17「`MemoryEventKind` の union に `"unsuperseded"` が増えた」

項目17 の逐語:「**こちらは union に値が増えた形で、消費する側が壊れる。**」
項目17 が項目4 と並べて確認している通り、**「出力側の型の union に値が増えた」形は、
向きが同じであれば毎回破壊的に数えられている。**⟹ **`omitted` の型をどう設計しても、
新しい値を1つでも足せばその時点で破壊的変更になる**——「既存の型に収まる形」を探す
価値はあるが、それは「破壊的変更を避けられる」という意味ではない（§4・§6 で書き分ける）。

`OverLimitOmission` は既に1度この形で拡張されている（[ADR 0188](./0188-association-over-limit-omission.md)、
Issue #375）——`stage: "rescore" | "association"` の2値。**`docs/recall.md` §4 の
型例ブロックはこの拡張を書き換えていない**——`docs/recall.md` 自身が明記する運用は
「本節の型例は書き換えない——追記としてここに足す」であり、`stage_skipped.stage` も
同じ理由でコード上は `'association'` を持つが型例には出てこない。**本 ADR も同じ作法を
踏む**（§3 で追加する値は、この ADR と実装 PR が「追記」として足す）。

### 1.7 ADR 0223 決定8 — 区別を足す基準【現物】

[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定8:

> **新しい種類・新しいフィールド・新しい `kind` を足す理由は「違うものだから」ではない。**
> ⟹ **「その区別を受け取った側が、実行時に違う手を打てるか」である。打てないなら足さない。**

起点は [ADR 0008](./0008-absence-taxonomy.md)（`Omission` 一覧そのものの起点）。
本 ADR の全決定（テーブルの `kind` の絞り方・`omitted` の設計）はこの基準を通す。

### 1.8 `docs/autonomy.md` §1.2 の3問（着手前に答える）

Issue #207 の受け入れ条件・`docs/autonomy.md` §1.2 が要求する3問に、この ADR の範囲
（設計）で答えられる分だけ先に書く。詳細は §6。

1. **何の数字が動くか** — 「間違いを正すと、古いほうが先に出てこなくなる」の対象が、
   一対一の対向（1件）から多者間の矛盾（N件）へ広がる。動く数字は「争われている
   Memory のうち、対向を漏らさず提示できた割合」。
2. **どう測るか** — `packages/testkit` の適合テスト（多者間の `contradicts` を作り、
   `listRelated` が全件返すこと）と、`examples/chat` の `correction` デモの拡張
   （3件以上が互いに矛盾するケース）。**この ADR では測っていない**——次段の実装が
   要求される。
3. **動かなかったらどうするか** — テーブル自体は実装しても、`RecallQuery.relations`
   を渡さない呼び出しは1バイトも変わらない設計にする（§3.1）。⟹ 「動かなかった」場合の
   損失は**オプトインした呼び出しにのみ**生じ、既定の呼び出しには生じない。

---

## 2. 決定1（① テーブル形）

### 決定1-a. `memory_relations` テーブルを作る。ただし `kind` は `'contradicts'` の1値に絞る

**採る**: `docs/memory-model.md` §10 のドラフトをベースに、`kind` の CHECK を
`'contradicts'` だけに絞ったテーブルを Phase 2 で作る。

```sql
CREATE TABLE memory_relations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL,
  from_memory_id  uuid        NOT NULL REFERENCES memories(id),
  to_memory_id    uuid        NOT NULL REFERENCES memories(id),
  kind            text        NOT NULL CHECK (kind IN ('contradicts')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_memory_id, to_memory_id, kind)
);

CREATE INDEX idx_memory_relations_from ON memory_relations (tenant_id, from_memory_id, kind);
CREATE INDEX idx_memory_relations_to   ON memory_relations (tenant_id, to_memory_id, kind);
```

`tenant_id` を全索引・PK 相当の一意制約の先頭に置く形は [ADR 0007](./0007-tenant-scoping.md)
（tenant scoping）にそのまま揃えている。`kind` 列は残す——CHECK を1値に絞っても、
将来 `kind` を増やす判断（§2 決定1-b の基準を満たす新しい種類が出てきたとき）は
**列を追加するマイグレーションではなく CHECK を広げるマイグレーション**で済む
（列追加より軽い）。

**理由（決定8 を当てる）**:

- `supersedes`: 既に `superseded_by_id`/`status` 列が索引つきで持っている
  （§1.2）。同じ情報を `memory_relations` にも書くと、**2つの真実の情報源**を持つ
  ことになり、`AGENTS.md` の反重複規律に触れる。加えて `memory-model.md` §5 自身が
  「グラフ探索ではなく索引で引けるように」列にした、と明言している——`supersedes` を
  `memory_relations` に入れると、その決定と矛盾した二重管理になる。
- `consolidates_from`/`derived_from`: §1.4 の通り、`provenance.sources`/
  `provenance.basis.memoryIds` として**既に** `memories` 行自身に保存されている。
  ここでも同じ情報を2箇所に置くことになり、ズレたときにどちらが正か読む側が
  判断できなくなる（`recalls` テーブルの `returned_memories` を jsonb 1列に統合した
  [ADR 0155](./0155-recall-score-breakdown-persisted.md) と同じ設計原則——
  「後から再現できないものだけを持つ」の逆をやることになる）。
- `supports`: 出所が `architecture.md` の1箇所のみで、他のどの docs・issue にも
  根拠が無い（§1.3）。「争っていない関係」を示す `kind` があると呼び出し側の
  次の一手が具体的に何になるかが、現時点でどの文書からも導けない
  （決定8「打てないなら足さない」）。
- `contradicts`: **唯一、既存の1:1機構では表現できず、かつ既存のどの列・jsonb にも
  重複していない。**「一つの Memory が複数の Memory と同時に争われている」ケースを
  表現するのがこのテーブルの存在理由そのものであり（§1.2 が memory-model.md 自身の
  言葉で明言）、次の一手（矛盾する全員を提示する／対向を漏らさない）も明確。

**`docs/architecture.md` §5.3 の食い違いへの対応**: `RelationKind` を
`'contradicts'` の1値に直す（`supports`/`derived_from` を落とす）よう §7 の次段へ
申し送る。**本 ADR は architecture.md の本文を書き換えない**——マイグレーション同様、
文書更新も次段の実装 PR の範囲とする。

### 決定1-b. 対称な `contradicts` は双方向2行で書く（`OR` クエリを作らない）

`architecture.md` §5.3 は既に「`link('contradicts', ...)` は対称関係として扱う」と
契約している。実装方法として2つを検討した：

| 案 | 内容 | 判定 |
|---|---|---|
| (a) 1行 + `OR` クエリ | `A→B` の1行だけ書き、`listRelated` は `WHERE from_memory_id = ? OR to_memory_id = ?` | ⛔ 却下 |
| (b) 双方向2行 | `A→B` と `B→A` を同一トランザクションで2行書く。`listRelated` は `WHERE from_memory_id = ?` の単純な索引スキャンだけで済む | **採る** |

**採った理由**: `docs/memory-model.md` の規約節（§10 末尾）が
「`ORDER BY` には距離演算子の結果をそのまま昇順で書く」など、**索引が素直に効く形を
繰り返し優先している**——`recall.md` §3 も「二段検索と pgvector」で索引ヒットを
明示的に検査する方針を持つ。(a) の `OR` は2列にまたがる索引ヒットを Postgres の
プランナに委ねることになり、`idx_memory_relations_from`/`_to` の2つの部分索引を
Bitmap Or で合成する計画になりうる——`docs/memory-model.md` の「⚠ `superseded`/
`contested` の行は溜まる」節が既に実測している通り、この repo は**件数が増えたときの
計画の倒れ方**（Index Only Scan → Seq Scan）を重視しており、単純な単一索引スキャンで
済む (b) の方が同じ轍を避けやすい。代償は書き込み側の行数が2倍になることと、
`UNIQUE (tenant_id, from_memory_id, to_memory_id, kind)` は2行それぞれに対して
独立に効く（`A→B` と `B→A` は別のキーなので、片方だけを二重に張ることを防げない——
書き込み経路（次段の `RelationStore.link` 実装）が両方向を1トランザクションで
書く契約を持つことで防ぐ。テストキットの適合テストで両 adapter に強制する）。

### 決定1-c. `RelationStore` は新しい必須 interface とし、`Store` バンドルへの組み込みは任意

`archiveDecayed?`（[ADR 0114](./0114-archive-sweep-for-decayed-memories.md)）・
`getVectors`（`VectorStore` の任意メソッド、§9 association）と同じ形——**`RelationStore`
自体は独立した interface として定義する**が、`Runtime`/`recall-runtime.ts` から見た
配線は任意（`stores.relations?: RelationStore`）にする。理由は北極星**問い2**
（これを無効にしたとき Memory Framework として成立するか）——`memory_relations`
テーブルを実装していない adapter（例えば `packages/testkit` の in-memory 実装が
追従するまでの間）でも `recall()` は今日どおり動く必要がある。

```ts
interface RelationStore {
  link(ctx: Ctx, kind: 'contradicts', fromId: MemoryId, toId: MemoryId): Promise<void>;
  unlink(ctx: Ctx, kind: 'contradicts', fromId: MemoryId, toId: MemoryId): Promise<void>;
  listRelated(ctx: Ctx, memoryId: MemoryId, kind?: 'contradicts'): Promise<Relation[]>;
}
```

`kind` 引数は architecture.md の元のドラフトのシグネチャをそのまま残す（`RelationKind`
が1値に絞られても、将来 CHECK を広げたときにシグネチャを変えずに済む）。

### 決定1-d. `contested_with_id`/`status='contested'` との関係は、書き込み経路を次段へ持ち越す

`memory-model.md` §10 は既に「`memories` 側の3列は Phase 2 移行後も残し、『最も重要な
1件』のキャッシュ的な役割として使い続けてよい」としている。本 ADR はこれを**踏襲する**
——`status`/`superseded_by_id`/`contested_with_id` はそのまま Phase 1 の高速経路として
残す。

🔴 **ただし「`markContested`/`resolveContested`（ADR 0134/0150、既に出荷済み）が
`memory_relations` にも同時に書くのか」は、この ADR では決めない。**選択肢は2つある
——(i) `markContested` を拡張し、1:1列と `memory_relations` の両方を同一トランザクションで
書く（二重書き込み、ズレの検査が要る）。(ii) `memory_relations` への書き込みは新しい別の
口（多者間の矛盾を明示的に登録する新操作）に限り、`markContested` は今日の契約のまま
1:1列だけを書き続ける（`memory_relations` 側は「多者間になったケースだけ」が住む）。
**(ii) の方が、既に出荷済みの `markContested`/`resolveContested` の契約
（ADR 0134/0150 が固定した歯・適合テスト）を変えずに済むため筋が良いと考えるが、
書き込み経路の設計は実装 PR の範囲であり、ADR 0156 の「§5 級の判断はクローンが決めてよい」
に照らしても、**既に出荷済みの操作の契約を変えるかどうかはオーナーへの確認を要する点**
として §7 に明記する。

---

## 3. 決定2（② 探索の深さの上限）

### 決定2-a. 深さは1段（直接の隣接ノードのみ）に固定する。可変パラメータにしない

`docs/memory-model.md` §5「機構3: 隣接を不変条件にする」の逐語:

> 対向関係にある Memory は、recall の提示順を通じて**必ず隣接させる**。並び順のどこにも
> 「新しい方だけが単独で出てくる」状態を作らない。

この機構が要求しているのは**隣接**（1段）であって、多段の推移閉包ではない。
`docs/north-star.md` 問い1（毎回渡す量を減らす方向に働くか）は、増やす側の変更に
「増やすなら、その分だけ想起が良くなると言えるか」を要求する。**多段（2段以上）の
価値を測る手段は今日どこにも無い**（§1.8 の3問のうち「どう測るか」に、多段の場合の
答えが用意できない）。⟹ **測れない拡張を先取りしない。**深さの上限は1段に**固定**し、
`RecallQuery` に「深さ」を表すパラメータ自体を作らない（可変にすると、将来「2にすれば
良くなる」という未測定の主張を呼び出し側が持ち込める余地を作ってしまう）。

### 決定2-b. 「深さ」とは別に、1段の中の「広さ」（fanout）には上限を設ける

多者間の矛盾（決定1-a の存在理由そのもの）では、1つの Memory が複数の Memory と
同時に争われうる。1段でも件数は無限ではない。`docs/recall.md` §9.5 の連想枠
（`RecallAssociationQuery.maxCount`、必須フィールド）と同じ形を踏襲する：

```ts
interface RecallRelationQuery {
  /** 関係探索に含める最大件数。必須（`RecallAssociationQuery.maxCount` と同じ理由）。 */
  maxCount: number;
}
```

`RecallQuery.relations?: RecallRelationQuery` として追加する。**既定は無い
（フィールド自体を渡さなければ何も起きない）**——§9.2 手順1「`query.association` が
無ければ何もしない、`omitted` にも積まない」を relations にもそのまま適用する。

### 決定2-c. 予算（§6・段4）の扱いも連想枠に揃える

`docs/recall.md` §9.5 の3条件をそのまま踏襲する：

1. 既定 off。`relations` を渡さない呼び出しの挙動は1バイトも変わらない。
2. 予算（段4）の内側に置く——契約 companion（段3の必須取得）とは別に、これは
   digest 本文を持つ追加候補であり実トークンを焼く。
3. 予算で削るときは最初に落とす。

### なぜ「深さ」を上限として明示的に決めたのに、実質的に多段探索を作らないのか

Issue #207 の文言は「探索の深さに上限を置くか」であり、多段探索の実在を前提にした
問いに読める。しかし §1.5 の通り、**多段探索そのものが今日どこにも実在せず、
測る手段も無い。**⟹ **「上限を1に固定する」という決定自体が、Issue が懸念する
「置かないと危険」への答えになる**——上限を「後から緩められる大きな値」ではなく
「今は1固定」にすることで、北極星問い1の「増やすなら根拠を示せ」を、
**多段化の判断を先送りする形**で満たす。多段化したくなったら、その時点で改めて
`docs/autonomy.md` §1.2 の3問に測定込みで答える新しい ADR が要る（§8）。

---

## 4. 決定3（③ `omitted` への出し方）

前提（§1.6）: **どちらの形を選んでも、`Omission` union に新しい値を足す時点で
破壊的変更になる。**「既存の型に収まる形」は「破壊的にならない道」ではなく、
**「最小の・precedent に揃った破壊的変更にする道」**として探す。

### 決定3-a. 1段内の fanout 切り捨ては `over_limit` に `stage: "relation"` を追加する

`maxCount`（決定2-b）を超えて切り捨てられた、**存在は確定しているが席に着けなかった**
候補は、[ADR 0188](./0188-association-over-limit-omission.md) が `association` に
対して作った形をそのまま流用する：

```ts
export interface OverLimitOmission {
  kind: "over_limit";
  stage: "rescore" | "association" | "relation";  // "relation" を追加
  count: number;
  countKind: CountKind;
}
```

`countKind` は常に `'exact'`——`memory_relations` は索引つきテーブルへの通常の
`WHERE` 検索であり、ANN のような近似が無い（`association` の fanout 切り捨てと
同じ理由。ANN 由来の `ann_truncated`/`ann_unreached` とは性質が違う）。次の一手は
「`maxCount` を増やす」——`association` の `over_limit(stage:'association')` と
全く同じ形の次の一手であり、`OverLimitOmission.stage` の doc コメントが持つ
「次の一手が変わるので `stage` を必須にした」という既存の設計理由に、そのまま
新しい行を1つ足すだけで済む。

**`docs/recall.md` §4 の型例ブロックは書き換えない**——§1.6 で確認した既存の
運用（`association` を追加したときも型例は書き換えていない）をそのまま踏襲し、
実装 PR が「追記」として §4 に1段落を足す形にする。

### 決定3-b. 探索の対象が無い（`RelationStore` 未配線・adapter 側が対応していない）場合は `stage_skipped` に `stage: "relation"` を追加する

`association` が `VectorStore.getVectors` の欠如を `stage_skipped { stage:
'association', reason: 'vector_store_lacks_get_vectors' }` として扱っている
（§9.2 手順2）のと同じ形を踏襲する：

```
stage_skipped { stage: 'relation', reason: 'relation_store_unavailable' }
```

`RecallQuery.relations` が渡されたのに `stores.relations`（決定1-c）が無い adapter
では、このオミッションを1件積んで終える——「聞かれたのに探していない」を黙らせない
（`docs/north-star.md` 目指す姿「知らないことを知らないと言える」）。

### 決定3-c. 「1段より先（未探索の深さ）」は `Omission` union を増やさず、`explain` の補助診断キーに置く

これが最も注意して決めた点である。「1段だけ探索した」という設計（決定2-a）を選んだ
時点で、**返した隣接ノード自身がさらに何を争っているか（2段目）は、原理的に
今回の1回のクエリでは分からない。**「そこから先を探索していない」という事実を
黙らせないために、何らかの形で必ず可視化したい——ただし ADR 0223 決定8 の基準
（「その区別を受け取った側が、実行時に違う手を打てるか」）に当てると、**今日の
設計では呼び出し側に「深さを増やす」レバーが存在しない**（決定2-a が深さを
可変パラメータにしないと決めたため）。レバーの無い情報を `Omission`
（=「次の一手のための契約」として設計されている union、§1.6・§1.7）に正式加入
させるのは、この repo が既に一度踏んだ轍と同じ形になる：

[ADR 0285](./0285-ann-window-empty-of-in-scope-candidates-stage-detail.md) は、
ANN の「窓は満杯だが scope 内を拾いきれなかった」正常時と全滅時を区別する診断を
**`Omission` union を増やさず**、`RecallResult.explain.stages` の trace に
「型無し欄——zod では検証されない」補助キーとして足した。**同じ形を採る**：

```
explain.stages[].detail.relationDepthCapped: true
```

を、relations 探索が実行され1件以上の隣接ノードを返したときに常に付与する
（型で保証しない診断キー。ADR 0285 と同じ位置づけ）。**`omitted` には出さない**
——`omitted` は「候補になり得たが落ちたもの」の契約であり、「そもそも見ていない
2段目」はその契約の対象外だと判断した（ADR 0223 決定8）。

**⚠ この判断は近似ではなく明確な線引きである**——ADR 0285 の先例と同じ理由
（レバーが無い情報は診断キー、レバーがある情報は `Omission`）に基づく設計判断
であり、「まだ決めていないので保留」ではない。**ただし覆る条件がある**（§8）:
深さが将来 可変パラメータになれば、`ann_truncated`/`ann_unreached` の対
（証明された打ち切り／未確認の打ち切り）と同じ形で `Omission` 側に正式な
kind を新設する判断に切り替わる。

### まとめ（③ の結論）

| 事象 | 出し先 | 破壊的か |
|---|---|---|
| 1段内で `maxCount` を超えて切り捨てた（存在は確定） | `Omission.over_limit` に `stage: "relation"` を追加 | **破壊的**（union 拡張。§1.6 の先例と同じ形） |
| `relations` を要求したが `RelationStore` が無い | `Omission.stage_skipped` に `stage: "relation"` を追加 | **破壊的**（同上） |
| 1段より先を探索していない（未確認の深さ） | `explain.stages[].detail.relationDepthCapped`（型無し診断キー） | **破壊的ではない**（ADR 0285 と同じ形。`Omission` union も `RecallResult` の必須フィールドも増えない） |

---

## 5. 採らなかった案

- ⛔ **`memory_relations` の `kind` に `supersedes`/`consolidates_from`/`derived_from`/
  `supports` も含める**（memory-model.md §10 の原案どおり）。§2 決定1-a で却下
  ——重複した真実の情報源になる、または出所不明（`supports`）。
- ⛔ **今日の一対一ポインタ（`contested_with_id`）を拡張して多者間に対応する**
  （例: `contested_with_ids: uuid[]`）。`docs/memory-model.md` §5 が既に
  「一対一の関係で表現できないケースは Phase 2 の `memory_relations` を必要とする」
  と決めている——配列に拡張しても、多対多の一意制約・双方向の整合性・索引の効き方
  （`ANY(...)` は B-tree 単純索引の等値検索ほど素直に効かない）を独立列より丁寧に
  扱えない。テーブルの方が筋が良いと判断し、この案は不採用。
- ⛔ **`listRelated` を `OR` クエリで実装する**（§2 決定1-b、案(a)）。索引の効き方の
  観点で双方向2行書きに劣ると判断。
- ⛔ **深さを可変パラメータにし、既定値だけ小さくする**（例: 既定1・最大5）。
  §3 決定2-a で却下——「後から緩められる大きな値」は北極星問い1の「増やすなら
  根拠を示す」を、根拠が無いまま呼び出し側に持ち込ませる余地を作る。
  [ADR 0185](./0185-contradiction-detection-path.md) 自身も多段の価値を測っておらず
  （§1.5）、可変にする根拠が今日どこにも無い。
- ⛔ **「未探索の深さ」を新しい `Omission.kind`（例: `relation_unreached`）として
  正式に加える**（`ann_unreached` と同じ形）。§4 決定3-c で却下——今日の設計では
  呼び出し側に対応するレバー（深さパラメータ）が無く、ADR 0223 決定8「打てないなら
  足さない」に反する。ADR 0285 の先例（診断キーへ落とす）を優先した。
- ⛔ **段3（必須の同伴取得）を `memory_relations` 経由に作り直す**（Phase 1 の
  `contested_with_id` 読み出しをやめる）。§2 決定1-d で明示的に保留——既に出荷済みの
  `markContested`/`resolveContested`（ADR 0134/0150）の契約・適合テストを変える
  ことになり、この ADR の範囲（テーブル形・深さ・omitted の設計）を超える。次段が
  オーナーに確認すべき点として残した。

---

## 6. `docs/autonomy.md` §1.2 の3問（§1.8 の続き・北極星への当て方）

**問い1**（毎回渡す量を減らす方向か）: 関係グラフは明確に「増やす」側。**この ADR は
増やす量を1段・`maxCount` 件に固定し、既定 off にすることで歯止めをかける**（§3）。
「その分だけ想起が良くなる」の実測は次段の責務（§1.8 の2番）。

**問い2**（無効化しても成立するか）: `RecallQuery.relations` を渡さなければ挙動は
1バイトも変わらない（§3 決定2-b、`association` と同じ形）。`RelationStore` 自体も
`Store` バンドルへの組み込みが任意（§2 決定1-c）。⟹ **成立する。**

**問い3**（説明できるか）: `Omission.over_limit(stage:'relation')` の次の一手
（`maxCount` を増やす）が明確。`explain` の診断キーも「1段しか見ていない」ことを
黙らせない（§4 決定3-c）。

**問い4**（AI の推論とユーザーの事実を区別しているか）: `contradicts` エッジを
*誰が*（LLM か人手か）張るかはこの ADR の範囲外（§0「答えない」）——[ADR 0185](./0185-contradiction-detection-path.md)
決定4「検出は `contested` までで止める」の精神を、`memory_relations` へ書く経路
（§2 決定1-d、次段で確定）にも引き継ぐべきだと申し送る。

**問い5**（LLM を呼ばずに済ませられないか）: `memory_relations` の読み出しは
列と索引だけで完結する（B-tree の等値検索）。LLM を呼ばない。

---

## 7. 引き受けた負債・次段でやること・オーナー確認が要る点

**この ADR は設計のみである。**次はすべて未実装:

1. **マイグレーション**: `memory_relations` テーブルと2つの索引（決定1-a）。
2. **`RelationStore` interface の実装**（`packages/core` の型・`packages/postgres` の
   実装・`packages/testkit` の適合テスト。決定1-c）。
3. **`RecallQuery.relations`/`RecallRelationQuery` の追加と、`recall-runtime.ts` への
   段3.5 相当の配線**（決定2-b・decision 3）。
4. **`OverLimitOmission.stage`/`StageSkippedOmission.stage` への `"relation"` 追加、
   および `explain.stages[].detail.relationDepthCapped` の実装**（決定3）。
5. **`docs/architecture.md` §5.3 の `RelationKind` を `'contradicts'` の1値に直す**
   （§2 決定1-a。本 ADR は本文を書き換えていない）。
6. **CHANGELOG / `docs/migration-v1.md` への計上**——決定3-a・3-b はどちらも
   `Omission` union の拡張であり、§1.6 の先例（項目4/9/10/17）と同じ形で破壊的変更
   として記載が要る。決定3-c（`explain` の診断キー）は非破壊的。
7. 🔴 **オーナーへの確認が要る点**: §2 決定1-d（`markContested`/`resolveContested`
   が `memory_relations` にも書くか、それとも多者間専用の別口を新設するか）は、
   **既に出荷済みの Phase 1 操作の契約を変えうる判断**であり、この ADR では決め
   きっていない。ADR 0156 により §5 級の判断・破壊的変更の実装自体はクローンが
   自分で決めてよいが、**この分岐はどちらを選んでも次段の実装規模・既存適合テストへの
   影響が大きく変わる**ため、実装 PR に着手する前に一度明示的に選び、その選択の
   理由を ADR として残すことを推奨する（決めずに実装へ進まない）。
8. `packages/testkit` の適合テスト（多者間の `contradicts` を作り、`listRelated` が
   両方向から引けること・`over_limit`/`stage_skipped` が正しく積まれることを検査
   する歯）。

---

## 8. これが覆るとしたら

- **多段探索の価値が測れる形が出てきたとき**（例: 実際に3段以上の矛盾の連鎖が
  実データで観測され、1段では捕捉できない実害が示されたとき）。そのときは
  `docs/autonomy.md` §1.2 の3問に測定込みで答える新しい ADR を書き、深さを
  可変にする判断へ進む。§4 決定3-c の「診断キーのまま」という判断も、その時点で
  `ann_truncated`/`ann_unreached` 型の正式な `Omission.kind` 新設へ昇格させる。
- **`supports`/`supersedes`/`consolidates_from` を `memory_relations` に含める具体的な
  次の一手（決定8 の基準を満たす読み出しパターン）が見つかったとき**。§2 決定1-a の
  「1値に絞る」判断を見直す。
- **§7-7 のオーナー確認で「二重書き込み」（案(i)）が選ばれたとき**。`markContested`/
  `resolveContested` の適合テストを拡張する必要が生じ、ADR 0134/0150 への追記が要る。
- **多者間の `contradicts` の実運用で、双方向2行書き（決定1-b）のストレージ・整合性
  コストが無視できないと分かったとき**。`OR` クエリ案（案(a)）または部分的な非正規化
  への再検討が要る。

---

## 9. 確かめたこと・確かめていないこと

**確かめた【現物・実測】**

- `docs/memory-model.md` §5・§10・§2（Provenance）、`docs/architecture.md` §5.3、
  `docs/recall.md` §2・§4・§9、`docs/roadmap.md` §1.3・§3、`docs/migration-v1.md`
  の該当箇所、ADR 0007・0008・0134・0150・0151・0185・0188・0223・0285・0291 を
  自分で開いて引用箇所を確認した。
- `architecture.md` の `RelationKind` と `memory-model.md` の `kind` CHECK の食い違い、
  および `supports` の出所が `architecture.md` の1箇所しかないことを `grep` で確認した。
- `consolidates_from`/`derived_from` に当たる情報が `provenance.sources`/
  `provenance.basis.memoryIds` として既に保存されていることを、型定義と lifecycle
  表（§11 行12・行13）で確認した。
- `grep -rln "深さ\|depth"` で、関係グラフの文脈での深さ上限を扱った既存 docs・ADR が
  無いことを確認した。
- Issue #207 本文・コメント全件、Issue #197・PR #687（体裁の参考）、`gh pr list
  --state open` で開いている PR が #207 と重複しないことを確認した（#686/#683 は
  無関係）。
- ADR 番号 0292 の空きを `node scripts/adr-renumber.mjs --next` と `gh pr list` で
  確認した（`main` 最新は 0291、open PR は 0289/0291 を主張していずれも無関係）。

**確かめていないこと**

- **双方向2行書き（決定1-b）の実際のクエリプラン**。`docs/memory-model.md` の
  「行は溜まる」節の実測（`superseded`/`contested` の件数と `EXPLAIN` の変化）を
  類推の根拠にしたが、`memory_relations` 自体に対する `EXPLAIN` は実行していない
  （テーブルが存在しないため実行できない）。
- **`maxCount` の具体的な既定値**。`association` の `DEFAULT_ASSOCIATION_ANCHOR_COUNT`
  等と同じく「マネージャー決定」の裁量値になる想定だが、この ADR では決めていない
  ——実装 PR が §6 の予算実測を踏まえて決めること。
  `RecallAssociationQuery.maxCount` は必須（既定値を持たない設計）なので、
  `RecallRelationQuery.maxCount` も同じ形（必須）を提案したが、これも実装 PR で
  再確認すること。
- **§7-7 の分岐（二重書き込み vs 別口新設）のどちらが実装コストとして軽いか**。
  両方のプロトタイプを書いて比較していない——設計上の判断材料（既存契約への影響）
  だけで書いている。
- **`explain.stages[].detail.relationDepthCapped` という診断キー名が、実装時に
  `recall-runtime.ts` の既存の trace 形式（ADR 0285 の `detail.annReachableLowerBound`
  等）とどう整合するか**。命名は本 ADR の提案であり、実装時に既存の trace 構造を
  読んでから最終決定すること。
- **この設計が実装された場合の6つの門・変異試験**。この PR は設計のみであり新規
  コードを含まないため該当しない（§7 が実装の残件を明記する）。
- **本番（Postgres + pgvector）での実測**。対象コードが未実装のため実施対象が無い。

---

⭐ **追記 (2026-09-25)**: §2 決定1-d が持ち越した「`markContested`/`resolveContested` が
`memory_relations` にも書くのか、多者間専用の別口を新設するのか」に、段1として
[ADR 0327](./0327-relation-graph-contested-write-path-design.md) が設計を続けている
（状態: 提案）。本 ADR の決定（テーブル形・深さ・`omitted` の出し方）は変更していない。

---

Refs #207
