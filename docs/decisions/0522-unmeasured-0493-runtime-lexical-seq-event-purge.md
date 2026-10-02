# ADR 0522: 穴探し — ADR 0493 §9「測っていないこと」の実測。Runtime 層の「消した後の参照」・`LexicalFilter` の seq 欄・`purgeExpiredEvents` の後の参照（割れは見つからなかった。歯を足した）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-2c9f30d0 の指示による）が書いた。[#1603](https://github.com/takecchi/mnemora/pull/1603)（ADR 0493）の上に積んでいる（#1603 のマージ前は、その commit が差分に含まれる）。直す線（約束に実装を戻す・落ちる入力を減らす・Fake・InMemory を Postgres に揃える・型の外の入力を新しく断る）の中だけを直す方針だったが、**直す割れは見つからなかった**。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22、PostgreSQL 17 + pgvector を自分専用のポート `54871` で）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0493 の §9「測っていないこと」に3点が残った。(1) Runtime 層（forget・purge・restore・recall・applyCorrection など）での「大文字の id」と「消した後の参照」の組み合わせ。(2) `LexicalStore.search` の `filter` の seq 欄（`decayFloorAtAfter`・`decayFloorSeqAfter`）。(3) `purgeExpiredEvents` の後の `EventStore.get`・`list`。この ADR は3点を、Fake（core）・InMemory（testkit）・Postgres の3者に同じ入力を流して測る。

## 結果

### (1) Runtime 層 × 消した後の参照【実測。3者に同じ操作列を流した】

- **小文字の id（Runtime が使う通常の形）: 3者が一致した。割れなし。** 対象は `forget`（単体・`memoryIds`＋実在しない id）・`purge`・`restoreArchived`・`restoreSuperseded`（superseder が消えている場合）・`markContested`・`resolveContested`・`recall`（`channels: ["ann","lexical"]`）・`reembed({ memoryIds })`・`findCorrectionCandidates`＋`applyCorrection`・`getRecall`・`observe({ kind: "memory_usage" })`。記憶の状態は active・forgotten・archived・purge 済み（墓石）。結果の種類（`forgotten`・`already_forgotten`・`purged`・`already_purged`・`status_not_forgotten`・`status_not_archived`・`restored`・`ineligible` の `sides`・`not_a_candidate`・`contested` など）、操作後の status・イベントの種類、recall に出る・出ない、がすべて同じだった。
  - 一致の中身の例: purge 済みの記憶への `forget` は `already_forgotten`、`purge` は `already_purged`。forgotten・archived・purge 済みの記憶は `recall` に出ない。superseder が purge 済みでも `restoreSuperseded` は旧い記憶を `active` に戻す。forgotten の記憶に `observe({ kind: "memory_usage" })` を当てると強化される（purge 済みでも `observe` は落ちない）。
  - 見かけの割れ（実装の差ではない）: (a) 同点の候補の並び。同じベクトル・同じ語の記憶が2件あると、tie-break が `memoryId` の昇順なので、`mem-N`（Fake・InMemory）と uuid（Postgres）で並びが逆になる。(b) 同点のベクトルが多いと、`findCorrectionCandidates` の窓（既定の件数）から候補が溢れて、Postgres だけ `not_a_candidate` になる。測定では `limit` を広げて避けた。(c) 返り値の `observationId`・`id` の形と、オブジェクトのキー順。
- **大文字の uuid の id: 割れる。ただし全て、操作の対象の `id` を大文字で渡すと Postgres は同じ行として扱い、Fake・InMemory は不在扱いにする、という既知の形**（ADR 0446・0469。揃える直しは ADR 0521 の担当）。**この ADR では直さない。** 測った組み合わせ（Postgres → Fake・InMemory）:
  - `forget`（active・archived → `forgotten` が `not_found`、forgotten・purge 済み → `already_forgotten` が `not_found`）
  - `purge`（forgotten → `purged` が `not_found`、active・archived → `status_not_forgotten` が `not_found`、purge 済み → `already_purged` が `not_found`）
  - `restoreArchived`（archived → `restored` が `not_found`、ほかの状態 → `status_not_archived` が `not_found`）
  - `restoreSuperseded`（`supersededById` が大文字: Postgres は旧い記憶を復元、Fake・InMemory は復元ゼロ件）
  - `markContested`・`resolveContested`（Postgres は `eligible`／`status_*` を返し、Fake・InMemory は両側 `not_found`）
  - `reembed({ memoryIds })`（Postgres 1件、Fake・InMemory 0件）
  - `applyCorrection`（`correctedId` が大文字: Postgres は `contested` まで進み、Fake・InMemory は `not_a_candidate`。Runtime が候補の突き合わせだけ小文字にそろえ〔ADR 0446〕、store には渡された綴りのまま渡すため）
  - 消した後の状態（forgotten・archived・purge 済み）× 大文字は、小文字のときの一致が、Postgres 側だけ「その状態の結果」を返し、Fake・InMemory は `not_found` になる、という同じ形に出る。
  - `recall` 自体は大文字の id を受けない（`RecallQuery` に `excludeMemoryIds` は無い。渡しても3者とも黙って無視する）。`getRecall`・`observe({ kind: "memory_usage" })` の `recallId` は、小文字では3者一致（大文字は ADR 0521 の面）。

### (2) `LexicalStore.search` の `filter` の seq 欄【現物＋実測】

- **型にない。** `LexicalFilter`（`packages/core/src/interfaces/lexical-store.ts`）は `tenantId`・`status`・`subjectId`・`includeSubjectless`・`excludeProvenanceKinds`・`occurredAfter`・`occurredBefore`・`validAt`・`attributes`・`labels` だけを持ち、`decayFloorAtAfter`・`decayFloorSeqAfter` は持たない。TSDoc が「`decayFloorAtAfter` は持たない。`VectorFilter` はこれを持つが…」と明記している（`lexical-store.ts` 16 行付近・54 行付近。`@mnemora/postgres` の `lexical-store.ts` 55 行付近も同じ）。ANN の段1だけが忘却ゲートを押し下げ、語彙チャンネルは後置フィルタ（ADR 0092）で扱う設計。
- **型の外から渡したとき（`decayFloorAtAfter` が Invalid Date・遠い未来、`decayFloorSeqAfter` が NaN・5）: Fake・InMemory・Postgres（`PostgresLexicalStore`）の3者とも黙って無視し、ヒット数は変わらない**【実測】。割れなし。**断らない**。型の外の入力を断る棚卸し（ADR 0496〜0519）の面と重なるので、ここでは新しい断りを足さない（ADR 0493 の E3 は `VectorStore` だけを見ていて、`LexicalStore` は「型に無い欄」だった。これで §9 の未確認が閉じる）。

### (3) `purgeExpiredEvents` の後の `EventStore` の参照【実測。3者一致】

- 掃除された古いイベントは `EventStore.get` で `null`、`list`（全件・`memoryId`・`since`・`until`・`limit`）に出ない。残ったイベントは読める。
- 掃除の記録（`kind: "events_purged"`）が1件積まれ、`memoryId` は `null`、`actor` は `{ type: "system" }`、`meta` は `purgedCount`・`oldestPurgedAt`・`newestPurgedAt`・`olderThan`（`kind` を絞った `list` で読める）。掃除の記録自身は、次の掃除（`olderThan` が遠い未来）でも消えない。
- 2回目の掃除は 0 件。`dryRun` は件数だけ数え、何も消さない。`limit: 1` で `reachedLimit: true`。境界（ちょうど `olderThan` の時刻のイベント）は消えない（狭義の `<`）。別テナントのイベントは消えない。`purgeExpiredEventsByRetention`（保持の設定あり）も同じ。掃除の後に同じ記憶へ新しいイベントを足せる。`eraseTenant` の後は `list` が空。記憶の `purgeMemory`（墓石）が積んだ `purged` イベントも掃除の対象で、記憶の status・墓石の本文は変わらない。
- 測定の過程で見つけた**測定用の組み立ての誤り**（実装の割れではない）: `InMemoryTenantSettingsStore` は `InMemoryMemoryStore` の `eventRetentionDays` を引数で渡さないと、`purgeExpiredEventsByRetention` が設定を読めず `unset` を返す（適合テストの組み立て `in-memory-fixtures.conformance.test.ts` は渡している）。

## 決定したこと

1. 割れが無かったので、実装・公開 API・既定値・CHANGELOG・`docs/migration-v1.md` は変えていない。
2. **一致している今の振る舞いを歯で縛った**（足した歯。conformance suite には足さない）:
   - `packages/core/src/__tests__/fake-runtime-after-delete-parity.test.ts`（Fake）
   - `packages/postgres/src/__tests__/runtime-after-delete-parity.postgres.test.ts`（InMemory と実 Postgres）
   - 2つは同じ操作列と同じ `EXPECTED`（37 項目）を持つ。Postgres で実測した値が `EXPECTED`で、Fake・InMemory・Postgres がそれに一致することを縛る。大文字の id は入れていない（ADR 0521 の面）。
3. 型の外の `LexicalFilter` の欄は断らない（上の (2)）。

## 変異試験【実測】

歯が噛むことを、実装を1つずつ曲げて確かめた。戻した後は `git status` に歯の2ファイル以外が無い。
- Fake の `purgeExpiredEvents` の境界を `<` から `<=` に（Fake の歯が赤）。
- InMemory の `purgeExpiredEvents` の境界を `<` から `<=` に（InMemory・Postgres の歯が赤）。
- Fake が掃除の記録の `purgedCount` を 0 にする（Fake の歯が赤）。

## 検討した代替案

1. **大文字の id を Fake・InMemory で揃える。** 採らなかった。ADR 0521 の担当で、この ADR の外。
2. **`LexicalFilter` に `decayFloorAtAfter`・`decayFloorSeqAfter` を足す、または型の外の値を断る。** 採らなかった。前者は公開 API を足す変更で、語彙チャンネルを忘却ゲートに掛ける設計判断（ADR 0092）。後者は ADR 0496〜0519 の面。
3. **歯を足さず、結果だけ書く。** 採らなかった。一致している3者が将来割れたときに気づける歯が無い。

## これが覆るとしたら

- 大文字の id を fixture で揃える（ADR 0521）。そのとき、この ADR の歯に大文字の組み合わせを足す。
- 語彙チャンネルに忘却ゲートの押し下げを足すと決めたとき（`LexicalFilter` に欄が増え、(2) の「無視する」が変わる）。

## 測っていないこと

- 大文字の uuid を `observe`・`reextract`・`consolidate`・`reflect` の対象に渡した場合（ADR 0521 の面）。
- `consolidate`・`reflect`・`reextract` の「消した後の参照」（LLM の応答が要る。ADR 0406・0420 などが当てた面）。
- 実 API（LLM・埋め込み）。
- 3者のうち Fake の語彙検索（`FakeLexicalStore`）の語の一致そのもの（ADR 0493 の材料 E14）。
