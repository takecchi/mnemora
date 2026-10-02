# ADR 0494: 穴探し — recall の fuzz に `relationStore`（多者間の群・`relationMaxCount`・`link`/`unlink`）と引数の変形（大文字の id・消した記憶の id）を足した。core の recall に 2 つの割れが出たので直した

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 要点

- **前提**: [ADR 0492](./0492-fuzz-profile-fields.md) が、harness に profile `"fields"` を足し、拾えなかった観点を挙げた【現物】。そのうち harness を少し広げれば届く 2 つ——(1) `relationStore` を配線して `relationMaxCount` と多者間の群を振る、(2) 操作に渡す id を変形する——を足した。
- **足したもの**（新しい profile 3 つ。`default`／`wide`／`fields` の同じシードの操作列は変えていない）:
  - `relations`: `relationStore` を配線する（この profile だけ）。操作 `group`（3 件の `markContestedGroup`）・`resolveGroup`・`link`・`unlink`、recall の `relationMaxCount`（省略／1／2／3）。
  - `argdead`: `forget`・`purge`・`restoreArchived`・`markContested`・`resolveContested`・`consolidate`・使用報告・`findCorrectionCandidates` の `excludeMemoryIds` に渡す id を、半分の確率で**消した記憶の id**（forget 済み／purge 済みを交互に）に差し替える。3 実装の差分にも載せる。
  - `argupper`: 同じ操作の id を半分の確率で**大文字**にする。単独の実装の不変条件だけで見る（3 実装の差分には載せない。下の決定2）。
- **不変条件を 2 つ足した**: I13（`excludeMemoryIds` は大文字小文字を無視して除外する。ADR 0485）、I14（群の同伴の数 ≦ 返った owner の数 × `relationMaxCount`。ADR 0381・0396）。
- **割れが 2 つ出た。どちらも core の recall 本体（3 実装が共有する `recall-runtime.ts`）の割れで、直した**（下の「割れ」）。

## 決定

### 1. `link`・`unlink` を操作の列に足した（ADR 0488 の縛りに触れない形で）

依頼主の許し（「`link`・`unlink` を操作の列に足してよい。ADR 0488 が縛った RelationStore の振る舞いを壊さないこと」）を受け、`relations` profile にだけ足した。

- **ADR 0488 が縛った面**【現物。PR #1599 の本文と ADR】: Fake の `link` は範囲外の `kind` を断る・`listRelated` は `createdAt` を複製して返す・`listRelated`／`listRelatedMany` は `kind` が偽の値のとき全件を返す（Postgres と同じ）。関係が残ること・forgotten などの記憶への `link` を断らないことは、新しく断る・遡って行を消す直しに当たるので触っていない。
- **足した形**【判断】: `kind` は常に `"contradicts"`（`RelationKind` の唯一の値）。端は、この実行で作った記憶の中の別々の 2 件（forgotten／purge 済みの墓標の行も含む＝観点4を触らず、そのまま振る）。範囲外の `kind`・偽の `kind`・自己 link・実在しない id・別テナントの記憶は渡さない。→ 0488 が縛った振る舞いのどれにも当たらない。
- 【実測】3 実装（Fake・testkit の InMemory・Postgres）とも、forgotten・purge 済みの端への `link`／`unlink` は例外にならず、差分も出なかった（`relations` の差分 80 シード）。

### 2. 大文字 id は 3 実装の差分に載せない——前任の判断は現物と合っていた

前任の草稿の判断「操作の対象の `id` の大文字小文字は、Postgres が受け、fixture（InMemory・Fake）は受けない（ADR 0446 の既存の違い）。0469・0475 が揃えたのはイベントの指し先（`NewMemoryEvent.memoryId`）の大文字小文字だけ」が現物と合うかを確かめた。

【実測】同じ 4 件の記憶に、操作の対象の id を小文字／大文字で渡し、終わった時点の status を 3 実装で比べた（使い捨ての試験。コミットしていない）。`A`=active、`F`=forgotten。

| 操作 | Postgres（小文字／大文字） | InMemory・Fake（小文字／大文字） |
|---|---|---|
| `forget(id)` | 1 件目が F／1 件目が F | 1 件目が F／**何も起きない（全部 A）** |
| forget 済みの `purge(id)` | F+purged／F+purged | F+purged／**F のまま（purge されない）** |
| `markContested(a, b)` | 2 件が contested／同じ | 2 件が contested／**何も起きない** |
| `resolveContested(a, b, supersede a)` | b が superseded／同じ | b が superseded／**対のまま（contested）** |
| `consolidate([a, b])` | 統合される／統合される | 統合される／**統合されない** |
| 使用報告（`memory_usage`） | 通る／通る | 通る／**`memory not found for tenant` を投げる** |
| `findCorrectionCandidates` の `excludeMemoryIds` | 除外される（I13 が 10 シード・80 シードで緑） | 除外される（I13 が緑） |

- 判断は現物と合っていた。**Postgres は大文字の対象 id を受けて状態を変え、fixture は黙って何もしない（`forget`・`purge`・`mark`・`resolve`・`consolidate`）か、`memory not found for tenant` を投げる（使用報告）**。差分に載せると割れとして誤報告になる。InMemory と Fake は同じ結果だった。
- **前任が書いていなかった事実**【実測】: 同じ「大文字の対象 id を受けない」でも、fixture は操作によって**黙って何もしない**か**例外を投げる**かが割れている（使用報告だけ投げる）。ADR 0446 の既存の違いの内側だが、操作ごとに挙動が違うことは材料に載せる（下の負債1）。
- `restoreArchived`（archived → active）の大文字は、この試験では確かめられなかった【未確認】（試験の前提の「archived になったか」を確かめていない。`argupper` が `restore` の archived を狙った回数も 0）。
- この判断に合わせて、harness に `FuzzBackend.acceptsUpperCaseIds`（Postgres だけ `true`）を足した。`false` の backend では、大文字にした id への `memory not found for tenant` だけを違反にしない（ほかの例外は違反のまま）。`true` の Postgres では**大文字の拒絶もそのまま違反になる**（下の変異 P1）。

### 3. purge 済みの id を狙う

前任の `deadNth` は forgotten だけを拾っていた。【現物】purge は行を消さず墓標（`status = forgotten` かつ `purgedAt` あり）にするので、forgotten の中に purge 済みが混じる。`deadNth` を、forget 済み（`purgedAt` なし）と purge 済みに分けて集め、`i` の偶奇で交互に狙う形にした（片方が無ければもう片方）。`ids` を別に記録する必要は無かった。

### 4. 追加の乱数は別の流れから引く

新しい profile の乱数は `r2`（`seed ^ 0x5bd1e995`）から引く。`default`／`wide`／`fields` では `r2` を引く分岐に入らない（`rel && …`、`argMu !== null && …` で短絡する）。**確認**: 変更前の harness（`bde1acef`、= ADR 0492 の版）と変更後の `genOps` の出力を、3 profile × seed 1〜500 × 長さ 60／120（計 3000 通り）で `JSON.stringify` が一致することを、使い捨ての試験で一度示した【実測】。最後の版でも通した。

### 5. 群の同伴の並びが割れる、harness 側の原因

`relations` の差分を最初に走らせたとき、Fake／InMemory と Postgres で群の単位の中の並び（同じメンバーの並びが入れ替わる）が割れた【実測。seed 1002・1018・1021・1062・1067】。原因は割れではない: 群の同伴の並び・切り捨ては「`validFrom` の新しい順→`id` の順」で、harness が作る記憶は `validFrom` が全員 `null` だったので `id` の比較に落ち、id が作成順の `mem-N`（Fake・InMemory）か乱数の uuid（Postgres）かで並びが違った。id の順は実装をまたぐ約束ではない。→ `relations` の実行だけ、作成ごとに別の `validFrom`（作成時刻）を付けた。直したあと、差分 80 シードで食い違いは無い。

## 割れ（core の recall の 2 つ。どちらも直した）

どちらも 3 実装が共有する core の `recall-runtime.ts` の割れで、Fake・testkit の InMemory・Postgres で同じ結果になる（だから 3 実装の差分には出ない。単独の不変条件で見つかった）。**直す前の赤を先に取ってから直した**。固定の歯は `packages/core/src/__tests__/recall-relation-fuzz-regressions.test.ts`（2 本。最小化した操作列を `runOps` に流す）。

### 割れ1: `relationMaxCount` で切った群のメンバーを、別の段でもう一度数える（I10-upper）

- **赤**【実測】: `relations` の seed 10（core の Fake。Postgres でも同じ seed 10 で赤）。`I10-upper: returned 3, counted 5, total 4`。`omitted` に `over_limit { stage: "relation" }` と `unit_assembly_dropped`（直しの途中は `below_threshold`）が重なり、スコープ内の記憶の数（`totalInScope`）より多く数えていた。
- **最小化した操作列**（7 操作）: 記憶 5 件を作る → `group(i=556, j=388, l=755)`（3 件の群）→ `recall`（`limit 4, overFetchFactor 2, 連想あり, budget 25, scoreThreshold なし, lexical あり, relationMaxCount 1`）。
- **原因**【現物】: 段3の群の探索が、`relationMaxCount` を超えて切ったメンバーを `over_limit { stage: "relation" }` に数える。その同じ記憶を、(a) 段3.5 の連想が候補に拾い（連想の `excludeIds` は `withinLimit`・同伴・アンカーだけで、切られたメンバーを含まない）、対向が取れず `unit_assembly_dropped` に数える。(b) 段2で `below_threshold`／`score_not_comparable`／`over_limit(rescore)` に既に数えられていた記憶なら、段3で切られた時点でさらに重なる。ADR 0203 の「1 件の記憶は `omitted` の中で 1 回だけ数える」に反する。
- **直し**【判断。約束（ADR 0203）に実装を戻す】: 切ったメンバーの id を `relationOverLimitIds` に持ち、(1) 連想の `excludeIds` に足す、(2) 段2の三つの「昇格して取り下げる」集合（`promotedFromBelowThreshold`・`promotedFromNotComparable`・`promotedFromOverLimit`）に足す（最後に落とした段で 1 回だけ数える、という既存の作法に揃えた）。
- **挙動の変化**: 連想の席が、切られた群のメンバー（どうせ対が取れず落ちる）に取られなくなる。席が空いた分、次の連想の候補が席に着きうる。返る記憶の集合が変わるのは「`relationMaxCount` を超える群があり、かつ連想がその群のメンバーを拾っていた」ときだけ。新しく断る入力は無い。

### 割れ2: `RelationStore.link` で `active` な記憶へ辺を張ると、その記憶が 2 回返る（I2-unique）

- **赤**【実測】: `relations` の seed 187（core の Fake、400 シードで初めて出た）。`I2-unique: ["mem-1","mem-3","mem-2","mem-6",…]`（同じ id が並ぶ）。
- **最小化した操作列**（8 操作）: 記憶 4 件 → `link(i=73, j=724)`（`mem-2 → mem-1` の一方向の辺。`mem-1` は `active` のまま）→ 記憶 1 件 → `group(463, 281, 517)`（`mem-4`・`mem-2`・`mem-3`）→ `recall`（`limit 4, overFetchFactor 1`）。
- **原因**【現物】: 段3の群の探索は `status !== "contested"` なメンバーでは先へ辿らないが、辺は記録する（`relationEdges`）。単位の組み立て（`collectGroupComponent`）はその辺を、**この recall の候補に居る記憶なら status を見ずに**群へ入れる。`mem-1` はすでに自分の単位として組まれているので、群の単位にも入り、結果に 2 回返る。`RelationStore.link` は公開の口で、`contradicts` の辺を群の外の記憶へ張ること自体は禁じられていない。群を離れたメンバー（ADR 0381 決定10）が辺を残したまま `active` で候補に居る場合にも同じことが起きうる【判断。後者は再現していない】。
- **直し**【判断。約束（結果に同じ記憶を 2 回返さない）に実装を戻す】: `collectGroupComponent` が、この recall の候補に居る記憶のうち、群のメンバー（`contested` かつ `contestedWithId` なし）でないものを、群にも入れず、そこから先も辿らない。
- **挙動の変化**: 以前は同じ記憶が 2 回返っていた入力が、1 回返るだけになる。以前に正しく返っていた入力は変わらない。

## 実測の結果

【実測。手元の PostgreSQL 17（`initdb`、UTF8 + C.UTF-8）+ pgvector、node v22.23.3】

### 各 profile の結果

| profile | core（Fake） | Postgres | 3 実装の差分 |
|---|---|---|---|
| `relations` | 割れ 2 件（上）。直したあと、20 シード（既定）・1500 シード・長さ 150 の 600 シードで違反なし | 10 シード（既定）で割れ1（seed 10）。直したあと、10 シード（既定）・80 シード（seed 1000〜1079）で違反なし | 80 シード（seed 1000〜）で食い違いなし（`validFrom` を別付けにしたあと。決定5） |
| `argdead` | 20 シード（既定）・600 シードで違反なし | 10 シード（既定）・80 シード（seed 1000〜）で違反なし | 80 シード（seed 1000〜）で食い違いなし |
| `argupper` | 初回は例外（`FakeMemoryStore: memory not found for tenant: MEM-4`、使用報告）。決定2の許容を入れたあと、20 シード・600 シードで違反なし | 10 シード（既定）・80 シード（seed 1000〜）で違反なし（大文字の拒絶は違反として扱う設定） | 載せない（決定2） |

### 探した形（操作 × 変形。core の Fake で seed 1〜20 × 60 操作を数えた回数）

- `argdead`（狙った記憶の状態別）: `forget` ×（forgotten 14・purged 6・active 9・superseded 2）、`purge` ×（forgotten 12・purged 7・active 5・contested 1）、`restore` ×（forgotten 7・purged 3・active 1）、`mark` ×（forgotten 39・purged 29・active 15・contested 4・superseded 3）、`resolve` ×（forgotten 19・purged 8・active 2）、`consolidate` ×（forgotten 14・purged 12・active 8）、使用報告 ×（forgotten 14・purged 7）、`findCorrectionCandidates` の除外 ×（forgotten 6・purged 1・active 3）。「active」「contested」「superseded」は、消した記憶がまだ無くて元の id に戻った回数。
- `argupper`: `forget` 31、`purge` 25、`restore` 11（すべて active を指した。archived は 0）、`mark` 90、`resolve` 29、`consolidate` 34、使用報告 25、`findCorrectionCandidates` の除外 10（状態別の内訳は `RunOutcome.shapes` に出る）。
- `relations`: `group` 30・`resolveGroup` 30・`link` 9・`unlink` 13・`mark` 18、recall の `relationMaxCount` は省略・1・2・3。
- **薄い形・当たっていない形**: `restore` の archived を大文字で（0 回）、`restore` の purged を狙う形（3 回）、`link`・`unlink` の本数（20 シードで 9・13）、`group`／`resolveGroup` のメンバーを大文字・消した id にする形（足していない）。`resolve` は contested の記憶にだけ呼ぶ作りで、`argdead` だけは contested でない対を渡す。

### 足した分の実行時間

| ファイル | 前（既存の leg だけ） | 足した leg | 全体 |
|---|---|---|---|
| `recall-invariant-fuzz.test.ts`（core、Fake） | default 2.4 + fields 0.9 ≒ **3.3 秒** | relations 0.8 + argdead 0.9 + argupper 0.8 ≒ **2.5 秒** | 約 6.2〜6.7 秒（ファイル全体の実時間） |
| `recall-invariant-fuzz.postgres.test.ts` | default 25.6 + wide 23.0 + fields 4.5 + 差分（Fake 19.6・testkit 0.9）+ 差分 fields（4.7 + 0.2）+ 陽性対照 0.1 ≒ **78.6 秒** | relations 5.6 + argdead 6.2 + argupper 4.8 + 差分 relations 4.8 + 差分 argdead 6.2 ≒ **27.6 秒** | 112.3 秒（ファイル全体の実時間） |

「前」は、同じ実行の中の既存の `it` の所要時間の和。ばらつきがある（同じ default を別の実行で測ると 18.3〜25.6 秒）。足した分は core で約 2.5 秒、Postgres で約 28 秒。

### 変異試験（変異を入れて、どの leg が赤になるか。終わったら `cp` で戻し、`git status` で差分が残っていないことを確かめた）

| 変異 | 既存の profile（default・wide・fields） | 新しい profile |
|---|---|---|
| **ADR 0485**: `excludeMemoryIds` の小文字化を外す（`runtime.ts`） | 緑のまま | **`argupper` が赤**（I13、seed 2・9・10・13・17・19 ほか） |
| Postgres の `normalizeUuidCase`（ADR 0438・0456 系の入口の正規化）を恒等にする（`mapping.ts`） | 緑のまま（relations・argdead も緑） | **`argupper` が赤**（`mark: PostgresMemoryStore: memory not found for tenant: <大文字の uuid>`、seed 1・3・5・6・10 ほか） |
| **relationMaxCount の実装**: `relationMaxCount` を無視して既定値を使う（`recall-runtime.ts`） | 緑のまま（`relationStore` を配線しないので、この段が走らない） | **`relations` が赤**（I14、seed 1・5・10・11） |
| 同上、`over_limit(relation)` の件数を +1 にする | 緑のまま | **`relations` が赤**（I10-upper、seed 10） |
| 割れ1の直しを戻す（切ったメンバーを連想の `excludeIds` から外す） | 緑のまま | **`relations` が赤**（I10-upper、seed 10）。固定の歯も赤 |
| 割れ2の直しを戻す（`collectGroupComponent` の絞りを外す） | 緑のまま | 既定の 20 シードでは**緑**（seed 187 は 400 シードで出る）。**固定の歯が赤**（I2-unique） |
| **ADR 0469**: Fake の `assertEventTargetOwn` の小文字化を外す | 緑のまま | **緑のまま（拾えなかった）** |
| **ADR 0475**: Fake の `FakeEventStore.append` の小文字化を外す | 緑のまま | **緑のまま（拾えなかった）** |
| ADR 0475（Postgres 側）: `PostgresEventStore.append` の `normalizeUuidCase(event.memoryId)` を外す | 緑のまま | 緑のまま（拾えなかった） |
| ADR 0469（Postgres 側）: `checkedRef` の `toLowerCase()` を外す | 緑のまま | 緑のまま（拾えなかった） |

- **ADR 0469・0475 を拾えなかった理由**【判断】: 0469・0475 が揃えたのは「**イベントの指し先** `NewMemoryEvent.memoryId` が大文字」の場合で、Runtime がその値を作るのは操作の対象の id を渡すとき。fixture（InMemory・Fake）は大文字の対象 id を操作の入口で断る・黙って何もしない（決定2の表）ので、**大文字のイベントの指し先に届かない**。Postgres 側の 2 つの変異（`event-store.ts` と `checkedRef`）は、`id = $1` の比較が uuid 型の列に対して行われ、大文字小文字を区別しないので、小文字化を外しても結果が変わらない（等価に近い変異。ここは実測していない＝【未確認】）。→ **0469・0475 の穴は、この fuzz では守れない**。固定の歯（`fake-event-target-belongs-to-ctx-tenant.test.ts`・`event-target-parity.postgres.test.ts` ほか）が守っている。
- 0485 は fuzz の操作（`findCorrectionCandidates`）が無かったので、`fcc` 操作と I13 を足して届くようにした。

## 検討した代替案

1. **`link`／`unlink` を足さず、`markContestedGroup`／`resolveContestedGroup` だけにする**（前任の設計）。採らなかった。依頼主が許し、0488 の縛りに触れない形で足せた。しかも割れ2はこの形で初めて出た。
2. **大文字の id も差分に載せ、fixture の断りを許す**。採らなかった。操作ごとに挙動が違う（黙って何もしない／例外）ので、差分の側に操作ごとの許容表が要り、本物の割れを隠す。
3. **割れ1を、連想の候補から外さず、`unit_assembly_dropped` の件数だけ引く**。採らなかった。`over_limit(association)` の件数でも同じ重なりが起きうる（切られたメンバーが連想の席を競り負ける場合）ので、候補から外すほうが一箇所で足りる。
4. **割れ2を、`link` の側で断る**（群の外の記憶への辺を張れなくする）。採らなかった。前例の無い新しい断りで、ADR 0488 が縛った面に近い。recall が自分の絞りを持つほうが、群を離れたメンバーの辺にも効く。

## 引き受けた負債（材料。決めるのはクローンまたはオーナー）

| # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
|---|---|---|---|---|---|
| 1 | 大文字の対象 id の扱いが、fixture の中で**操作によって割れている**（黙って何もしない：`forget`・`purge`・`mark`・`resolve`・`consolidate`／例外：使用報告）。Postgres は全部受ける | 決定2の表 | 呼び出し側が大文字の id を渡すと、fixture では状態が変わったか分からない。直すなら fixture を Postgres に揃える（前例: ADR 0469・0475）か、断りに揃える（新しい断り＝オーナーの領分） | 低 | 大文字の対象 id を fixture でも受ける方針を決めるとき |
| 2 | 0469・0475 の穴を fuzz で守れていない | 変異試験の表 | 固定の歯だけが守る | 低 | fixture が大文字の対象 id を受けるようになったとき（そこで `argupper` を差分に載せられる） |
| 3 | `RelationStore.link` で群の外の記憶（`active` など）へ辺を張れる。recall は割れ2の直しで耐えるが、`resolveContestedGroup` の部分解消の確認（`WITH RECURSIVE` の連結）がその辺をどう数えるかは未確認 | — | 【未確認】この fuzz の `resolveGroup` は `markContestedGroup` で作った群だけを解決するが、`link` で張った辺が同じ連結に入りうる。そのとき `resolveContestedGroup` の CAS が余分な記憶を群の一員として扱うかは測っていない | 低 | 群の外へ辺を張る呼び出し側が現れたとき |

## これが覆るとしたら

- 決定2: fixture が大文字の対象 id を受けるようにしたとき（`argupper` を差分に載せる）。
- 割れ1: `over_limit(relation)` の件数を、他の段が数えた分と重ねて名乗ってよい、という約束に改めたとき（ADR 0203 の「1 回だけ」を緩めるとき）。
- 割れ2: 群の外の記憶への辺を、群の連結として扱う約束に改めたとき。

## 測っていないこと

- `relations` の長さ 60 より長い操作列を Postgres で（core の Fake では 150 まで）。
- HNSW を通す脚（`seqscan_off`）への新しい profile の適用（差分は `indexscan_off` だけ。ADR 0193 の理由）。
- `group`／`resolveGroup` のメンバーを大文字・消した id にする形、`restoreArchived` の archived を大文字で呼ぶ形（上）。
- Postgres 側の 0469・0475 の変異が等価かどうか（上）。
- 実際の埋め込み provider。
