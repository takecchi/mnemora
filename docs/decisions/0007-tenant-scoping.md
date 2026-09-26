# ADR 0007: Tenant scoping

- **状態**: 採用 (2026-09)

- **文脈**:
  mnemora は multi-tenant を Phase 1 から前提にする。テナントを跨いだ記憶の漏洩は「整理の失敗」ではなく
  「事故」であり、後から足せる保証ではない。分離をどこで・どうやって強制するかを最初に決める必要がある。

- **決定**:
  - **`tenant_id` は全テーブルで NOT NULL とし、すべての一意制約・索引の先頭列に置く。**
  - **core の全 interface のすべてのメソッドは第一引数に `ctx: { tenantId, subjectId? }` を取る。**
    暗黙の・グローバルなテナント状態を runtime もモジュールスコープも持たない。
  - **mnemora はテナントの台帳（テナントの一覧・認証情報）を持たない。**`tenantId` は呼び出し側が
    渡す不透明な文字列として扱う。誰が誰であるかを検証する仕事（認証・アカウント管理）は
    mnemora の責務外である。
  - Postgres の RLS(Row Level Security) は**一次防御にしない。追加防御として adapter 側のオプション**
    に位置づける。
  - **`packages/testkit` の store 適合テストは、必ず2テナント分のデータを入れて走らせる**ことを
    契約にする。

- **検討した選択肢**:
  - **RLS を一次防御にする**: Postgres の RLS を設定すれば、アプリケーション層のバグがあっても
    DB レベルでテナント分離が守られる、という魅力がある。しかし **RLS の無い Store 実装（将来
    別の DB エンジンで書かれる adapter や、テスト用の in-memory 実装）では保証がまるごと消える。**
    interface の契約として「RLS を前提にする」と書いてしまうと、RLS を持たない adapter は
    interface の契約を満たせないことになり、adapter の多様性を阻害する。却下（一次防御としては）。
    ただし `packages/postgres` が追加のオプションとして RLS を設定できるようにすること自体は妨げない。
  - **暗黙のグローバルテナント（デフォルトテナント）を持つ**: シングルテナント運用や開発時の
    利便性のために「テナント指定を省略したら既定のテナントを使う」という設計。**「後付けにしない」**
    という方針（multi-tenant を最初から前提にする）に反するため却下。省略を許すと、いずれ
    「省略したときの既定テナント」に依存するコードが紛れ込み、multi-tenant 化しようとしたときに
    暗黙の結合を洗い出す作業が必要になる。
  - **ctx の引き回し + 索引先頭列を一次防御にする**: 採用（下記）。

- **理由**:
  1. RLS はデータベースエンジン・adapter の実装に依存する保護であり、interface の契約（型で
     保証されるもの）にはなり得ない。一次的な保証は、型で強制できる場所——`ctx` を全メソッドの
     第一引数に強制することと、全ての一意制約・索引の先頭列に `tenant_id` を置くこと——に置く。
  2. `testkit` が2テナント分のデータを入れて適合テストを走らせることで、「ctx を引き回す」という
     規約が実際に守られているかを実行可能な形で検査できる。RLS のような DB 側の機構は、
     adapter ごとに設定漏れのリスクが残るため、テストで検査する対象としては ctx の方が確実である。
  3. mnemora がテナント台帳・認証を持たないことで、責務の境界が明確になる。`tenantId` の正当性の
     検証（本当にこのリクエストがこのテナントのものか）は、mnemora より上位のアプリケーション層の
     責務であり、mnemora が持つと責任の境界が曖昧になる。

- **Tenant（隔離境界）と Subject（テナント内の分割）を分ける理由**:
  Tenant は隔離境界であり、安全性の単位である。跨いだら事故になる。Subject はテナント内の分割で
  あり、整理の単位である。跨いでも事故ではない。例えば Discord Bot なら「Bot の導入先ギルド」が
  Tenant、「各ユーザー」が Subject になる。この二つを混同すると何が起きるか:
  - Subject を Tenant のように扱う（分離を過剰に強くする）と、同じテナント内で本来共有してよい
    情報まで分断され、機能が使いにくくなる。
  - Tenant を Subject のように扱う（分離を弱くする）と、あるギルドの記憶が別のギルドに漏れる、
    という設計上あってはならない事故につながる。
  この非対称性——Tenant を跨ぐことは事故だが、Subject を跨ぐことは事故ではない——を、
  スキーマ上も interface 上も曖昧にしない。`ctx.tenantId` は必須、`ctx.subjectId` は任意である
  という型の非対称性がこれを表している。

- **結果（この決定が招くもの）**:
  良い面: adapter の実装エンジンに依存しない、型で検査可能な分離保証を持てる。testkit による
  機械的な検査が、2つ目以降の adapter が書かれた瞬間の分離漏れを防ぐ。RLS を追加防御として
  併用したい adapter（例えば Postgres）は、それを妨げられずにオプションとして持てる。

  引き受ける負債: 「一次防御は ctx の引き回しである」という規約は、開発者が `ctx` を渡し忘れる
  というヒューマンエラーそのものは防げない（型で強制はできるが、`ctx.tenantId` に誤ったテナント ID
  を渡すこと自体は型では検出できない）。この種の誤りは testkit のテストケースの充実度に依存する。
  また RLS を「追加防御」に留めたことで、Postgres 実装が RLS を設定していない状態でも interface の
  契約上は「適合」と判定されてしまう——RLS の有無を適合の必須条件にしていない点は意図的な選択だが、
  Postgres 運用者が RLS を追加防御として実際に設定するかどうかは運用判断に委ねられる。

- **これが覆るとしたら**:
  - `packages/testkit` の適合テストだけではテナント分離の漏れを実運用の頻度で検出しきれないと
    分かったら（実際に事故が起きた、あるいはテストのカバレッジが不十分だと判明したら）、
    Postgres 実装において RLS を必須要件に格上げすることを再検討する。
  - mnemora がテナント台帳を持たないという判断は、将来 mnemora 自身が SaaS として認証を提供する
    プロダクト形態に転じた場合には見直しの対象になる。現時点ではその予定は無い。

- **確かめていないこと**:
  - **alteroid (github.com/takecchi/alteroid) は single-tenant を明示的な非ゴールとして持つ**
    （持ち主は高々1人であることを DB 制約で強制している）。**この設計から multi-tenant について
    得られる教訓は無い。**alteroid のコードや運用実績を multi-tenant 設計の参考にすることはできない、
    という点を正直に記録しておく（[docs/alteroid-findings.md](../alteroid-findings.md) 補足の表を参照）。
  - testkit の2テナント適合テストが実際にどこまでの分離漏れパターン（誤った ctx の伝播、
    JOIN 時の tenant_id 条件漏れ等）を検出できるかは、testkit 自体の実装（Phase 1 着手時）を
    待たないと分からない。

## 追記（2026-09-27、[Issue #1050](https://github.com/takecchi/mnemora/issues/1050)）: **`search` の3口は `filter.tenantId` だけで絞っていた。`ctx.tenantId` との AND に揃えた**

⚠ **本文（上）は当時の記録なので書き換えていない。**この追記は、上の「確かめていないこと」の2つ目
（2テナントの適合テストがどこまでの漏れを検出できるか）への実測の1件である。

- **何が起きていたか**: `VectorStore.search`/`searchMany` と `LexicalStore.search` は、`ctx` とは別に
  `opts.filter.tenantId` を受け取る。`@mnemora/postgres` の3実装（vector・語彙・trigram）と
  `@mnemora/testkit` の `InMemoryVectorStore`/`InMemoryLexicalStore` は、`filter.tenantId` だけで絞り、
  **`ctx.tenantId` を見ていなかった。**`ctx` と `filter.tenantId` に違うテナントを渡すと、`filter` 側の
  テナントの memoryId とスコアが返った（本文は返らない。runtime は常に同じ値を渡すので、runtime 経由では
  起きない）。core の `FakeVectorStore`/`FakeLexicalStore` だけが両方の一致を求めていた。
- **なぜ適合テストが捕まえなかったか**: 適合テストの2テナントの歯は、`ctx` と `filter.tenantId` に
  **同じ**テナントを渡していた。上の決定の「引き受ける負債」が言う「誤ったテナント ID を渡すこと自体は
  型では検出できない」の、口の内側での形にあたる。
- **決めたこと**（クローン miku の判断。オーナーの判断ではない）: 隔離の境界は、上の決定どおり
  `ctx.tenantId` である。`filter.tenantId` は残し、`ctx.tenantId` との **AND** で絞る。食い違えば0件を
  返し、例外は投げない（入力を狭めない）。`VectorFilter.tenantId`/`LexicalFilter.tenantId` の doc に書いた。
- **採らなかった案**: 食い違ったら例外にする（入力を狭める変更になる）。`filter.tenantId` を正とすると
  明記する（`ctx` が境界だという上の決定と食い違う）。
- **歯**: `packages/postgres/src/__tests__/search-ctx-tenant-boundary.postgres.test.ts` と
  `packages/testkit/src/__tests__/in-memory-search-ctx-tenant-boundary.test.ts`。
  **`*-conformance.ts` には足していない**（[Issue #809](https://github.com/takecchi/mnemora/issues/809)）
  ——第三者の adapter にこの要件は、まだ課していない。
- **同じ調査で、決めずに残したもの**: 書き込みの口が他テナントの id を参照として受け付ける件は
  [Issue #1051](https://github.com/takecchi/mnemora/issues/1051) に置いた（拒むのは入力を狭める新しい方針になる）。
