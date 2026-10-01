# ADR 0494: 穴探し — recall の fuzz を、`relationStore`（多者間の群と `relationMaxCount`）と、引数の変形（大文字の id・消した記憶の id）へ広げる（草稿・作業中）

- **状態**: 草稿 (2026-10。作業中。実測の結果で書き換える)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つ〔前例の無い新しい断り・既定値の変更・公開 API を足す・suite に約束を足す・遡ってのデータの書き換え・適用済みの migration の編集〕は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 草稿の要点（器の入れ替えで文脈が失われても引き継げるように、先に書く）

- **前提**: [ADR 0492](./0492-fuzz-profile-fields.md)（PR #1600、未マージのとき、この枝はその上に積んである）が、harness に profile `"fields"` を足し、拾えなかった観点を挙げた。このうち harness を少し広げれば届く 2 つを足す。
- **1. `relationStore` をつなぐ**:
  - harness は `relationStore` を配線していないので、`RecallQuery.relationMaxCount` と多者間の群（`markContestedGroup`／`resolveContestedGroup`、ADR 0381・0396）を振れなかった。
  - 3 実装とも `RelationStore` を持つ【現物】: core の Fake（`createFakeRuntimeStores().relationStore`）、testkit の `new InMemoryRelationStore(memoryStore, memoryStore.relations)`、Postgres の `PostgresRelationStore(db)`。差分の検査から外す実装は無い。
  - **ADR 0488（PR #1599、`RelationStore` の面）が縛った振る舞い**【現物。PR 本文と ADR】: Fake の `link` は範囲外の kind を断る・`listRelated` は `createdAt` を複製して返す・`listRelated`/`listRelatedMany` は `kind` が偽の値のとき全件を返す（Postgres と同じ）。**関係が残ること、forgotten などの記憶への `link` を断らないことは、新しく断る・遡って行を消す直しに当たるので触っていない**。→ この fuzz は `link`/`unlink` を直接は呼ばず、Runtime の `markContestedGroup`／`resolveContestedGroup` だけを通す。範囲外の kind を渡す操作や、`kind` が偽の値の読みは入れない。forget・purge 済みの記憶が群に残る振る舞い（0488 の観点4）は、変えずにそのまま振る（直さない）。
  - 足す: 操作 `group`（3 件以上の `markContestedGroup`）・`resolveGroup`、recall の `relationMaxCount`。新しい profile `"relations"`（`relationStore` を配線するのはこの profile だけ。配線すると recall の段3が変わるので、既存の profile の結果を動かさない）。
- **2. 引数を変形する**:
  - `forget`・`purge`・`restoreArchived`・`markContested`・`resolveContested`・`consolidate`・使用報告に渡す id を、(a) 大文字にする、(b) 消した（forget・purge 済みの）記憶の id を狙って渡す。
  - **ADR 0469・0475・0485 の約束**【現物】: 0469・0475 は、`NewMemoryEvent.memoryId`（イベントの指し先）の大文字小文字を、Postgres・InMemory・Fake の 3 実装で「区別しない（小文字にそろえて引き、積む `memoryId` も小文字）」にそろえた。**操作の対象の `id`（`updateStatusWithEvent(ctx, id, …)` の `id` など）の大文字小文字は、Postgres が受け、fixture（InMemory・Fake）は受けない——ADR 0446 の既存の違い**で、0469・0475 は触れていない。0485 は `findCorrectionCandidates` の `excludeMemoryIds` を小文字にそろえて突き合わせる。
  - **既知の設計上の違いの扱い**: 大文字の操作対象 id は、3 実装の差分の検査には載せない（Postgres は受けて状態が変わり、fixture は受けず、状態が分かれるので、割れと誤認する）。単独の実装の不変条件（I1〜I12、例外が出ない、状態が壊れない）だけで見る。消した記憶の id を狙う変形（b）は、3 実装の差分にも載せる（どの実装も同じ振る舞いを約束しているはず）。
  - 足す: profile `"argdead"`（消した記憶の id を狙う。差分あり）と `"argupper"`（大文字。不変条件のみ）。
- **作法**: 追加の乱数は別の流れから引き、`default`／`wide`／`fields` の同じシードの操作列を変えない。足した分の実行時間を前後で測る。変異で「既存の profile では拾えず、新しい欄で拾える」ことを見せる。
- **線**: 割れが出たら、約束に実装を戻すのは内側（直す前の赤を先に見せる）。線の外は材料。seed と最小化した操作列を ADR に書き、固定の歯にもする。

## 実測の結果

（作業中。追記する。）
