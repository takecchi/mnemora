# ADR 0438: 別テナントを混ぜた歯を足す・purgeMemory の大文字の id を直す・subject カウンタの相関サブクエリの修飾を直す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（担い手。マネージャーの指示による）が書いた。直し方はクローンが決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元（PostgreSQL 17 + pgvector、`initdb` で立てた自分専用のインスタンス）で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  今週 main に入った変更のテナント分離を点検した（対象は `packages/postgres/src`・`migrations`・testkit の fixture・core の interface を変えた60本の PR）。読み取り・書き込み・削除が別テナントの行に届く口は見つからなかった。その一方で、次の3点が残った。

  **(1) 歯の欠け。**【実測】各 SQL の `tenant_id` の絞りを `TRUE` に置き換える変異を当てると、適合テストと関連テストが緑のまま通る口が8つあった。現在のコードは正しい（使い捨ての probe で、A の ctx に B の id を渡しても B の行が変わらないことを確かめた）。だが、誰かが絞りを落としても検知できない。

  **(2) `purgeMemory` の大文字の id。**【実測】`purgeMemory(ctx, id.toUpperCase(), …)` は `memories` の行を purge するが、`recalls.index_band` の目次帯（`digestBand`）の digest を書き換えなかった。【現物】`memories` の UPDATE は uuid 型で比べるので大文字でも当たるが、目次帯の UPDATE は `elem->>'memoryId' = ${id}` と文字列で比べるため、小文字の id にしか当たらない。`Runtime` は `get` が返した小文字の id を渡すので、到達するのは store を直接呼ぶ経路だけである。

  **(3) 実バグ: subject 単位の活動カウンタを引く相関サブクエリ。**(1) の歯を書いている途中で見つけた。【現物】`activity-decay-sql.ts` の `subjectActivitySeqOrZero` は `WHERE sa.tenant_id = ${tenantIdExpr} AND sa.subject_id = ${subjectIdExpr}` という相関サブクエリを作る。`aggregateScope`（`memory-store.ts`、`flags` CTE の `is_decayed`）と `buildArchiveDecayedTargetSelect` は、この式に**修飾の無い** `tenant_id`・`subject_id` を渡していた。サブクエリの中で修飾の無い列名は内側の `tenant_subject_activity` の列に解決されるので、2つの等号は恒真になり、テナントも subject も絞れていなかった。`aggregateScope` の側はさらに、`flags` が `FROM scoped` で `scoped` が `tenant_id` を射影していないため、外側の列としては解決できない形だった。コメントは「エイリアス無しの `memories` そのものなので `tenant_id`/`subject_id` をそのまま渡す」と書いていたが、そう読めるのは外側の `FROM` が `memories` のときだけである。

- **決めたこと**:

  1. **これまで歯の無かった口に、別テナントを混ぜた歯を足す**（`packages/postgres/src/__tests__/tenant-boundary-teeth.postgres.test.ts`）。どの it も「B に行を作り、A の ctx（または A の行）から触って、B の行が変わらない」ことに加えて、「A 自身の操作は通る」ことを同じ it の中で見る（常に拒む実装で緑にならないため）。B の行が A の id を指す形・A の行が B の id を指す形は API からは作れない（既知の負債、`docs/memory-model.md` §5 の #854/#1051 の追記）ので、その形の入力は生 SQL で作る。
  2. **`purgeMemory` の入口で `normalizeUuidCase` を通す。** 他の口（`markContestedPair`・`restoreSupersededBy` など）と同じ入口の作法である。落ちる入力は増やさない（uuid の形でない id は今までと同じ `memory not found for tenant`）。歯は `purge-memory-uppercase-id.postgres.test.ts`。
  3. **subject カウンタの相関サブクエリに、修飾した列を渡す。** `buildArchiveDecayedTargetSelect` は `memories.tenant_id`・`memories.subject_id`（`reinforce` の `memory-store.ts` の同型の呼び出しと同じ形）。`aggregateScope` は、`scoped` の行がすべて `ctx.tenantId` のものであることを使ってテナントを値（`${ctx.tenantId}`）で渡し、subject は `scoped.subject_id` で修飾する（`scoped` の射影に列を足さない。ADR 0303 の前提を縛る字句の歯が `scoped` の本体を読んでいる）。落ちる入力は増やさない。歯は `activity-subject-counter-tenant-qualification.postgres.test.ts`。
  4. **影響の範囲**（【判断】）: `decay_clock=activity` で、テナント単位ではなく subject 単位のカウンタ（`usesSubjectActivityCounters` / `decayFloorSeqUsesSubjectCounters`）を使うときに限る。`tenant_subject_activity` に行が2本以上あると、`archiveDecayed` と `aggregateScope`（忘却ゲートの件数）が「more than one row returned by a subquery」で落ちる。行が全体で1本だけのときは、別テナント・別 subject のカウンタを黙って使う。壁時計のゲート・テナント単位のカウンタ・`search`/`searchMany`（`m.tenant_id` で修飾済み）・`reinforce` 系（`memories.`・`m.` で修飾済み）は影響を受けない。別テナントの行が読める・書ける・消せる形ではなく、別テナントのカウンタの数値が判定に混ざる形である。
  5. **C1 の形（別テナントの id を参照する書き込み口が、別テナントの purge・erase を止めうる）・C2（`resolveContestedGroup` の `supersededById` の文書）・C4（識別子の検査の漏れ2入力）は、この PR では扱わない。**

- **歯の赤→緑の実測**:

  【実測】変異は `tenant_id = …` を `TRUE` に置き換える（記載が無ければ）。赤は `tenant-boundary-teeth.postgres.test.ts` の10件のうち1件が落ちたこと、緑は10件すべて通ったこと。元の実装では10件すべて緑。

  | 口 | 変異 | 結果 |
  |---|---|---|
  | `markContestedGroup` の3段（存在検査・UPDATE・関係の CTE） | 3段同時 | 赤 |
  | 同上 | 1段だけ | 緑（ほかの2段が拒むため。等価な変異） |
  | `resolveContestedGroup` の存在検査と UPDATE | 2段同時 | 赤 |
  | 同上 | 1段だけ | 緑（等価） |
  | `resolveContestedGroup` の到達集合の `memories` 側（`m.tenant_id`） | 単独 | 赤 |
  | `resolveContestedGroup` の再帰 CTE の関係側（`r.tenant_id`） | 単独 | 緑（`m.tenant_id` が別テナントの行を落とすため。等価） |
  | `resolveContestedGroup` の関係の DELETE | 単独 | 赤 |
  | `VectorStore.delete`（単発） | 単独 | 赤 |
  | `search()` の統計ありの枝（`e.tenant_id = ctx`） | 行を消す | 赤 |
  | `purgeExpiredRecalls` の usage の数え（dryRun）・DELETE | それぞれ単独 | 赤・赤 |
  | `listRelatedMany` の kind 付きの枝 | 単独 | 赤 |
  | `previewRestoreSupersededBy` のイベントとの結合（`me.tenant_id`） | 単独 | 赤 |
  | 活動時計の subject の相関（`activity-decay-sql.ts` の `sa.tenant_id`） | 単独 | 赤（vector search の歯） |

  実バグの歯（`activity-subject-counter-tenant-qualification.postgres.test.ts`、4件）: 直す前は4件とも赤（2件は「more than one row returned by a subquery」、2件は別テナントのカウンタで判定が変わる）、直した後は4件とも緑。`purge-memory-uppercase-id.postgres.test.ts`: 直す前は赤（`expected 'SECRET-DIGEST' to be '[purged]'`）、直した後は緑。

  等価な変異に歯を作らなかった理由: 同じ文の前段がテナントで絞った id だけを渡す、または後段が別テナントの行を落とす、という二重の守りがある。1段だけ外しても結果が変わらないので、歯が存在しない。二重の守りを両方外すと赤になる歯で、守りの存在そのものは縛られている。

- **採らなかった案**:

  - **`*-conformance.ts` に足す案。** 採らなかった。conformance の追加はオーナーの専権であり、この歯は Postgres の SQL の絞りを縛るもの（生 SQL で負債の形を作る）で、adapter 一般の契約ではない。#809 の方針と同じく、個別のテストに置いた。インメモリには SQL が無く、別テナントの歯は既存の適合テストが縛っているので、インメモリの個別のテストは足していない。
  - **二重の守りの片方を外す案。** 採らなかった。防御の二重化を減らすと、歯の欠けではなく守りの欠けになる。
  - **`aggregateScope` の `scoped` に `tenant_id` を射影する案。** 採らなかった。`scoped` の本体を字句で読む歯（ADR 0303 の前提）があり、射影を変えると歯と本体を同時に直すことになる。値で渡すほうが差分が小さい。
  - **C1・C2・C4 をこの PR に入れる案。** 採らなかった。C1 は別の担当（ADR 0436）と重なり、C2 は C1 と一緒に文書を書き直す。C4 は新しく throw する入力を増やすのでオーナーの専権で、別の担当（ADR 0437）に入る。
  - **`purgeMemory` 以外の `isUuidLike` だけの入口に `normalizeUuidCase` を足す案。** 採らなかった。【実測】点検したすべての入口は uuid 型の列との比較だけで、大文字でも結果が変わらない。変わるのは、エラー文や `conflicted[].id` に呼び出し側が渡した綴りがそのまま載ることだけである。

- **引き受けた負債**:

  - 歯の一部は、負債の形（別テナントの id を指す行）を生 SQL で作る。ADR 0436 で複合 FK などが入ると、その形が作れなくなり、該当の it は直す必要がある。
  - `aggregateScope` がテナントを値で渡すことは、`scoped` の行がすべて同じテナントであることに依る。`scoped` の `WHERE tenant_id = …` を外す変更は、この前提も壊す。

- **これが覆るとしたら**:

  conformance に別テナントの歯を足す方針にオーナーが変えたとき、個別のテストの一部をそちらへ移すことになる。

- **追記（2026-10、[ADR 0439](./0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)）**: 上の「引き受けた負債」の1つめ（歯の一部が、別テナントの id を指す行を生 SQL で作る）と、決定5（C1・C2 はこの PR では扱わない）について。
  ADR 0439 で、C1（別テナントの id を参照する書き込み口が、別テナントの purge・erase を止めうる）と C2（`resolveContestedGroup` の `supersededById`）を塞いだ。API からは、別テナントを指す行が書けなくなった。
  この ADR の歯は生 SQL で形を作っているので、壊れていない（`tenant-boundary-teeth.postgres.test.ts` の10本は、ADR 0439 の枝で緑のまま。`erase-tenant.postgres.test.ts` の `superseded_by_id` の歯も同じ）。
  壊れたのは、形を API で作っていた既存の適合テスト2本（`restoreSupersededBy`・`previewRestoreSupersededBy` の別テナントの it）だけで、ADR 0439 の決定9で直した。
