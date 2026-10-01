# ADR 0469: core の `FakeMemoryStore` も、別テナントを指す `NewMemoryEvent.memoryId` を断る・大文字の uuid の扱いを3実装で測って揃える

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。直す線はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元（PostgreSQL 17）や名指しのテストで走らせた結果、【判断】は担い手の判定。

- **文脈**: [ADR 0466](./0466-inmemory-event-target-belongs-to-ctx-tenant.md) の「残ったこと」2点——(1) core の `FakeMemoryStore`（`packages/core/src/__tests__/runtime-fakes.ts`。テスト専用で公開されていない）が、別テナントを指す `NewMemoryEvent.memoryId` を断るか、(2) uuid の大文字小文字の扱いが3実装（`@mnemora/postgres`・testkit の `InMemoryMemoryStore`・Fake）で揃っているか——を測り、揃える。

- **実測**（口 × 指し先 × 3実装。`.mgr-notes/r40-matrix.out`。InMemory は #1574 の枝の fixture を一時的に当てて測った。コミットしていない）:

  指し先: 別テナントの記憶（foreign）・uuid でない／実在しない id（malformed）・今更新した行（own）・同じテナントの別の記憶・`null`・own の大文字（ownUpper）・同じテナントの別の記憶の大文字（otherUpper）。

  | 指し先 | `@mnemora/postgres` | `InMemoryMemoryStore`（#1574） | `FakeMemoryStore`（直す前） |
  |---|---|---|---|
  | foreign | 断る | 断る | **通す（別テナントの記憶にイベントが積まれた）** |
  | malformed | 断る | 断る | **通す** |
  | own・同じテナントの別の記憶・`null` | 通す | 通す | 通す |
  | **ownUpper・otherUpper**（大文字） | **通す** | **断る** | 通す（検査が無い） |

  - 8口（`updateStatusWithEvent`・`supersedeWithNewMemories`（`supersede[i].event`）・`purgeMemory`・`markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested`・`markContestedGroup`・`resolveContestedGroup`）で上の表のとおり。
  - **Fake は `createMemoriesWithOutboxAndEvents?` と、`supersedeWithNewMemories` の `opts.buildCreatedEvent` を実装していない**【現物】（任意のメソッド・任意の欄。`createdEventsWritten` も返さないので、core が `created` を別に `EventStore.append` で積む）。そのため ADR 0456 の「9口」のうち、`created` を積む2つの経路は Fake には無く、検査の対象外。
  - **大文字**: `@mnemora/postgres` は `checkedRef`（`normalizeUuidCase` の系統）で小文字にそろえて比べるので、大文字の uuid は自テナントの記憶として通り、別テナントなら断る。fixture の id は不透明な文字列（`mem-N`）で、`InMemoryMemoryStore`（#1574）は完全一致で引くので、大文字にした自テナントの id を断る。つまり **postgres と InMemory で割れている**。Fake は検査自体が無かった。

- **決めたこと**:

  1. **Fake の8口で、書く前に `event.memoryId` が `ctx` のテナントの記憶かを確かめ、違えば断る。**判定・文言・「今更新・作成した行は問い合わせない」「`null`・`undefined` は検査しない」「CAS に弾かれる `supersede` の対象と、状態が変わらない群のメンバー（イベントを積まない）は検査しない」「断ったら何も書かない」は、ADR 0456（postgres）・ADR 0466（InMemory）と同じ。例外は素の `Error`（`kind`・`code` 無し）、message は `FakeMemoryStore: memory not found for tenant: <id>`（接頭辞だけが違う）。
     - Fake の `supersedeWithNewMemories` は CAS を通る対象を、news を作る前の事前検証で予測する（InMemory の 1d と同じ作り）。
     - **空文字は参照として扱い断る**（Postgres の uuid でない id と同じ）。Fake の既存の `assertOwnMemoryRef`（ADR 0439）は空文字を「参照しない」として通すが、イベントの指し先では通さない（今回の検査は `assertEventTargetOwn` で別に持つ）。
  2. **大文字小文字は区別しない側に揃える（落ちる入力が減る側）**【判断】。Fake は、`event.memoryId` を小文字にして記憶を引き、積むイベントの `memoryId` も小文字にそろえる（Postgres は uuid 列の正規形＝小文字で読み戻る）。Fake の id は小文字の `mem-N` だけなので、大文字を小文字にそろえても別の id と混ざらない。
     - **落ちる入力は増えない／減る**: 以前の Fake は検査が無かったので、大文字は通っていた。検査を足したあとも通る。
     - **InMemory（testkit の公開の fixture）の同じ直し**——`assertEventTargetOwn` で小文字にそろえて引き、積むイベントの `memoryId` を小文字にそろえる——は、**#1574 がマージされてから**同じ PR に足す（この ADR の時点で #1574 は未マージ）。落ちる入力が減る変更なので、入れる場合は CHANGELOG の `[1.2.0]` に1行と migration-v1 の 🟡 に載せる（落ちる入力が増える変更ではない）。
  3. **ADR 0438・0446 との整合**: ADR 0438 は `purgeMemory` 以外の `isUuidLike` だけの入口に `normalizeUuidCase` を足さなかった（uuid 型の列との比較だけで、大文字でも結果が変わらない）。ADR 0446 は `correctedId` の大文字を「store に従って」扱い、大文字小文字を区別する store は今どおり `not_a_candidate` のままとした。この ADR が変えるのは **`event.memoryId`（イベントの指し先）の検査だけ**で、操作の対象の id（`updateStatusWithEvent(ctx, id, …)` の `id` など）の大文字小文字は変えていない（fixture は完全一致のまま。ADR 0446 の「store に従う」を覆さない）。これは Postgres が大文字の `id` を受けて fixture が受けない、という既存の違いを残す（下の「残ったこと」）。
  4. **歯は新しいファイルに置き、conformance suite には足さない**（ADR 0434 決定5）。
     - `packages/core/src/__tests__/fake-event-target-belongs-to-ctx-tenant.test.ts`（10本。口ごとの断る／通す、空文字、大文字小文字、CAS に弾かれる対象、状態が変わらない群のメンバー）。
     - `packages/postgres/src/__tests__/event-target-belongs-to-ctx-tenant.postgres.test.ts` に1本足した: 大文字の uuid は自テナントの記憶なら通り（小文字で読み戻る）、別テナントなら断る（postgres 側を基準として縛る）。

- **変異試験**【実測。`.mgr-notes/mutations-0469-fake.txt`・`red-before-0469-fake.txt`】:

  - **直す前で赤**: Fake の歯は 10 本中 8 本が赤（残り2本は「断らない」ことを見る対照）。
  - **やりすぎで赤**: `null` まで断る(2)・今更新した行以外は同じテナントの記憶でも断る(2)・今更新した行まで断る(8)・CAS に弾かれる対象まで検査する(1)・状態が変わらない群のメンバーまで検査する(1)。
  - **足りなくて赤**: 大文字小文字を区別する(1)・積むイベントの `memoryId` を小文字にそろえない(1)・空文字を「参照しない」として通す(1)。

- **走らせたテスト**（名指し）: 新しい `fake-event-target-belongs-to-ctx-tenant.test.ts`。core の回帰として、`fake-referential-integrity`・`fake-event-write-atomicity`・`fake-memory-store-supersede-with-new-memories`・`mark-contested`・`resolve-contested`・`mark-contested-group`・`resolve-contested-group`・`resolve-orphaned-contested`・`purge`・`apply-correction`・`consolidate`・`reflect`・`runtime-branch-teeth` の13本（253 本が緑）。postgres の `event-target-belongs-to-ctx-tenant.postgres.test.ts`（8 本が緑）。

- **検討した代替案**:

  1. **Fake・InMemory を大文字小文字を区別するままにして、postgres の大文字を断る側に揃える。** 採らなかった。落ちる入力が増える（postgres は今、大文字の uuid を受ける。公開の adapter の振る舞いを狭める）。
  2. **操作の対象の `id` の大文字小文字も fixture で正規化する。** 採らなかった。ADR 0446 が store ごとの違いとして残した範囲に踏み込む。
  3. **Fake に `createMemoriesWithOutboxAndEvents?`・`buildCreatedEvent` を実装する。** 採らなかった。任意のメソッド・欄で、core は未実装の経路を別に扱う。この ADR の範囲外。

- **引き受けた負債**:

  - InMemory の大文字の扱いは、#1574 のマージ後に足す（上の決定2）。それまで postgres と InMemory は大文字で割れたまま。
  - 操作の対象の `id`（`updateStatusWithEvent(ctx, id, …)` の `id` など）の大文字小文字は、Postgres が受け、fixture（InMemory・Fake）は受けない（ADR 0446 の既存の違い）。
  - Fake が積む `memoryId` の小文字化は、`FakeEventStore.append` を含む全経路（`buildStoredEvent`）に効く。`append` で別の大文字の id を使う既存のテストは見当たらなかったが、網羅の証明ではない。

- **これが覆るとしたら**: オーナーが、fixture は大文字の uuid を断ってよい（postgres とは違ってよい）と決めたとき。その場合は Fake の小文字化と歯を外す。

- **測っていないこと**: 大文字の `id` で操作の対象を指したときの3実装の差（範囲外）。実 API。
