# ADR 0012: 取り込みパイプライン（`observe()` / `runtime.tick()`）の実装方針

- **状態**: 採用 (2026-09)

- **文脈**:
  roadmap.md 段階3は `observe()` の実装・基本の Memory Extraction・冪等性・
  `packages/openai` を範囲とする。設計 doc（architecture.md §3.2〜§3.4、memory-model.md
  §4・§6・§11）は「何が起きるべきか」を規定しているが、それを実装する具体的な interface
  （型シグネチャ）までは踏み込んでいない。本 ADR は、実装段階で必要になった具体的な
  interface 設計・安全弁の閾値・null 変換規約など、複数の小さな決定をまとめて記録する。

## D-ingest-1: transactional outbox を `MemoryStore` の拡張メソッドとして実装する

- **決定**: `MemoryStore` に `createObservationWithOutbox` / `createMemoryWithOutbox` を
  追加した。それぞれ Observation/Memory の作成と、outbox へのジョブ書き込みを**同一
  トランザクションで**行い、`{ <entity>, created: boolean, jobs: OutboxJobRecord[] }` を返す。
  `created: false`（冪等な衝突）のときは `jobs: []` を返し、ジョブを重複させない。

- **検討した代替案**:
  - **`Ctx` に加えて明示的な「トランザクションハンドル」を core の型として持ち、
    `MemoryStore`/新設 `OutboxStore` の両方にそのハンドルを渡す**: interface としては
    最も「正しい」設計だが、トランザクションハンドルの型は adapter（Postgres の
    `pg.PoolClient`、将来の別 DB の別の型）ごとに異なり、core に置くと結局
    adapter 固有の型が core に漏れる。あるいは `unknown` 型のハンドルにすると
    型安全性が失われる。Phase 1 の必要（outbox への書き込みが2種類しかない: 抽出ジョブ・
    埋め込みジョブ）に対して過剰な抽象化と判断し却下。
  - **`observe()` が `MemoryStore.createObservation` と `OutboxStore.enqueue` を
    별々に呼ぶ（トランザクションなし）**: ADR 0005・architecture.md §3.4 が明示的に
    禁じている（コミットとエンキューが分離し at-least-once が壊れる）。却下。
  - **採用: 「同一トランザクションで行う必要がある2つの書き込み」を、その組み合わせに
    特化したメソッドとして `MemoryStore` に持たせる。** ADR 0003 が
    「`packages/postgres` は複数の interface を同一 DB・同一トランザクションで実装する
    リファレンス実装である」とすでに定めており、この決定はその延長線上にある。

- **結果**: `packages/postgres` の実装は `db.transaction()`（drizzle-orm の
  BEGIN/COMMIT）でこの2つの INSERT を包む。in-memory 実装（testkit）は元々
  トランザクションを模していないため、単に「サイズが変わったら created」で判定する
  （本物の同時実行安全性は検査できない——これは in-memory 実装の一般的な限界であり、
  既存の `createMemory`/`createObservation` も同じ限界を持つ）。

  引き受ける負債: `MemoryStore` の責務が「Memory の永続化」から「Memory の永続化 +
  outbox への書き込み」に広がった。ジョブの中身（`payload`）は
  `{ observationId }` / `{ memoryId }` に固定されており、それ以外のペイロード形を
  持つジョブ（将来の `consolidate`/`reflect`）は、このメソッドの外——つまり別の
  transactional な書き込み経路——を必要とする。Phase 1 は `extract`/`embed` の2種類
  しか要らないため、これは Phase 1 の範囲では問題にならない。

## D-ingest-2: `OutboxStore` を新設し、claim は `FOR UPDATE SKIP LOCKED` で行う

- **決定**: `claimBatch(ctx, { kinds?, limit, now, claimedBy })` /
  `complete(ctx, jobId)` / `fail(ctx, jobId, error)` の3メソッドを持つ `OutboxStore`
  interface を core に追加した。Postgres 実装は `claimBatch` を
  `WITH claimable AS (... FOR UPDATE SKIP LOCKED) UPDATE ... RETURNING *` という
  単一クエリで実装し、複数ワーカーの同時 `tick()` 呼び出しが同じ行を二重に claim
  しないことを保証する。

- **Phase 1 は失敗したジョブを自動リトライしない**（`fail` は終端状態）。理由:
  自動リトライのポリシー（バックオフ・最大試行回数）は製品の性格に関わる判断であり、
  今回の roadmap.md 段階3の完了条件（「pending → ready | failed に正しく遷移する」）は
  リトライを要求していない。`attempts` 列は書き込む（claim のたびに +1）ため、
  将来リトライを実装する際の材料は残っている。

## D-ingest-3: `TenantSettingsStore` は「既定 half-life の読み出し」だけに絞る

- **決定**: `getDefaultHalfLifeHours(ctx): Promise<number>` の1メソッドのみを持つ
  最小限の interface とした。行が無いテナントには `DEFAULT_HALF_LIFE_HOURS`（720、
  DB の `DEFAULT 720` と同じ値）を返す。

- **理由**: roadmap.md 段階3が要求するのは「Memory 作成時に
  `tenant_settings.default_half_life_hours` を既定値として使う」ことだけであり、
  `event_retention_days`・`taxonomy_mode` の読み書きは他の段階（監査ログ運用・
  taxonomy）の責務である。今回使わない設定項目のための CRUD を先取りして作ると、
  使われないコードパスが検査もされないまま残る。

## D-ingest-4: 抽出の安全弁は「LLM 呼び出し自体の失敗」と「digest 個別の失敗」を区別する

- **決定**:
  - `LLMProvider.completeStructured` の呼び出し自体が失敗（例外）した場合、
    Observation の全文をそのまま1件の `provenance.kind: 'stated'` Memory として残す
    （`extraction.ts` の `fallbackWholeObservationCandidate`）。
  - LLM が正常に応答したが、ある候補の `digest` が空/欠落だった場合は、その候補**単体**の
    digest だけを機械的な先頭文字列切り出しにフォールバックする
    （`digest_source = 'fallback'`）。`content` は成否に関わらず常に書く
    （memory-model.md §4 の安全弁をそのまま踏襲）。
  - **LLM が正常に0件の候補を返した場合はフォールバックしない。** 「記憶するに値する
    ものが無い」は正常な抽出結果であり、これを失敗として扱って無理に1件作ると、
    北極星の物差し（毎回渡す量を減らす方向に働くか）に反するゴミ記憶を増やす。

- **これが覆るとしたら**: 実運用で「LLM が0件を返しすぎる」（想定より多くの発話が
  記憶されない）ことが問題になったら、抽出プロンプトの調整が先であり、この判定基準
  （0件を失敗として扱わない）自体を変える理由にはならない、というのが現時点の判断。

## D-ingest-5: `contentHash`（D16）は runtime に注入された関数として計算する

- **決定**: `RuntimeDeps.hashContent: (content: string) => string` を runtime の
  必須の依存として要求する。`packages/postgres` が `sha256Hex`
  （`node:crypto` の `createHash('sha256')`）を実装として提供し、runtime の
  組み立て時にこれを渡す。

- **理由**: `runtime.ts` は `packages/core` に置く（architecture.md §4）が、core は
  zod 以外の実行時依存を持てない（§3.6、`dependency-boundary.test.ts` で機械的に
  検査）。`node:crypto` は npm パッケージではなく Node 組み込みモジュールのため
  `package.json` の依存境界テストはすり抜けるが、**「zod 以外を知らない」という
  設計原則自体には反する**。関数を注入で受けることで、runtime のロジック
  （どう Memory を組み立てるか）と、ハッシュの具体的な計算方法（SHA-256 か、
  将来別のアルゴリズムに変えるか）を分離した。

## D-ingest-6: `observe()` の戻り値は「以前作られた Memory を遡って探さない」

- **決定**: 冪等な再送（`createObservationWithOutbox` が `created: false` を返す）の
  場合、`ObserveResult.memoryIds` は空配列を返す。「最初の呼び出しで作られた Memory の
  id を再度返す」ことはしない。

- **理由**: `MemoryStore` interface には「observationId から作られた Memory を逆引きする」
  手段が無い（`sourceObservationId` へのインデックス検索は Phase 1 の interface に
  含まれていない）。これを足すこと自体は可能だが、roadmap.md 段階3の完了条件は
  「Memory が重複して作られないこと」であり、「再送時に以前の id を再返却すること」
  までは要求していない。呼び出し側が再送時の id を必要とする場合、`externalId` を
  自前で保持しておくか、（Phase 4 以降で）`recall()` 経由で探す形になる。

- **これが覆るとしたら**: 呼び出し側から「べき等な `observe()` は最初の結果を
  再現してほしい」という要望が来たら、`MemoryStore` に逆引きメソッドを足すか、
  `createObservationWithOutbox` の衝突時に `sourceObservationId` で `memories` を
  引く経路を追加する。

## D-ingest-7: OpenAI の Structured Output 翻訳における `null` の扱い

- **決定**: `packages/openai` の `translateForOpenAIStructuredOutput` は、zod の
  `.optional()` フィールドを OpenAI strict モードの要求（全フィールドを `required` に
  含める代わりに `null` を許容する）に合わせて変換する。逆方向
  （`OpenAILLMProvider.completeStructured` が受け取った JSON を core の zod スキーマで
  再検証する際）では、`null` を再帰的に「キーが無い」状態へ変換してからパースする
  （`stripNulls`）。

- **これは「`null` は常に『値が無い』を意味する」という前提に立つ。** `completeStructured`
  に渡すスキーマが `.nullable()` を使って「明示的な null」と「省略」を意図的に区別
  したくなった場合、この汎用的な変換は正しく動かない。Phase 1 で実際に
  `completeStructured` へ渡すスキーマ（`extraction.ts` の `ExtractionResultSchema`）には
  そのような区別を要するフィールドが無いことを確認済み。

- **これが覆るとしたら**: `consolidate`/矛盾判定（architecture.md §3.8 が列挙する
  他2用途）で `null` と「省略」を区別したいスキーマが必要になったら、
  `stripNulls` をスキーマ認識型の変換（対象の zod スキーマを見て、`.nullable()` を
  明示的に使っているフィールドだけは `null` を残す）に置き換える必要がある。

- **確かめていないこと**: OpenAI の実際の API が、この PR が仮定した通りの strict
  モードの挙動（省略可能フィールドは `null` として返る）を実際に返すかどうかは、
  `OPENAI_API_KEY` が無い環境（このリポジトリの開発・CI 環境）では検証できていない。
  `packages/openai/src/__tests__/live.openai.test.ts` は `OPENAI_API_KEY` がある場合
  だけ実行され、CI では常に skipped として表示される。PR 本文にこの制約を明記する。

⚠ 2026-09-29 追記: `docs/roadmap.md` の §2（段階3） は 2026-09-29 に削除した（#762）。当時の本文は [635c93d](https://github.com/takecchi/mnemora/blob/635c93dcda148f44cf6b51ac2407b28596fccb32/docs/roadmap.md) を参照。
