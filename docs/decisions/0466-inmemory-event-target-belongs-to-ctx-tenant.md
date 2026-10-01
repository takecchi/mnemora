# ADR 0466: `InMemoryMemoryStore` も、`NewMemoryEvent.memoryId` が `ctx` のテナントの記憶でなければ書かずに断る（ADR 0456 の H4 の InMemory 版）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。直す線はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元（PostgreSQL 17）や名指しのテストで走らせた結果、【判断】は担い手の判定。

- **文脈**: [ADR 0456](./0456-llm-returned-values-malformed-read-filter-nul-named.md) の H4 は、`@mnemora/postgres` の `MemoryStore` の書き込み口が、呼び出し側の渡した `NewMemoryEvent.memoryId` を確かめずに `memory_events` へ書いていた穴を塞いだ。同じ ADR の M7 は「`@mnemora/testkit` のインメモリ実装が同じ入力を断るかは確かめていない」と残した。
  [ADR 0463](./0463-migration-v1-red-items-checked-against-code.md) が実測した: `InMemoryMemoryStore.updateStatusWithEvent(A, a.id, "archived", {}, event)` に、B の記憶を指す `event.memoryId` を渡すと、受け入れられた【実測】。`@mnemora/postgres` は断るので、2実装の振る舞いが割れていた（[ADR 0434](./0434-testkit-fixtures-align-nul-int4-invalid-date-purged-at.md)・[ADR 0436](./0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md) と同じ種類の穴。`InMemoryEventStore.append` は ADR 0436 で既に断る）。

- **決めたこと**:

  1. **`InMemoryMemoryStore` の、`NewMemoryEvent` を受け取る書き込み口の全部で、書く前に `event.memoryId` が `ctx` のテナントの記憶かを確かめ、違えば断る。**口の一覧は `packages/postgres/src/memory-store.ts` の `assertEventTargetInTenant` の呼び出し（223・1239・1460・3117・3349・3694・3779 行目）と `insertMemoryEventsBatch`（464 行目〜）を読んで作った【現物】:

     | 口 | 検査するイベント | 「今作った・更新した行」として問い合わせない id | Postgres の呼び出し |
     |---|---|---|---|
     | `updateStatusWithEvent` | `event` | `id` | 1239 |
     | `supersedeWithNewMemories?` | CAS を通る対象の `supersede[i].event` | その対象の `id` | 1460（CAS に弾かれる対象は `continue` の前なので検査しない） |
     | 同上 | `buildCreatedEvent` が返す `created`（`created: true` のもの） | 作った記憶の id | 223（`insertCreatedEventRow`） |
     | `createMemoriesWithOutboxAndEvents?` | `buildCreatedEvent` が返す `created`（`created: true` のもの） | 作った記憶の id | 223 |
     | `purgeMemory?` | `event` | `id` | 3117 |
     | `markContestedPair?` | 2つのイベント | `first.id`・`second.id` | 3349 |
     | `resolveContestedPair?` | 2つのイベント | `first.id`・`second.id` | 3694 |
     | `resolveOrphanedContested?` | `survivor.event` | `survivor.id` | 3779 |
     | `markContestedGroup?` | **イベントを積むメンバーだけ**（既に contested で相手なしのメンバーは積まない） | 全メンバーの id | 3926（`insertMemoryEventsBatch`） |
     | `resolveContestedGroup?` | 全メンバーのイベント | 全メンバーの id | 4101（同上） |

     `null`・`undefined`（記憶を指さないイベント。`events_purged` など）は検査しない。
  2. **例外の型と文言は Postgres に揃えた。**素の `Error`（`kind`・`code` は無い）、message は `<クラス名>: memory not found for tenant: <id>`——実在しない id と別テナントは区別しない。`InMemoryMemoryStore` の既存の `assertOwnMemoryRef`（ADR 0439）をそのまま使うので、ADR 0439 の参照の検査と同じ文面になる。2実装で違うのは**クラス名の接頭辞だけ**（`PostgresMemoryStore:`／`InMemoryMemoryStore:`）。これは ADR 0398・0436・0439 の前例と同じ（項目34・49・51 の「メッセージの接頭辞」）で、揃えられない理由は無い（接頭辞は実装の名前を名乗るもの）。
  3. **揃えられない点（残る違い）**:
     - **uuid の大文字小文字・形式**: `@mnemora/postgres` は id を uuid の形で検査して小文字にそろえる（大文字の uuid は自テナントの同じ記憶として通る。形が uuid でない id は DB に触れず同じ message で断る）。`InMemoryMemoryStore` の id は不透明な文字列（`mem-3` の形）で、完全一致で引く。大文字小文字だけ違う id は別の id として断られる。形式のおかしい id（`not-a-uuid`・空文字）は、どちらも同じ message で断る（歯で確かめた）。
     - **検査の位置**: Postgres は status の更新などのあと、イベントを書く直前に確かめ、投げればトランザクションごと戻る。InMemory にトランザクションは無いので、**書き換える前**に確かめる（「まだ何も書いていないうちに投げる」というこのクラスの作法。クラス冒頭の doc）。観測できる結果（断られる・何も残らない）は同じ。複数のエラーが重なるときの優先順（例: CAS の失敗とイベントの指し先）は、InMemory も CAS の失敗の後に確かめる位置に置いたので、Postgres と同じ順になる。
  4. **歯は testkit 側に置き、conformance suite（`*-conformance.ts`）には足さない**（ADR 0434 決定5。約束を足すのはオーナーの判断）。足した歯:
     - `packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts`（10本。InMemory だけ。DB 不要）。
     - `packages/postgres/src/__tests__/event-target-parity.postgres.test.ts`（10本）: **同じ入力を2実装に流し、結果・呼び出し後の status・別テナントの記憶に積まれたイベントの数が一致する**ことを縛る。口 10（`supersedeWithNewMemories` は supersede の event と `buildCreatedEvent` の2つ）× 指し先 5（別テナントの記憶・uuid でない id・今更新した行・同じテナントの別の記憶・`null`）。

- **suite に足す材料**（足すかは**オーナーの判断**。足していない）:

  - 足すとしたら `describeMemoryStoreConformance` に、上の10口それぞれ「別テナントの記憶を指す `event.memoryId` を断り、何も書かない（status・news・先のイベントが残らない）。自テナントの記憶・`null`・今更新した行を指すイベントは通る」の `it` を、`prepareMemoryId` に当たるフック（`createStore()` の store から見える、渡した `ctx` のテナントの記憶を返す。`EventStoreConformanceOptions.prepareMemoryId` の `MemoryStore` 版）の下に置く形になる。口ごとに任意メソッドなので、既存の `supportsXxx` のフラグの下に置く（項目51 の `it` 9本と同じ形）。
  - **足すと破壊的に数える**（自前の `MemoryStore` を suite に当てている利用者の新しい `it` が落ちうる。`docs/migration-v1.md` の項目36〜51 と同じ扱い）。ADR 0456 は testkit に1行も触れていない（H4 は suite に足していない）ので、足すなら Postgres 側の歯（`event-target-belongs-to-ctx-tenant.postgres.test.ts`）を suite に移す作業になる。
  - 上の `event-target-parity.postgres.test.ts` は、suite に足さない間の穴埋めである（2実装の一致を、このリポジトリの中だけで縛る）。

- **変異試験**【実測。`.mgr-notes/mutations-0466.txt`・`red-before-0466-*.txt`】:

  - **直す前（`origin/main` の fixture）で赤**: testkit の歯は10本中8本が赤（残り2本は「断らない」ことを見る対照で、直す前も緑）。出力は `red-before-0466-inmemory.txt`。2実装の一致の歯は10本とも赤（`updateStatusWithEvent / foreign: expected { outcome: 'ok', … } to deeply equal { … }` など）。出力は `red-before-0466-parity.txt`。
  - **やりすぎで赤**（変異。fixture の検査を次のように歪める）:
    - `null` まで断る → 2本赤（`updateStatusWithEvent`・`markContestedPair`/`resolveContestedPair`）。
    - 今更新した行以外は、同じテナントの記憶でも断る → 1本赤（同じテナントの別の記憶）。
    - 今更新した行・今作った行を指すイベントまで断る → 8本赤。
    - CAS に弾かれる `supersede` の対象のイベントまで検査する → 1本赤。
    - `markContestedGroup` の状態が変わらないメンバーのイベントまで検査する → 1本赤。
  - **足りなくて赤**: 検査を status の書き換えの後に回す → 2本赤（何も書かないことを縛る）。
  - 最初の「`null` まで断る」変異（`assertEventTargetOwn` の早期 return の削除）は、`assertOwnMemoryRef` 側が `null` を素通りするので結果が変わらず、無効だった。`null` を明示的に断る変異に取り直して赤を確かめた。

- **確かめたこと**【実測】:

  - testkit の `in-memory-fixtures.conformance.test.ts` ほか、InMemory を使う既存の9ファイル（734 本）が緑。`@mnemora/testkit` の `InMemoryMemoryStore` を import する `packages/postgres` のテスト 73 ファイル（1139 本）が緑。`examples/chat` の `provenance-trace.test.ts` が緑。
  - 公開 API の snapshot（`scripts/__snapshots__/public-api/testkit.d.ts`）は、private メソッド `assertEventTargetOwn` が1行増えるだけ。

- **検討した代替案**:

  1. **`InMemoryEventStore.append` と同じく、検査を共通の関数に切り出す。** 採らなかった。`append` は `memories` Map を引く1箇所、こちらは10口で「今更新した行は問い合わせない」の引数が口ごとに違う。`assertOwnMemoryRef`（ADR 0439）に1行足すだけの private メソッドが最小。
  2. **uuid の大文字小文字を InMemory でも正規化する。** 採らなかった。InMemory の id は不透明で、正規化する対象の形（uuid）を持たない。違いは上の「揃えられない点」に書いた。
  3. **conformance suite に足す。** 採らなかった（ADR 0434 決定5）。材料は上に書いた。

- **引き受けた負債**:

  - core の `FakeMemoryStore`（`packages/core/src/__tests__/runtime-fakes.ts` の系統。ADR 0439 が `InMemoryMemoryStore`・`PostgresMemoryStore` と並べて名指しした実装）が、同じ入力を断るかは確かめていない（この ADR の範囲は testkit の `InMemoryMemoryStore`）。
  - uuid の大文字小文字の違い（上の3）。
  - 自前の `MemoryStore` 実装には何も課していない（suite に足していない）。

- **これが覆るとしたら**:

  - オーナーが、fixture の `InMemoryMemoryStore` は Postgres より緩くてよい（別テナントを指すイベントも受け入れてよい）と決めたとき。その場合は fixture の検査と歯を外し、ADR 0463 の「InMemory は断らない」を正とする。
  - suite に約束を足すと決めたとき。上の「suite に足す材料」の形にし、`event-target-parity.postgres.test.ts` の役目は suite に移る。

- **測っていないこと**: core の `FakeMemoryStore`。大文字の uuid を InMemory に渡したときの Postgres との差（理屈では上のとおりだが、歯は無い）。実 API。
