# ADR 0327: 関係グラフ本体（Issue #207）の段1 — `memory_relations` へ何を移すか・既存列からの移行の形・多者間 `contested` の解き方（設計のみ）

- **状態**: 提案 (2026-09)
- **日付**: 2026-09-25

**⚠ 出所の凡例**（[ADR 0292](./0292-relation-graph-table-depth-omitted-design.md) の体裁をそのまま踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の担当者が自分で読んで確かめた。
- **【実測】** — この手元の器で実際にコマンドを走らせて得た。
- **【受】** — マネージャー・Issue コメントからの前提として受け取り、自分では再導出していない。

⛔ **この ADR はマイグレーション・コードを1行も書かない。**`memory_relations` テーブルは
作らない。`RelationStore`/新しい `Runtime` 操作も実装しない。実 API も叩いていない。
**設計のみ。**

⛔ **Issue #207 は閉じない。**この ADR は段1（続き）であり、まだ実装を伴わない。

⛔ **claimKey の `subject` 誤帰属（ADR 0324 負債6）の改善はこの ADR の範囲外である。**
別の担当（別issue: #371/ADR 0320 側）の持ち場であり、本 ADR は参照するだけに留める。

---

## 0. この ADR が答える範囲、および ADR 0292 との関係

[ADR 0292](./0292-relation-graph-table-depth-omitted-design.md)（状態: 提案、2026-09-25）が
既に Issue #207 の「段0」として、テーブル形・探索の深さ上限・`omitted` への出し方に
答えている。**本 ADR は 0292 を上書きしない。**0292 が決定した次を、そのまま前提として
引き継ぐ：

- `memory_relations` テーブルを作り、`kind` は当面 `'contradicts'` の1値に絞る（0292 決定1-a）。
- 対称な `contradicts` は双方向2行で書く（0292 決定1-b）。
- `RelationStore` は独立した interface とし、`Store` バンドルへの組み込みは任意
  （`stores.relations?: RelationStore`。0292 決定1-c）。
- 深さは1段固定・fanout には `maxCount` 上限を置く（0292 決定2-a/2-b）。
- `omitted` への出し方（`over_limit.stage: "relation"`・`stage_skipped.stage: "relation"`・
  `explain.stages[].detail.relationDepthCapped`。0292 決定3）。

0292 が**決めずに持ち越した**のが、0292 §2 決定1-d の🔴部分である：

> 「`markContested`/`resolveContested`（ADR 0134/0150、既に出荷済み）が `memory_relations`
> にも同時に書くのか」は、この ADR では決めない。

**本 ADR の中心はここである。**加えて、Issue #207 が求める5項目（このマネージャー依頼の
「ADR が答えること」節）に、0292 が§0で明示的に範囲外とした部分——多者間 `contested` の
書き込み経路——を中心に答える。

**本 ADR が答えないこと**: 探索の深さ・fanout の具体的な既定値、`kind` を将来広げる基準
（0292 決定1-a に既出）、claim key の検出ロジックそのもの（ADR 0320/0324 の領分）。

---

## 1. 文脈 — 現状の現物確認（0292 以降の差分）

### 1.1 0292 が書かれた時点から、本文の状態に変化は無い【現物】

`main`（35d5b7e）時点で `memory_relations` テーブルは存在せず、`RelationStore` も無い。
`packages/core/src/memory.ts` の `Memory.supersededById`/`Memory.contestedWithId` は
0292 §1.2 が確認した形のまま列として残る。0292 の現物確認はそのまま有効である。

### 1.2 `markContested`/`resolveContested` は今日も厳密に一対一である【現物】

`packages/core/src/runtime.ts` の `Runtime.markContested(ctx, firstId, secondId, opts)` は
`firstId === secondId` で `RangeError` を投げる（手順1）。3件以上を渡す口は無い——
シグネチャ自体が2引数固定であり、N件を1回で対にする経路は存在しない。CAS は
「両側とも `status === 'active'`」（`markContested`）/「両側とも `status === 'contested'`
かつ相互参照が成立」（`resolveContested`）で、**部分成功が無い**（`MarkContestedOutcome`/
`ResolveContestedOutcome` の doc コメント、`"contested"`/`"resolved"` は全成功のみ）。
⟹ **`markContested` を「N件を受け取れるように拡張する」ことは、関数のシグネチャと CAS の
性質そのものを変えることを意味する**——これは「既存操作を壊さず両方に書く」という
軽い変更ではなく、**新しい操作**として扱うべきだと、この ADR は判断する（§3 で詳述）。

### 1.3 ADR 0324 決定5/6 — 今日、3件以上は `status` を一切動かさない【現物】

ADR 0324（採用済み、Issue #372）決定5・決定6：`detectClaimKeyContested` が同じ主張キーに
2件以上の一致を見つけたとき、**`markContested` を一切呼ばない**。`status` はどの Memory も
`'active'` のまま動かず、`memory_events` へ `kind: 'updated'`・`meta.reason:
'claim_key_conflict_unresolved'` の1件（今回新規に作られた Memory 側にだけ）を積むのみ
——決定6・負債2。

**これが意味すること**: 今日、3件以上のケースは「`contested` として検出されているが表現
できない」のではなく、**recall パイプラインから見て `contested` に一度もならない**——
`status` が `'active'` のまま残るため、`recall-runtime.ts` 段3の mandatory companion
retrieval の判定（`c.memory.status === "contested" && c.memory.contestedWithId`）にすら
掛からない。`memory_events` の evidence は監査ログとしてのみ存在し、recall の結果には
一切影響しない（負債2「既存側からは逆引きできない」はこの構造の帰結）。

**本 ADR にとっての含意**: 「`memory_relations` へ書く」だけでは足りない。**N件を
`contested` 扱いにして recall 段3 に載せるには、状態遷移（`active → contested`）を
起こす新しい書き込み経路も同時に要る。**この2つ（表への書き込み・状態遷移）を
分けて設計する（§4・§5）。

### 1.4 ADR 0185 決定4/5 — 自動検出は `contested` までで止める、という制約はそのまま活きる【現物】

ADR 0185（提案・未採用）決定4：「(B) の鍵は推論として扱う。検出は `contested` までで
止め、`superseded` へ進まない」。決定5：「(C) は #207 を要らない。(B) は #207 を前提に
する」——(B)（claim key 検出）が多者間を表現するには #207 が要る、という依存の向きを
既に明言していた。⟹ 本 ADR が多者間の書き込み経路を設計する際も、**`superseded` へ
進む経路は作らない**（ADR 0324 決定8 が既に同じ制約を明文化・継承している）。

採らなかった案5点（案1〜5）はいずれも「検出を `packages/core` の外に置く」「順序で自動
判定する」「LLM 応答から拾う」の系統であり、本 ADR が扱う「表への書き込み経路」の設計
（案の対象は書き込みの*形*であって検出ロジックではない）とは軸が異なる。同じ案を
本 ADR で再提出しない。

### 1.5 `companionOf` は保存される列ではなく、recall 結果に付く注記である【現物】

`packages/core/src/recall.ts:1190` `RecalledMemory.companionOf?: MemoryId`、
`packages/core/src/recall-runtime.ts:1168` `companionOf: owner?.memory.id` ——段3の
mandatory companion retrieval がその場で組み立てる、**recall のたびに再計算される
注記**である。`packages/core/src/memory.ts` に `companionOf`/`companion` に相当する列は
無い。Issue #200 の `associationOf`（`recall.ts:1197`）と全く同じ形。
⟹ **`companion` は "保存される関係" ではない**——後述§2 決定1-d の判断の前提になる。

### 1.6 `derivedFrom` という名前の列・フィールドは存在しない。`provenance` がそれに当たる【現物】

`grep -rn "derivedFrom" packages/core/src` は0件。0292 §1.4 が確認した通り、
「統合元」は `provenance.sources`（`kind: 'consolidated'`）、「推論の根拠」は
`provenance.basis.memoryIds`（`kind: 'inferred'`）として、**既に `memories` 行自身の
jsonb に保存されている**。この事実は今日も変わらない。

---

## 2. 決定1（① どの関係を表に移すか）

**0292 決定1-a がテーブルの `kind` を `'contradicts'` の1値に絞る、と既に決めている。**
本節はその決定を、依頼された4種の関係それぞれについて明示的に当てはめて確認する
（0292 は `supersedes`/`consolidates_from`/`derived_from`/`supports` を一括で退けたが、
本 ADR は `companion` も含めて、依頼された4分類それぞれの結論を個別に明記する）。

### 1-a. `supersedes` — 表に移さない。列（`supersededById`/`status`）のまま

**確認【現物】**: `docs/memory-model.md` §5 が「グラフ探索ではなく索引で引けるように」と
明言し、`supersededById` は常に単一の勝者を指す1:1関係（`superseded → active` の
遷移は必ず1対1、ADR 0230/0134/0150 のどの操作を見ても「複数の勝者」という形が無い）。
表に複製すると `supersededById` と `memory_relations` の2箇所が同じ情報を持つことになり、
`AGENTS.md` の反重複規律・[ADR 0155](./0155-recall-score-breakdown-persisted.md) と同じ
設計原則（「後から再現できないものだけを持つ」）に反する。**結論は 0292 決定1-a と同じ**
——移さない。

### 1-b. `contested`（`contradicts`） — 表に移す。ただし「移す」の中身は2層に分かれる

これが本 ADR の中心（§3・§4）。**0292 決定1-a は「テーブルを作り `kind` を `contradicts`
に絞る」ところまでを決めた。**本 ADR が付け足すのは、**既存の一対一操作（`markContested`/
`resolveContested`）が今日どおり残る中で、どの経路がいつ表に書くか**という書き込み経路の
設計である。

### 1-c. `derivedFrom`（`provenance` 由来） — 表に移さない。0292 決定1-a を追認する

§1.6 の確認どおり、`provenance.sources`/`provenance.basis.memoryIds` として既に
`memories` 行自身に保存されている。**新たに動いた事実は無い**——0292 決定1-a の理由
（「後から再現できないものだけを持つ」の逆をやることになる、[ADR 0155](./0155-recall-score-breakdown-persisted.md)
と同じ設計原則）をそのまま追認する。

追加で確認した点: `provenance` は `Memory` の作成時に**不変**（`packages/core/src/memory.ts`
の型を見る限り、`provenance` を更新する操作は無い——`consolidate`/`reflect` は新しい
Memory 行を作るだけで既存行の `provenance` を書き換えない）。⟹ 表に複製する動機
（「後から書き足せる」という利点）自体が `derivedFrom` には無い。**移さない。**

### 1-d. `companion` — 表に移さない。「保存される関係」ではないため、移す対象そのものが無い

§1.5 の確認どおり、`companionOf` は recall 実行時に段3が組み立てる注記であり、**永続化
された関係ではない。**`memory_relations` は「永続化された関係」を保存するテーブルである
——`companionOf` を表に移すという操作自体が、対象を取り違えている（移す元の関係が
そもそも存在しない）。

⚠ **ただし紛らわしい点が1つある**: `companionOf` の**値**（「この Memory が誰の同伴として
出たか」）は、`contested` ペアの `contestedWithId`、または（本 ADR が設計する）多者間
`contested` グループの `memory_relations` 行から**その場で導出**される。⟹ **`companion`
は独立した関係の種類ではなく、「`contradicts` 関係を検索した結果を recall がどう
提示するかという役割（ラベル）」である。**`memory_relations.kind` に `'companion'` を
追加する動機は無い——ADR 0223 決定8（「実行時に違う手を打てるか」）に照らしても、
`companion` というラベル自体は recall の提示層の語彙であり、書き込み層（`kind`）の語彙
ではない。**結論: 移さない。0292 決定1-a が `companion`/`supports` を明示的に列挙して
いなかった空白を、ここで明示的に埋める。**

### まとめ（① の結論）

| 関係 | 表 (`memory_relations`) に移すか | 理由（要約） |
|---|---|---|
| `supersedes` | ⛔ 移さない | 既に列（1:1）で表現済み。0292 決定1-a を追認 |
| `contested`(`contradicts`) | ✅ 移す（書き込み経路は§3・§4） | 唯一、既存の1:1機構で表現できない多対多 |
| `derivedFrom`(`provenance`) | ⛔ 移さない | 既に jsonb で保存済み、かつ不変。0292 決定1-a を追認 |
| `companion` | ⛔（対象が無い） | 保存される関係ではなく、recall 提示時の注記（ラベル） |

---

## 3. 決定2（② 既存の単数列 `contested_with_id` からの移行の形）

0292 §2 決定1-d が挙げた2案に、依頼された3案目（表を唯一の真実にする案）を加えて
比較する。

| 案 | 内容 |
|---|---|
| **(i) 同一トランザクション二重書き** | `markContested` を拡張し、1:1列（`status`/`contestedWithId`）と `memory_relations` の両方を同じトランザクションで書く |
| **(ii) 別口新設（多者間のみ）** | `markContested` は今日の契約のまま1:1列だけを書き続ける。`memory_relations` への書き込みは、多者間の衝突を扱う**新しい別の操作**に限る |
| **(iii) 表を唯一の真実にする** | `memory_relations` を唯一の情報源とし、`contested_with_id`/`status='contested'` は廃止予告（deprecation）にする |

### 3.1 各案の評価

**(i) 二重書き**

- **利点**: 「`contested` な関係は常に表に在る」という単純な不変条件が保てる。将来
  `kind` を広げたときも一貫した読み出し経路（表だけ見ればよい）になる。
- **欠点**: **§1.2 の確認どおり、`markContested` は厳密に2引数（`firstId`/`secondId`）
  であり、その意味でこの案は「2者間ケースの二重書き」にしかならない。**多者間
  （3件以上）はそもそも `markContested` を通らない（§1.3）ため、この案だけでは
  多者間ケースを一切救えない——**(i) は問題の半分（2者間）にしか答えない案である。**
  加えて、二重書きは「1:1列」と「表」が同じ事実を2箇所に持つことになり、
  `resolveContested` 側も対応して表の行を消す／解決済みとしてマークする責務を負う
  ——**ズレの検査**（0292 §2 決定1-d が既に懸念していた点）が新しい適合テストの
  対象として増える。TOCTOU（`MemoryStatusConflictError` の再読1回、§1.2）の窓でも、
  1:1列は再読して確定するが、その間に表への書き込みが先に成立していた場合の
  ロールバック/補正が要る——`markContested` の「開く前に落とす・上限の無い
  再試行をしない」という安全弁の設計（ADR 0134 決定4・決定5）に、表への書き込みという
  もう1つの失敗点を持ち込むことになる。
- **backfill**: 既存の `status='contested'` 行（`contestedWithId` が設定済みの過去データ）
  を、双方向2行の `contradicts` として `memory_relations` に一括投入する必要がある——
  新しいマイグレーションの範囲に入る。

**(ii) 別口新設**

- **利点**: 既に出荷済みの `markContested`/`resolveContested`（ADR 0134/0150、適合テスト
  込み）の契約を**一切変えない**。TOCTOU・CAS・「開く前に落とす」規律もそのまま。
  ズレの検査という新しい負債を作らない——**2者間と多者間で情報の置き場所が最初から
  分かれる**ため、「どちらが正か」を問う必要自体が生じない（分離による解決）。
- **欠点**: `contestedWithId` が「常に対向の全件を指す」という単純な期待を持てない
  ——2者間は列、3者以上は表、と**読み出し側が分岐を意識する必要**が生じる
  （§4 で recall 段3 の分岐として具体化する）。
- **backfill**: **不要。**2者間の既存データは今日どおり列のまま残り続ける
  （表への移行を一切要求しない）。

**(iii) 表を唯一の真実にする**

- **欠点が支配的で、この段階では採れない**: §3.2 決定2-b（0292）が「`RecallQuery.relations`
  を渡さない呼び出しは1バイトも変わらない」ことを既定の不変条件としている。しかし
  `RelationStore` は**任意配線**（0292 決定1-c、`stores.relations?`）であり、
  `recall-runtime.ts` 段3 の mandatory companion retrieval（`contested` の対向を必ず
  連れてくる、`docs/memory-model.md` §5 機構2 の不変条件）は**`RelationStore` の有無に
  関わらず常に動く必要がある**（`markContested`/`resolveContested` が今日どおり動く
  以上、対向取得も今日どおり動かねばならない）。`contested_with_id` を廃止すると、
  `RelationStore` を配線していない adapter（0292 決定1-c が明示的に許容する状態）では
  段3の mandatory companion retrieval 自体が成立しなくなる——**「無効にしても
  Memory Framework として成立するか」（北極星 問い2）を壊す。**⟹ **(iii) は
  `RelationStore` が任意配線でなくなる（必須の store になる）という、0292 決定1-c を
  覆す判断とセットでなければ成立しない。**それは本 ADR・0292 いずれの範囲も超える
  大きな判断であり、今回は採らない（§7「これが覆るとしたら」に条件を残す）。

### 3.2 推奨（決めるのはオーナー）

**この ADR が推奨するのは (ii) である。**理由:

1. 既存の出荷済み契約（ADR 0134/0150、適合テスト）を一切変えない——0292 §2 決定1-d 自身が
   「筋が良いと考える」とした方向と同じ。
2. backfill が不要——2者間データは今日のまま、表は多者間ケースの新規発生分だけを持つ。
3. 「2つの真実の情報源」問題が、**ズレを検査する**形ではなく**最初から書く場所を
   分ける**形で解消される。これは決定1-a が `supersedes`/`derivedFrom` を表から除外
   した理由（2つの真実の情報源を作らない）と、**設計原則としては同じ**——対象が
   「既存関係の種類」ではなく「既存関係の*濃度*（1:1 か 1:N か）」で分かれる点が
   0292 決定1-a と異なるだけである。

**ただし、これは推奨であり決定ではない。**(i) を選べば「表だけ見れば全ての contested
関係が分かる」という将来の読み出し側の単純さを得られる代わりに、二重書きの整合性
コストを払う。**この分岐は決めきらず、§7「オーナーに決めてほしい点」に明記する**
——0292 §2 決定1-d が既にオーナー確認事項として申し送っていた論点を、本 ADR が
選択肢を3つに広げ、评価を添えた上で、改めて同じ場所（オーナー確認）に置く。

### 3.3 `Memory.contestedWithId` の意味（(ii) を採った場合）

(ii) の下では、`contestedWithId` の意味は**今日と一切変わらない**——「`markContested` を
明示的に呼んで対にした、ちょうど1件の相手」。多者間グループのメンバーは
`contestedWithId` を一切持たない（`null` のまま）。「最も重要な1件のキャッシュ」
（0292 §2 決定1-d が引用した `memory-model.md` §10 の記述）という位置づけを、
2者間ケース限定の意味として維持する——多者間ケースにまでこの「キャッシュ」の比喩を
広げない（広げようとすると「N件のうちどれが最も重要か」という、ADR 0324 決定5が
既に「機械的に選ぶ根拠が無い」と却下した問いに逆戻りする）。

---

## 4. 決定3（③ 既定の振る舞いと公開 API への影響）

### 4-a. 既定 off は保てる

(ii) を採る限り、`RecallQuery.relations` を渡さない・`stores.relations` を配線しない
呼び出しは**1バイトも変わらない**——0292 決定2-b/2-c・決定1-c がそのまま成立する。
`markContested`/`resolveContested` の既存呼び出しも変わらない。

### 4-b. 多者間を `contested` として recall に載せるには、新しい書き込み操作が要る

§1.3 の確認どおり、ADR 0324 の3件以上ケースは今日 `status` を一切動かさない。
(ii) を採る場合、多者間を実際に「`contested` として recall 段3に載せる」には、
**`markContested` とは別の、N件を受け取る新しい `Runtime` 操作**（本 ADR は仮に
`markContestedGroup` と呼ぶ。名称は次段で確定）が要る。この操作が担う責務：

1. 渡された `memberIds: MemoryId[]`（2件以上）を読み、全員が `status === 'active'`
   であることを確認する（`markContested` の CAS 思想を N 件に拡張。**部分成功は
   作らない**——1件でも不適格なら書き込み自体を行わない、という `markContested` の
   `"ineligible"` と同じ形）。
2. 全員を `status: 'contested'` に遷移させる。**`contestedWithId` は設定しない**
   （§3.3）。
3. `memory_relations` へ、全員のペアを `contradicts` として書く（双方向、§5 で書き方を
   比較）。
4. `memory_events` へ全員分1件ずつ積む（ADR 0324 決定6が「今回作られた Memory 1件にしか
   積まない」としていた負債2 が、ここで自然に解消される——全員が書き込みトランザクション
   の対象になるため）。

**この操作は `RelationStore` が配線されていなければ実行できない**（`{ supported: false,
outcome: { kind: "not_attempted" } }` 相当を返す。`markContested` の `supported: false`
と同じ「無い」の扱い）。**理由**: `docs/memory-model.md` §5 機構2「対向関係にある
Memory は…必ず隣接させる」という不変条件は、多者間ケースでは `RelationStore` 経由の
探索でしか満たせない（§4-d）。`RelationStore` を配線せずに `status: 'contested'` へ
遷移させると、段3 が対向を1件も連れてこられない「争われているのに独りで出る」状態を
作ってしまい、`memory-model.md` §5 の不変条件そのものを破る。**⟹ 多者間 `contested`
への遷移は、`RelationStore` の配線を前提条件にする**（この制約自体が新しい設計判断
——0292 決定1-c は `RelationStore` 無しでも `recall()` が今日どおり動くことしか要求
していなかったが、本 ADR は「多者間 `contested` を*書く*操作」に限ってこの前提を課す）。

### 4-c. `resolveContested` の N 者での意味 — 勝者を1件選んだとき残りはどうなるか

`resolveContested`（ADR 0150）も今日どおり厳密に2引数のままとする（`markContested` と
同じ理由、§1.2）。多者間グループから1件を「勝者」として確定したい場合の経路は、
本 ADR では**新設しない**——理由は北極星 問い4（ADR 0185 決定4 の精神の継承、§1.4）
と同じ: 多者間グループのどのペアを「解決」するかを機械的に決める根拠が無い
（ADR 0324 決定5が2件を機械的に対にする案B を却下した理由の再帰）。

**推奨する扱い**: N 者グループを解決したい場合、採用側（人・上位アプリ）が
「このグループの中で、この1件だけが正しい」と判断した時点で、**グループ全体を
明示的に「解除」する新しい操作**（仮称 `resolveContestedGroup`、あるいは
「勝者以外を全員 `superseded` にする」形）が要る。これは ADR 0185 決定4 の枠内に
収まる（`resolveContested` は今日どおり「明示的な操作」でしか呼ばれない）が、
**具体的な意味論（勝者以外を全員 `superseded` にするのか、全員を一旦 `active` へ
戻すのか）はこの ADR では決めない**——実装 PR 前にオーナーへ確認すべき点として
§7 に明記する。0185 決定4「`contested → active | superseded`」の行7が2者間を前提に
書かれているため、N者版の遷移表そのものを新しく書く必要がある。

### 4-d. recall 段3 の対向必須同伴取得が N 件になるときの fanout と `over_limit`

`recall-runtime.ts` 段3（§1.107-1180 付近）は今日、`c.memory.contestedWithId` の
**単一の** id を辿るだけである。多者間ケースを扱うには、この判定を拡張する必要がある：

```
既存: c.memory.status === "contested" && c.memory.contestedWithId && !presentIds.has(...)
拡張: 上の条件 に加えて、
      contestedWithId が無い（= 多者間経路で contested になった）場合は
      RelationStore.listRelated(ctx, c.memory.id, 'contradicts') を呼び、
      その結果（最大 maxCount 件、0292 決定2-b）を同伴候補に加える
```

`RelationStore` が配線されていなければ、**多者間経由で `contested` になった Memory は
そもそも存在しない**（§4-b の前提条件）ため、この分岐は「配線されているときだけ
到達する」——0292 決定3-b の `stage_skipped { stage: 'relation', reason:
'relation_store_unavailable' }` は、`RecallQuery.relations` を明示的に渡したのに
`RelationStore` が無いケース用であり、多者間 `contested` 自体が存在しないこの場合には
そもそも発火しない（発火する対象が無い）。**fanout の上限**は0292決定2-b の
`RecallRelationQuery.maxCount` をそのまま使う。ただし対向必須同伴取得（段3、契約
companion）と連想枠由来の relation 探索（0292 が本来 §3 で扱った「明示的に要求した
時だけ動く relations」）は**別の予算枠**であることに注意——0292 決定2-c「予算の内側に
置く」は「明示的に要求した relations」の話であり、**段3の契約 companion（既に
`contested` になったものの対向を出す）は予算の外にある必須取得**（0292 §3 決定2-c
「契約 companion（段3の必須取得）とは別に」の記述どおり）。多者間の契約 companion が
`maxCount` を超えて切り捨てられる場合の扱い（`over_limit` に積むか、無条件で全件
出すか）は、**0292 が连想枠専用に設計した `over_limit(stage:'relation')` の意味と
衝突しうる**——契約 companion は「必ず出す」（0292 §3 決定2-c、`docs/recall.md` §8）
という既存の不変条件と、fanout 上限（切り捨てを許す）という新しい要求が、多者間の
場合にだけ両立しない。**この衝突は本 ADR では解けない**——§7 に次段の課題として
明記する。

### 4-e. `ObserveResult.contestedDetection` に新しい variant が要るか

**要る。**現在の `ContestedDetectionOutcome.result` は3値の判別共用体
（`no_conflict`/`contested`/`unresolved_conflict`、§1.3・ADR 0324 決定9）。(ii) の
別口新設と組み合わせるなら、`matchCount >= 2` かつ `RelationStore` が配線されている
場合に限り、`unresolved_conflict`（今日どおり、`RelationStore` 未配線時のフォール
バック）とは別の新しい variant（仮称 `contested_group`）を追加する:

```ts
| { kind: "unresolved_conflict"; matchMemoryIds: MemoryId[] }               // 既存・変更なし
| { kind: "contested_group"; matchMemoryIds: MemoryId[];                    // 新規・純追加
    markContestedGroup: MarkContestedGroupResult }
```

**公開 API への影響は純追加**（`docs/decisions/0178-public-api-surface-gate.md` の基準、
ADR 0324 決定9 と同じ形）——既存の3 variant には触れない。ADR 0324 の適合テスト・
既存の呼び出し側コードは無変更で動き続ける。

### 4-f. CHANGELOG / `docs/migration-v1.md` での扱い

0292 §1.6 が既に確認した先例（項目4/9/10/17）に従えば、本 ADR が実装される段階で
増える破壊的変更は次の形になる見込み:

- `Omission.over_limit.stage`/`stage_skipped.stage` への `"relation"` 追加（0292 決定3、
  本 ADR は変更しない）。
- `ContestedDetectionOutcome.result` union への `"contested_group"` 追加（§4-e、純追加
  だが union 拡張として 0292 §1.6 の先例と同じ扱いになる）。
- `MemoryStore`/`Runtime` への任意メソッド追加（`markContestedGroup?` 等）——
  ADR 0324 決定9 と同じ「任意の純追加」に分類されると見込むが、最終判定は実装 PR が
  `docs/decisions/0178-public-api-surface-gate.md` に照らして行う。

**この ADR 自身は CHANGELOG/`docs/migration-v1.md` を書き換えない**——0292 と同じ運用
（§7「次段でやること」に計上するだけ）。

---

## 5. 決定4（④ 3件以上の `contested` を表でどう解くか）

前提: (ii) を採る場合、この設計が適用されるのは**`RelationStore` が配線されている**
ときだけである。**配線されていないときは、ADR 0324 決定5/6 の今日の挙動（`markContested`
を呼ばず `memory_events` にだけ evidence を残す）をそのまま維持する**——これは
依頼された5項目の4番目「配線されていないときは今日の保留のまま」の要求をそのまま満たす。

### 比較する3案

| 案 | 内容 |
|---|---|
| (a) pairwise 完全グラフ | N件のグループ全員の間に `contradicts` エッジを張る（双方向、`N×(N-1)` 行） |
| (b) 新規→既存の星形 | 新しく検出された1件から、既存の他の N-1 件それぞれへだけエッジを張る（双方向、`(N-1)×2` 行） |
| (c) 衝突集合（ハイパーエッジ／group 行） | `memory_relation_groups`（新テーブル）等で「同じ集合」をまとめて表現する |

### 評価

**(a) pairwise 完全グラフ（推奨）**

- **行数**: `N×(N-1)` 行（N=3 なら6行、N=5 なら20行）。ADR 0324 負債5・0320 負債2が
  記録する通り、real-fixture では3件以上のケースが**一度も観測されていない**
  （0/5）——想定される N は小さい（同じ主張キーへの重複した訂正が3回以上続く場合の
  みなので、実務上は数件〜一桁台に留まる見込み。ただし実測は無い——0292 §9・本 ADR
  §9 に「確かめていないこと」として明記する）。
- **説明可能性**: **最も高い。**「争っている」という関係そのものが pairwise な概念
  （`markContested` が2者間で表現してきた意味と完全に同じ）であり、N件のグループは
  「全員が互いに `contradicts`」という**単純な合成**として説明できる。ADR 0324 決定5が
  「なぜこの2件だけが対になったか説明できない」を理由に案Bを却下したのと対称に、
  完全グラフは「なぜ全員が対になっているか」を「全員が同じ主張キー・重なる有効期間・
  違う内容だから」という一貫した理由で説明できる。
- **解消時の扱い**: 1件が勝者として確定した場合（§4-c）、負けた側だけを
  `superseded` にし、勝者と負けた側の間の `contradicts` エッジを消す（あるいは
  残す——エッジ自体は「争っていた履歴」として保持し、`status` の遷移だけで
  「解決済み」を表す設計も可能。この選択は本 ADR では決めない）。**エッジが
  pairwise なので、「1件だけ抜く」操作が自然にできる**——星形(b)や group 行(c)より
  局所的な変更で済む。
- **索引**: 0292 決定1-b が既に確立した `idx_memory_relations_from`/`_to` の単純な
  索引スキャンがそのまま使える。新しい索引形は不要。
- **負債2（逆引きできない）の解消**: **完全に解消する。**全メンバーが
  `from_memory_id` 側にも `to_memory_id` 側にも登場するため、どのメンバーから
  `listRelated` を呼んでも他の全員を引ける。

**(b) 星形**

- **行数**: `(N-1)×2` 行——(a) より少ない。
- **説明可能性**: **弱い。**既存の N-1 件同士が実際に互いに争っているかどうかを、
  星形のエッジは直接表現しない（新規の1件を介した間接関係でしかない）。もし
  新規の1件が後で `superseded`/削除されると、既存 N-1 件同士の「争っている」という
  事実そのものが表現から消えてしまう——0292 決定1-b が求めた「対称な `contradicts`
  を双方向2行で書く」という設計原則（対称性を素直に表現する）に反する。ADR 0324
  決定5の「同じ主張キー・重なる期間・違う内容の全員が対等に矛盾している」という
  検出の前提とも噛み合わない（星形は「新規が特別」という非対称な構造を持ち込む）。
- **負債2の解消**: 部分的。既存メンバー同士は互いを直接引けない（新規メンバー経由の
  間接参照になる）。

**(c) 衝突集合（ハイパーエッジ／group 行）**

- **行数**: 最小（グループ1行＋メンバー参照 N 行、あるいは `memory_relations` に
  `group_id` 列を足す形）。
- **説明可能性**: 中間。「同じグループに属する」という説明はできるが、`kind` が
  `'contradicts'` の1値に絞られている0292決定1-aの設計（「対」を表す単純な形）から
  逸脱し、**新しいテーブルまたは新しい列（`group_id`）が要る**——0292が最小限に
  絞った設計（テーブル1本・列4つ・索引2本）を拡張することになり、本 ADR の範囲
  （0292の設計を前提に、書き込み経路だけを足す）を超える。将来 `claimKey` や
  検出時刻など「集合そのもののメタデータ」を持たせたい要求が出てきたときには
  この案が有利になるが、**今日そのような要求は無い**（ADR 0324 の evidence
  イベントが `meta.note` の jsonb で既にこの種のメタデータを運んでいる）。
- **索引**: グループ経由の join が要り、(a)/(b) の単純な等値索引スキャンより
  複雑になる。

### 推奨（決めるのはオーナー）

**(a) pairwise 完全グラフを推奨する。**理由: 0292 が既に確立した最小限のテーブル設計
（`kind` を1値に絞り、対を双方向2行で書く）をそのまま流用でき、新しいテーブル・列を
一切要求しない。負債2（逆引きできない）を完全に解消する。説明可能性が最も高い
（北極星 問い3）。行数の増加（`N×(N-1)`）は、real-fixture で N=3以上が一度も
観測されていない（0292/0320/0324 いずれも同じ制約を記録）ことから、**現時点では
実害の実測が無い**——行数が実際に問題になる N を確認する責務は次段の実装 PR に残す。

**ただし決めるのはオーナーである。**(c) がメタデータの要求が具体化した時点で
再検討に値する案として残る（§8）。

---

## 6. 採らなかった案

0292 §5「採らなかった案」を引き継ぐ（`supports`/`supersedes`/`consolidates_from` を
`kind` に含める案、`contested_with_id` を配列に拡張する案、`OR` クエリでの
`listRelated` 実装、深さを可変にする案、「未探索の深さ」を新しい `Omission.kind` に
する案、段3を `memory_relations` 経由に作り直す案——これらはすべて0292で既に却下
済みであり、本 ADR で再提出しない）。

本 ADR で新たに退けた案:

- ⛔ **`markContested` のシグネチャを可変長引数（`memoryIds: MemoryId[]`）に変える**
  （§1.2・§4-b で検討）。**採らない理由**: 出荷済み操作の契約（2引数固定、
  `RangeError` on same-id）を破壊的に変える。ADR 0134/0150 の適合テストが2引数を
  前提に書かれており、影響範囲が大きい。**別の新しい操作**（`markContestedGroup`）を
  足すほうが、既存契約を守りながら多者間に対応できる（決定2 (ii) の理由と同じ）。
- ⛔ **多者間グループの解決時に、勝者以外を機械的に全員 `superseded` にする**
  （§4-c で検討）。**採らない理由**: この ADR の範囲では「機械的に」全員を負けとする
  ことの妥当性（例えば実は2件が独立に正しく、1件だけが誤りだったケースをどう扱うか）
  を検証していない。ADR 0185 決定4 の精神（自動検出は `contested` で止める、
  *解決*は常に明示操作）に照らしても、解決の意味論自体をオーナー確認なしに決め
  きるべきではないと判断した。
- ⛔ **`RelationStore` 未配線でも多者間 `contested` への遷移を許す**（§4-b）。
  **採らない理由**: `docs/memory-model.md` §5 機構2（対向を必ず隣接させる）という
  不変条件を、探索経路の無い状態で破ることになる。`RelationStore` を配線の前提条件に
  課すほうが安全側に倒れる。
- ⛔ **(c) 衝突集合（ハイパーエッジ）を第一候補にする**（§5）。**採らない理由**:
  今日そのメタデータ要求が無く、0292 が確立した最小テーブル設計を拡張する正当化が
  見つからない（ADR 0223 決定8「打てないなら足さない」）。
- ⛔ **決定2 で (i)（二重書き）を単独の推奨にする**。**採らない理由**: §1.2/§3.1で
  確認した通り、(i) は多者間ケースを救わず、二重書きの整合性コストだけを追加で
  背負う——「2者間だけを二重化する」利点が、コストに見合わない。

---

## 7. 北極星の問いに当てた結果

**問1**（毎回渡す量を減らす方向か）: 検出単体・書き込み単体では変わらない（`observe`
の書き込みコストの話であり recall のペイロードではない）。**recall 側で増えるのは
段3・段3.5の対向取得**——0292 が既に答えたとおり（§3 決定2-b・2-c）、multi-way でも
既定 off・`maxCount` 上限で歯止めをかける（§4-d）。

**問2**（無効化しても成立するか）: `RelationStore` を配線しない限り、多者間 `contested`
への遷移そのものが起こらない（§4-b の前提条件）——**成立する。**むしろ本 ADR は
「配線されていないと多者間の書き込み操作自体を許さない」という形で、この不変条件を
0292 より一段強く守っている。

**問3**（説明できるか）: (a) pairwise 完全グラフは「なぜ全員が対になっているか」を
一貫して説明できる（§5）。`ContestedDetectionOutcome.result.contested_group` は
`matchMemoryIds` を運ぶ（§4-e）。

**問4**（AI の推論とユーザーの事実を区別しているか）: `superseded` へ自動で進む経路は
作らない（§1.4・§4-c・ADR 0185 決定4・ADR 0324 決定8 の継承）。多者間の解決も明示
操作のみに限る。

**問5**（LLM を呼ばずに済ませられないか）: 本 ADR が設計する書き込み・読み出しは
すべて列・索引の操作（CAS・`INSERT`・`SELECT ... WHERE`）であり、LLM を呼ばない。

---

## 8. `docs/autonomy.md` §1.2 の3問

1. **何の数字が動くか** — 0292 §1.8 が既に「争われている Memory のうち、対向を
   漏らさず提示できた割合」を挙げた。本 ADR はこれに1つ追加する: **「3件以上の
   claim key 衝突のうち、`memory_events` の evidence だけでなく実際に `contested`
   として recall に反映された割合」**（ADR 0324 負債2・決定6が「0%」だった状態から、
   本 ADR の実装後にどれだけ動くか）。
2. **どう測るか** — `packages/testkit` の適合テスト（`markContestedGroup` 相当の
   新操作を3件以上のグループに対して呼び、`recall()` の段3が全員を連れてくることを
   検査）。real-fixture 実測は ADR 0324/0320 が既に記録した通り「3件以上のケースが
   observed 0件」という制約を継承する——**本 ADR も次段の実装も、この数字を
   実データで測れない可能性が高い**（合成データでのみ測れる）。
3. **動かなかったらどうするか** — (ii)（別口新設）を採る限り、既存の2者間経路・
   `RelationStore` 未配線の呼び出しは影響を受けない。「動かなかった」場合の損失は
   **多者間 `contested` をオプトインした呼び出しにのみ**生じる。

---

## 9. 引き受けた負債・次段でやること・オーナー確認が要る点

**この ADR は設計のみである。**次はすべて未実装（0292 §7 の残件に、本 ADR の分だけ
追加する）:

1. 0292 §7 の1〜8（マイグレーション・`RelationStore` 実装・`RecallQuery.relations`
   配線・`omitted` 拡張・`architecture.md` 修正・CHANGELOG計上・適合テスト）は
   すべてそのまま未実装として残る。
2. **新しい `Runtime` 操作（仮称 `markContestedGroup`/`resolveContestedGroup`）の
   型・実装**（§4-b・§4-c）。名称・シグネチャは提案であり、次段で確定する。
3. **`recall-runtime.ts` 段3の分岐拡張**（`contestedWithId` が無い場合に
   `RelationStore.listRelated` を呼ぶ経路、§4-d）。契約 companion と `over_limit` の
   衝突（§4-d 末尾）は本 ADR では解けておらず、次段が解く。
4. **`ContestedDetectionOutcome.result` への `contested_group` variant 追加**（§4-e）。
5. **`memory_relations` の pairwise 完全グラフ書き込みを1トランザクションで行う
   ための store 側の契約**（`RelationStore.link` を N×(N-1) 回呼ぶのか、新しい
   bulk 相当のメソッドを足すのか）。**本 ADR では決めていない**——0292 決定1-c が
   確定した3メソッド（`link`/`unlink`/`listRelated`）に4つ目を足すかどうかの判断が
   要る。
6. 🔴 **オーナーへの確認が要る点（3つ）**:
   - **決定2**: (i) 二重書き・(ii) 別口新設・(iii) 表を唯一の真実にする、のどれを
     採るか。本 ADR は (ii) を推奨するが、決めるのはオーナー（§3.2）。
   - **決定4**: 3件以上を表にどう書くか——(a) pairwise 完全グラフ・(b) 星形・
     (c) 衝突集合。本 ADR は (a) を推奨するが、決めるのはオーナー（§5）。
   - **§4-c**: 多者間グループを解決するときの意味論（勝者以外を全員 `superseded` に
     するか、別の形か）。本 ADR は決めていない。
7. **claim key の `subject` 誤帰属（ADR 0324 負債6）の改善は、この ADR の範囲外**
   （マネージャーの明示的な指定）。別の担い手の持ち場であり、ここでは参照するに
   留める——もし負債6が解消されれば、多者間衝突の検出精度自体が上がり、本 ADR が
   設計する書き込み経路が実際に使われる頻度にも影響する（が、それはこの ADR の
   決定を変えない）。

---

## 10. これが覆るとしたら

- **0292 の「これが覆るとしたら」の条件（多段探索の価値が測れたとき等）がそのまま
  本 ADR にも及ぶ。**
- **§3.2 で推奨した (ii) が、オーナーによって (i) または (iii) に変更されたとき**
  ——決定3（§4）・決定4（§5）の一部（特に `contestedWithId` の意味、§3.3）を
  書き直す必要がある。
- **`RelationStore` が任意配線ではなく必須の store になる判断が下されたとき**
  ——0292 決定1-c を覆す大きな判断であり、そのときは (iii)（表を唯一の真実にする）
  が §3.1 で退けた理由（北極星問い2を壊す）が消え、再検討に値する。
- **real-fixture で実際に3件以上の claim key 衝突が観測されたとき**——(a) pairwise
  完全グラフの行数増加が実害として確認されれば、(b)/(c) の再評価が要る。
- **claim key の `subject` 誤帰属（ADR 0324 負債6）が改善されたとき**——多者間衝突の
  検出頻度・精度が変わり、既定を on にするかどうかの判断材料が変わる（この ADR の
  範囲外だが、間接的に実装の優先度に影響しうる）。

---

## 11. 確かめたこと・確かめていないこと

**確かめた【現物・実測】**

- `docs/decisions/0292-*.md`・`0324-*.md`・`0185-*.md`・`0134-*.md`・`0150-*.md`・
  `0320-*.md` を自分で開き、引用箇所を確認した。
- `packages/core/src/memory.ts`（`supersededById`/`contestedWithId` が列であること）、
  `packages/core/src/recall.ts:1190`/`recall-runtime.ts:1168`（`companionOf` が
  recall 実行時の注記であり列ではないこと）、`packages/core/src/runtime.ts`
  （`markContested`/`resolveContested` が厳密に2引数・CAS・部分成功無しであること、
  `ContestedDetectionOutcome` の3variant discriminated union であること）を自分で
  読んで確認した。
- `grep -rn "derivedFrom" packages/core/src` が0件であることを確認した。
- ADR 0327 が空き番号であることを `node scripts/adr-renumber.mjs --next` と
  `gh pr list --state open` で確認した（open PR に 0327 の主張なし）。
- Issue #207 本文・0292 全文・0324 全文（決定5/6・案B・負債2・負債6）・0185 決定4/5・
  採らなかった案1〜5 を自分で読んだ。

**確かめていないこと**

- ⛔ **決定2の(i)/(ii)/(iii)を実装した場合の実際のコスト比較**（プロトタイプを
  書いていない）——設計上の判断材料（既存契約への影響・backfill の要否）だけで
  比較した。
- ⛔ **決定4の(a) pairwise 完全グラフの行数増加が実際に問題になる N の値**
  ——real-fixture でN≥3が一度も観測されていないため、実測できる対象が無い
  （ADR 0324/0320 と同じ制約）。
- ⛔ **`RelationStore.link` を N×(N-1) 回呼ぶ場合のトランザクション境界**
  ——store 側の実装が無いため検証できない。§9-5 に次段の課題として明記。
- ⛔ **§4-d「契約 companion と `over_limit` の衝突」の具体的な解決方法**
  ——本 ADR はこの衝突が存在することだけを指摘し、解いていない。
- ⛔ **本番（Postgres + pgvector）での実測**。対象コードが未実装のため実施対象が
  無い（0292 と同じ）。
- ⛔ **この設計が実装された場合の6つの門・変異試験**。この PR は設計のみであり
  新規コードを含まないため該当しない。

---

Refs #207
