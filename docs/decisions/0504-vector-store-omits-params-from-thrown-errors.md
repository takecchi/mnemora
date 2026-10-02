# ADR 0504: `PostgresVectorStore` を直接呼んだときの例外からも、SQL の `params` の値を落とす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定（2026-10-02）。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  [ADR 0443](./0443-aux-field-drop-bind-limit-association-fetch.md) の「引き受けた負債」に、「`searchMany` の例外の `cause` には、1文ぶんの `params`（最大 16384 件のベクトル）が残る。`Runtime` を通れば `omitParamsFromError`（[ADR 0423](./0423-identifier-well-formed-and-error-message-without-params.md)）が落とすが、store を直接呼ぶ呼び出しでは落ちない（[ADR 0430](./0430-concurrent-create-erase-and-standalone-params.md) の負債と同じ）」とあった。クローンは「例外の `cause` に params が残らない方が安全なので、store 側でも落とす」と決めた。

  【現物】`omitParamsFromError`（`packages/core/src/failure-description.ts`）は core の内部関数で、`packages/core/src/index.ts` から出ていない（`runtime.ts`・`recall-runtime.ts`・`erase-tenant.ts`・`event-retention-purge.ts`・`outbox.ts`・`interfaces/tenant-settings-store.ts` が内部で使う）。`packages/postgres` には同等の関数が無い。postgres パッケージの `PostgresVectorStore` は、drizzle が包んだ例外（`message` が `Failed query: <SQL>\nparams: <値>`）をそのまま投げる。`searchMany` は 1 文に最大 16384 件のベクトルが params に載る。

  【現物】`PostgresVectorStore` の口のうち、`upsert`・`search`・`searchMany`・`delete`・`getVectors` は `translateUnregisteredSpace` を通る。これは 42P01（空間の表が無い）を `EmbeddingSpaceNotRegisteredError` に包み、元の例外を `cause` に残す。それ以外の例外はそのまま投げる。つまり**包んだ側も、包まずに投げる側も、params 入りの message が残る**。`deleteAcrossSpaces`・`eraseTenant` は `translateUnregisteredSpace` を通らず、`db.transaction` の例外をそのまま投げる。

- **決めたこと**:

  1. **`PostgresVectorStore` の全ての口が投げる例外から、message（と `stack`・`cause` の連鎖）の `params:` より後ろを落とす。** 形・印は core の `omitParamsFromError` と同じ（SQL の文は残し、`params: (omitted by mnemora, N chars)` にする。例外そのものを返し、新しい例外は作らない。`code`・`name`・`kind`・`cause` は残る。目印が無い例外は変えない）。
     - `translateUnregisteredSpace` の2つの `throw`（包んだ側の `cause` と、包まずに投げる側）に掛ける。これで `upsert`・`search`・`searchMany`・`delete`・`getVectors` の5口が直る。
     - `deleteAcrossSpaces`・`eraseTenant` は、`db.transaction(...)` の呼びを同じ処理で包む。
  2. **新しい export は足さない。** core の関数は公開されていないので、`packages/postgres/src/omit-params.ts`（パッケージ内部。`index.ts` から出さない）に同じ形の小さな複製を置いた。印が core のものと同じなので、あとから `Runtime` が掛けても二重に壊れない（ADR 0430 決定3 の「べき等」と同じ）。
  3. **変えないもの**: `DrizzleQueryError` の `params` プロパティ（値の配列）と、`cause` の pg エラーの `message`・`detail`（ADR 0423「塞がらない経路」と同じ）。
  4. **他の store の口は、このPRでは直さない**（下の表。引き受けた負債）。
  5. 断る入力は増えない。例外の種類・`kind`・SQLSTATE も変わらない。変わるのは message の `params:` 以降の文字列だけ。

- **同じ穴が他の口にあるか**（【実測】2026-10-02、手元の Postgres 17。穴は「store が投げた drizzle の例外の message に params が残る」こと）:

  【現物】`packages/postgres/src` で `omitParamsFromError`・`omitDrizzleParams` を呼ぶ箇所は、このPRの前は無かった。`catch` を持つ口は `claim-key-index-limit.ts`（`ClaimKeyIndexLimitError`。ADR 0435 が `cause` を値なしの新しい `Error` にしている）・`vector-store.ts` の `translateUnregisteredSpace`・`memory-store.ts` の一部（savepoint の巻き戻しなど）だけで、**DB の例外をそのまま伝える口が大半**である。

  | store | 口 | params が残るか | 実測・根拠 | このPR |
  | --- | --- | --- | --- | --- |
  | `PostgresVectorStore` | `upsert`・`search`・`searchMany`・`delete`・`getVectors` | 残る（包んだ `cause` も、包まず投げる側も） | 歯が直す前に赤（未登録の空間の5口と、次元違いの `upsert`） | 直した |
  | `PostgresVectorStore` | `deleteAcrossSpaces`・`eraseTenant` | 残る（`db.transaction` の例外をそのまま投げる） | 歯（drizzle 形の例外を投げる db）が直す前に赤。本物の DB で起こす入力は見つけていない | 直した |
  | `PostgresEventStore` | `append`・`get`・`list` | 残る | `append` に `meta` の孤立サロゲートを入れると、message に値が載った（【実測】） | 負債 |
  | `PostgresLexicalStore` | `search` | 残る | `filter.attributes` の孤立サロゲートで、message に値が載った（【実測】） | 負債 |
  | `PostgresTrigramLexicalStore` | `search` | 残る見込み（未実測。同じ drizzle の経路） | 現物を読んだだけ | 負債 |
  | `PostgresMemoryStore` | 書き込み・読み取りの全口 | 残る見込み。入口の検査（ADR 0423 決定4・0431・0437）が先に断る入力は DB に届かないので、本物の DB で起こせる入力は限られる | `createObservation` に孤立サロゲートを入れても message は clean（入口で断る）だった（【実測】）。DB の障害・制約違反・タイムアウトの経路は未実測 | 負債 |
  | `PostgresOutboxStore` | 全口 | 残る見込み（未実測）。`last_error` の列は ADR 0363 が落とし済み（例外ではなく列の話） | 現物を読んだだけ | 負債 |
  | `PostgresTenantSettingsStore` | 全口 | `Runtime` 経由・core の公開ヘルパー9本（ADR 0437）経由なら落ちる。store の直接呼びは残る見込み | 現物を読んだだけ | 負債 |
  | `PostgresRelationStore` | `link`・`unlink`・`listRelated*` | 残る見込み（未実測） | 現物を読んだだけ | 負債 |

  口の数は焼き込まない（口は増減する）。**同じ直しで済むもの**は、`packages/postgres/src/omit-params.ts` の `omittingParams` で口を包めば足りる。ただし store ごとに口が多く（とくに `PostgresMemoryStore`）、1本の PR で全部を包むと差分の大半が機械的な包みになる。代表（ベクトル、params が最も大きくなる口）に絞り、残りは負債にした。

- **検討した代替案**:

  1. **core の `omitParamsFromError` を `index.ts` から export する。** 採らなかった。公開 API の追加で、`pnpm api:check` の対象が変わる。オーナーの領分（担い手は export を足さない）。複製との引き換えになる点は負債に書いた。
  2. **`Db`（drizzle のクライアント）を包んで、全 store の全口に一括で掛ける**（`client.ts` が `db.transaction` を包んでいるのと同じ層）。採らなかった。全 store の挙動が一度に変わり、`Runtime` を通らない呼び出し全部の例外の形が変わる。`createPostgresClient` が返す `db` を利用者が直接使う場合の例外まで書き換わる。この PR の範囲を超える判断だと見た。**覆るとしたらここが本命**（下）。
  3. **`DrizzleQueryError` の `params` プロパティも消す。** 採らなかった。core の作法（ADR 0423「塞がらない経路」）と食い違い、`Runtime` 経由では残るプロパティが store 直接では消える非対称ができる。消すなら core と同時に決める。
  4. **`cause` を値なしの新しい `Error` に差し替える**（ADR 0435 の `valueFreeCause`）。採らなかった。`cause` の連鎖（pg の SQLSTATE を含む）を保ったまま message だけ落とすほうが、既存の `isUndefinedTableError`・利用者の `cause.code` 参照を壊さない。

- **引き受けた負債**:

  - **上の表の「負債」の口は、store を直接呼ぶと params 入りの message が残る。** `Runtime` を通れば落ちる（ADR 0423）。直すなら `omittingParams` で口を包む（機械的）か、代替案2の層で一括する。
  - **core の `omitParamsFromError` と、postgres の `omit-params.ts` が複製になった。** 片方だけ直すと食い違う。印の形（`(omitted by mnemora, N chars)`）が食い違うと、べき等が崩れて文字数の数字が印の長さに書き換わる（ADR 0430 が実測した害）。歯は、postgres 側の印と SQL の文が残ることを見るが、core との一致そのものは見ていない。
  - **`DrizzleQueryError` の `params` プロパティ（値の配列そのもの）は残る。** `error.params`（または `error.cause` の連鎖の `params`）を読めば、ベクトルは取れる。ログに message だけを出す利用者は守られるが、`util.inspect` でエラーオブジェクトごと出すと、プロパティ経由で出る。クローンの「`cause` に params が残らない」の意図を、プロパティまで含めて満たすかは確かめていない。
  - 例外を `Runtime` 経由の2段で掛けるため、`Runtime` の層で落ちたものを store でも落とす二重の処理になる（べき等なので害は無い）。

- **これが覆るとしたら**:

  - `DrizzleQueryError` の `params` プロパティまで消す判断が出たとき。core と同時に変える。
  - 全 store を一括で直す方針（代替案2、または公開の export。代替案1）に変わったとき。このPRの口ごとの包みは、その層に吸収されて不要になる。
  - core が `omitParamsFromError` を公開したとき。複製を捨てて import に替える。

- **測ったこと**（【実測】2026-10-02、手元の Postgres 17、UTF8（`C.UTF-8`）。歯を先に走らせて赤を見てから直した）:

  - 歯: `packages/postgres/src/__tests__/error-message-omits-params.postgres.test.ts`（既存のファイルに `describe` を足した。9本のうち8本が新しい）。ベクトルの目印と tenant の目印が、例外の連鎖の message・stack のどこにも無いこと、SQL の文と落とした印は残ること、SQLSTATE（42P01）・`kind` が残ることを見る。
  - **直す前: 新しい8本がすべて赤**（未登録の空間の5口、登録済みの空間への次元違いの `upsert`、`deleteAcrossSpaces`、`eraseTenant`）。既存の1本（`runtime.observe`）は緑。
  - **直した後: 9本とも緑**。`vector-store-unregistered-space`・`bind-parameter-limit-cliff`・`vector-store-search-many` の既存の歯も緑（23本）。
  - **変異（足りない側）**: (a) `translateUnregisteredSpace` の「包まずに投げる側」の掛けを外す → 1本赤（次元違いの `upsert`）。(b) 包む側の `cause` の掛けを外す → 5本赤（未登録の空間の5口）。(c) `eraseTenant` の包みを外す → 1本赤。戻すと緑。
  - **変異（やりすぎ側）**: (d) `message` を空にする（SQL の文まで消す）→ 8本赤。(e) `cause` を切る → 8本赤。(f) 落とした印を付けない → 8本赤。戻すと緑。
  - **測っていないこと**: `deleteAcrossSpaces`・`eraseTenant` を本物の DB で失敗させた例外（歯は drizzle 形の例外を投げる db で見た）。`searchMany` の16384件を超えるチャンクの2文目で落ちたときの例外（同じ `translateUnregisteredSpace` を通るが、チャンク境界での歯は無い）。表の「見込み」の口の実測。`DrizzleQueryError.params` プロパティが残ること自体の歯（残る前提で書いただけ）。core の関数との印の一致を検査する歯。
