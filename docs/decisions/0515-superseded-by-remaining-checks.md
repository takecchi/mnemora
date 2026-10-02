# ADR 0515: `supersededById` の残りの断り（`resolveContestedPair` の対の外の `forgotten`、`updateStatus*` の `superseded` 以外への付与）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定（2026-10-02）の線の内側で、担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**前提**: [ADR 0503](./0503-superseded-by-checks-resolve-contested-update-status.md) の「引き受けた負債」の1・2を片付ける。「型の中でも約束を壊す入力を新しく断る直しは、クローンの線の内側」という読みは ADR 0503 と同じで、**ずれていれば「これが覆るとしたら」から戻せる。**
出所の区別: 【現物】は読んだコード、【実測】は手元（PostgreSQL 17）や名指しのテストで走らせた結果、【判断】は担い手の判定、【未確認】は追っていないこと。

- **文脈**: ADR 0503 は、次の2つを「引き受けた負債」として残した。
  1. 2者版の `resolveContestedPair` が、対の外の `forgotten` な記憶を指す `supersededById` を断らない（群版は断る）。
  2. `updateStatus`・`updateStatusWithEvent` が、`superseded` 以外の status に付いた `supersededById` を断らない。

- **先に確かめたこと: 2 の `forbidWhenNotSuperseded: false` は意図か**（依頼の最初の問い）:
  - 【現物】`git log -S` で、`false` は #1621（ADR 0503）の入れた行そのもの（`f3e447945`）。それ以前に「`updateStatus` は `supersededById` を残してよい」と決めた ADR・コミットは見つからなかった。
  - 【現物】ADR 0503「採らなかった案」の `updateStatus(T, "active", { supersededById })` や `archived` への付与も断る、の理由は「依頼の範囲外」と「`active` に戻すとき `superseded_by_id` を `COALESCE` で残す既存の振る舞いに触れる」。**範囲を絞った判断であり、「残す」ことを約束にした記述ではない。** `updateStatus` の TSDoc も「`superseded` 以外の status は、`supersededById` が無くてよい」と書くだけで、あってよいとは書いていない。
  - 【現物】**`COALESCE` は「`supersededById` を省略したときに既存の値を保つ」ためで、`active` へ戻す経路が `supersededById` を渡して残す用途のためではない。** 断る対象は「渡した」ときで、省略は変わらない（`COALESCE` はそのまま）。
  - 【現物】呼び出し元（`runtime.ts` の `updateStatusWithEvent` 4か所）: `supersededById` を渡すのは `superseded` を書く2か所（`reextract`・`consolidate`）だけ。`restoreArchived`（`active`）・`forget`（`forgotten`）は渡さない。`restoreSuperseded` は `restoreSupersededBy`（別の口。`superseded_by_id = NULL` へ戻す）で、`updateStatus*` を通らない。packages・examples のほかの src に呼び出しは無い。
  - 【実測】断る側へ倒して、`updateStatus*`/`resolveContested*` を使う既存の歯（Postgres 32 ファイル・testkit 35 ファイル）を走らせ、赤は出なかった。
  - 【判断】意図の約束ではなく、Runtime の経路も壊れない。**断る。** 約束を変える（Runtime が壊れる）場合は止める条件だったが、当たらなかった。

- **決めたこと**:
  1. **`updateStatus`・`updateStatusWithEvent` は、`status` が `superseded` 以外（`active`・`archived`・`forgotten`。`contested` は ADR 0140 で先に断られる）のとき `opts.supersededById` を渡すと `RangeError`。** message は ADR 0503 の既存の文面（`<口>: opts.supersededById must not be set unless status is "superseded"`）。位置は `contested` の検査のあと、対象の存在確認より前（ADR 0503 の `superseded` の検査と同じ）。実装は、検査関数の `forbidWhenNotSuperseded` を `true` にしただけ（Postgres・testkit の InMemory）。
  2. **`resolveContestedPair` は、`first`/`second` の `supersededById` が対の外の `forgotten` な記憶を指すとき `RangeError`。** message: `resolveContestedPair: <first|second>.supersededById must not be a forgotten memory outside the pair`（群版の `… outside the group` に揃えた）。**対の相手を指すのは、この検査では断らない**（両方 contested と確かめ済み。互いを指す循環は ADR 0503 の循環の検査が断る）。対の外の `archived`・`superseded`・`contested`・`active` は断らない（ADR 0503 決定5と同じ線）。位置は、テナントの照合（ADR 0439）と CAS（両方 contested）のあと、書く前。Postgres はトランザクション内の `SELECT`（`FOR UPDATE` の後）、InMemory は書く前の読み。別テナント・実在しない id は、これまでどおり UPDATE の切り分け（ADR 0439）に任せる。
  3. **新しい例外クラス・公開 API は足していない。** 既存の `RangeError` と message の書き方（値を入れない）に揃えた。
  4. **歯**: ADR 0503 の2つのテスト（`packages/postgres/src/__tests__/store-superseded-by-checks.postgres.test.ts`〔InMemory と Postgres に同じ入力〕、`packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts`〔DB 無し〕）に足した。conformance suite には足していない（ADR 0434 決定5。オーナーの領分）。陽性対照: 対の外の `archived` を指す `superseded` は通る（断りすぎると赤）。
  5. **CHANGELOG の `[1.3.0]` Breaking と migration-v1 の項目61（🔴「v1.2.0 → 次の版」）に書いた。** 番号は他の PR とぶつかっていれば merge のとき振り直す。

- **採らなかった案**:
  - **`updateStatus*` の `false` を意図として残す（2 は直さない）**: 上の確かめで意図の根拠が見つからなかった。残すと、`active`・`archived`・`forgotten` なのに `superseded_by_id` が残る行が、直接呼べば作れる。
  - **`updateStatus*` で `forgotten` な記憶を指す `supersededById`（`superseded` のとき）も断る**: 依頼の範囲外。状態を読む検査を `updateStatus*` に足すことになり、CAS と TOCTOU の整理が要る。負債として残す。
  - **conformance suite に足す**: ADR 0434 決定5。オーナーの領分。

- **引き受けた負債**:
  - **`updateStatus*` は、`superseded` のとき、`forgotten` な記憶を指す `supersededById` を断らない**（`resolveContested*` は断る）。Runtime 経由では起きない。
  - **core の `FakeMemoryStore`（`packages/core/src/__tests__/runtime-fakes.ts`）は揃えていない。** ほかの担当の PR #1643 が触っているので、今回は触らなかった。Fake は、`superseded` 以外への `supersededById` と、対の外の `forgotten` を、まだ断らない。
  - **他の第三者 adapter は、この断りを持たない。** conformance に足していないので、適合テストは検査しない。
  - **対の外の `forgotten` の検査と CAS・書き込みの間は、Postgres では `FOR UPDATE` で対の2行を握っているが、指す先（対の外の記憶）の行は握っていない。** 検査のあとに指す先が `forgotten` になる並行は断れない【未確認】（群版も同じ形）。
  - **例外が `RangeError`（programmer error）で、状態が理由の「対の外の `forgotten`」も同じ型。**（ADR 0503 と同じ。専用の型はオーナーの領分。）

- **これが覆るとしたら**:
  - 「新しく断る直しはクローンの線の内側」が撤回されれば、全体が戻す対象。
  - `updateStatus` で `superseded` 以外の status に `supersededById` を付ける正当な用途（例: `archived` にしても置き換えた側を残す運用）が見つかれば、2 の1項目だけ外す。`COALESCE` が書き込み口を残す設計の根拠になる。
  - `Runtime` が `superseded` 以外で `supersededById` を渡す経路を足す設計変更があれば、その経路は断られて壊れる。

- **測ったこと**（【実測】手元の PostgreSQL 17。UTF8 `C.UTF-8` と SQL_ASCII の2つ。件数は書かない）:
  - **直す前**（src の変更だけを外して歯を残す）: testkit の InMemory（DB 無し）の新しい歯3つが赤。Postgres の歯ファイルでは、InMemory 側・Postgres 側のそれぞれで新しい歯3つ（対の外の `forgotten`・`updateStatus`・`updateStatusWithEvent`）が赤、陽性対照は緑。
  - **直した後**: 上の歯ファイルが緑（UTF8・SQL_ASCII の両方。SQL_ASCII では `memory-store-update-status-with-event-transaction.test.ts` も緑）。testkit の `in-memory-fixtures` 系・tsdoc 系の歯、Postgres の `updateStatus*`・`resolveContested*`・`supersededById`・大文字 uuid・`restoreSuperseded`・`store-boundary-diff`・`conformance.postgres` などの既存の歯（名指しで32ファイル）も緑。全部は走らせていない。
  - **変異（Postgres）**: 対の外の `forgotten` の検査を外す → 「対の外の forgotten」の歯が赤。**やりすぎ**: 対の外の記憶を何でも断る（`status = 'forgotten'` の条件を外す）→ 陽性対照（対の外の `archived`・外の `active`）が赤。`updateStatus*` の `true` を `false` に戻すのは、「直す前」の赤そのもの。InMemory の変異は測っていない（Postgres と同じ入力の歯が直す前に赤だった）。
