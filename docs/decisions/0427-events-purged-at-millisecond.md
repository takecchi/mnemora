# ADR 0427: `events_purged` の `at` を SQL の `now()` から JS 側の時刻（`toPgTimestamp`）へ替える

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。直し方（下の決めたこと1）はクローンが選んだ。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  `PostgresMemoryStore.purgeExpiredEvents`（`purgeExpiredEventsByRetention` も同じ本体を通る）は、`events_purged` の行の `at` を SQL の `now()` で積んでいた。
  `now()` はマイクロ秒の精度を持つ。一方、読み戻すときの `parsePgTimestamp`（`packages/postgres/src/mapping.ts`）は小数秒を3桁で切り捨てる。
  `EventStore.list` の `since`/`until` は両端を含む（`packages/core/src/interfaces/event-store.ts`）。しかし、読み戻した `at` をそのまま `until` に渡すと、比較 `at <= until` にその行自身が当たらず、返る件数は0件だった。
  testkit のインメモリ実装はミリ秒しか持たないので1件返り、2つの実装が食い違っていた（穴探し7巡目の W-1。使い捨てのテストを Postgres 17 に対して走らせて確かめた）。

  同じファイルの他の書き込みの口（`append` の `at`、outbox、recalls、`recorded_at`、`valid_*` など）は、JS の `Date` を `toPgTimestamp` で渡しており、列にはミリ秒の値が入る。

- **決めたこと**:

  1. **`events_purged` の `at` は、store の中で読んだ JS の壁時計（`new Date()`）を `toPgTimestamp` で渡す。**他の書き込みの口と作法が揃い、精度の切り捨てが JS の `Date` の1か所に集まる。
     時計は `Runtime` の `clock` ではない。`purgeExpiredEvents` の口は時刻を受け取らず、testkit のインメモリ実装も `buildStoredMemoryEvent` が `new Date()` で埋める。どちらも store の中の壁時計で揃う。
  2. **歯**:
     - `packages/postgres/src/__tests__/events-purged-at-millisecond.postgres.test.ts`: 読み戻した `at` を `until`・`since` に渡すと行自身が返ること、列の値がミリ秒で揃っていること。
     - `packages/testkit/src/__tests__/in-memory-events-purged-at-until-boundary.test.ts`: インメモリ実装でも同じ端で1件返ること。
     - `*-conformance.ts` には要件を足していない。
  3. **`packages/core/src/interfaces/clock.ts` の TSDoc**（「Postgres では SQL の `now()` のまま」）を、この変更に合わせて直した。

- **検討した代替案**:

  1. **`date_trunc('milliseconds', now())` にする。**採らなかった。DB の時計を使う点が他の書き込みの口と違ったままになり、ミリ秒への切り捨てが SQL と JS の2か所に分かれる。
  2. **`parsePgTimestamp` の側で、比較に使う値を切り上げる／`EventStore.list` の比較を幅で取る。**採らなかった。他の列の比較の意味まで変わり、問題の元（列の値の精度）は残る。
  3. **`purgeExpiredEvents` に `now` を渡せるようにし、`Runtime` の `clock` を届かせる。**採らなかった。公開の口が増え、今回の穴（精度）とは別の論点である（[ADR 0355](./0355-inject-clock-into-store-writes.md) の範囲外に残したもの）。

- **引き受けた負債**:

  - `at` は DB サーバの時計ではなく、adapter を動かすプロセスの時計になった。複数のプロセスで時計がずれていると、`events_purged` の `at` の並びは DB の時計の並びと一致しないことがある（他の書き込みの口と同じ性質）。
  - [docs/memory-model.md](../memory-model.md) の 2026-09-30 追記（[PR #1524](https://github.com/takecchi/mnemora/pull/1524)）は、`@mnemora/postgres` について「SQL の `now()`（DB の時計）」と書いている。この変更でその記述は事実と合わなくなったが、この PR では直していない。ADR 0355 の本文（「Postgres では SQL の `now()` のままである」）も採用済みの ADR なので書き換えていない。

- **これが覆るとしたら**:

  `events_purged` の `at` にも `Runtime` の `clock` を届かせる（代替案3）と決めたら、この壁時計は `clock` の時刻に置き換わる。ミリ秒で揃える `toPgTimestamp` の経路はそのまま使える。

- **測ったこと**:

  - Postgres 17（手元、`--encoding=UTF8 --locale=C.UTF-8`）で、直す前の実装に postgres のテストを当てると赤になった（`until: marker.at` で0件）。直した後は緑。
  - 直した後、関連する7ファイル（上のテスト、`purge-expired-events-count-and-range`・`purge-expired-events-by-retention-concurrency`・`event-retention-change-during-purge`・`observe-created-event-after-purge`・`injected-clock-reach`・`conformance` の各 `.postgres.test.ts`）の587本が緑。
  - testkit のテストは、直す前から緑（インメモリ実装はもともとミリ秒で持つ）。インメモリ側の振る舞いは変えていない。
