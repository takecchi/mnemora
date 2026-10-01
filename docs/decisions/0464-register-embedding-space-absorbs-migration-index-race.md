# ADR 0464: `registerEmbeddingSpace` の索引作りが migration（0022・0027）と重なって `23505` で落ちるのを、1回の打ち直しで吸収する（穴探し36巡目、ADR 0460 の D1）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先の委譲先が書いた。直し方の線（register の側で自分の索引名の衝突だけを吸収する。逆向きは材料）はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。
この ADR は [ADR 0460](./0460-multi-process-multi-pool-round33.md)（PR #1568）の上に積んである。0460 の負債 D1 の行は書き換えない。

- **文脈**:

  0460 の負債 D1: `runMigrations`（0022）と `registerEmbeddingSpace` を同時に流すと、後者が `23505`（`pg_class_relname_nsp_index`）で落ちうる（33巡目: 30回中2回）。0022 の DO ブロックと `registerEmbeddingSpace` は、同じ名前の索引を `CREATE INDEX IF NOT EXISTS` で作る。2つの advisory lock のキーは別（`MIGRATION_LOCK_KEY` と `REGISTER_EMBEDDING_SPACE_LOCK_KEY`。`vector-space.ts` が「意図的に別の値」と書く）なので、lock は守らない。

  **機序**【実測で裏づけ】: migration は 1 ファイル 1 トランザクションで索引を作るので、`pg_class` の行はコミットされるまで他のセッションから見えない。`IF NOT EXISTS` の存在確認はその行を見ず「無い」と判定し、同じ名前の行を入れようとして、一意索引（`pg_class_relname_nsp_index`）の上で相手のトランザクションの終わりを待つ。相手がコミットすると `23505` になる。待ちは `pg_locks` で `transactionid` の `ShareLock`（待っているのは `CREATE INDEX IF NOT EXISTS …` の文）。

  【実測】2026-10-01、Postgres 17（UTF8、`C.UTF-8`）。別の接続で `BEGIN; CREATE INDEX IF NOT EXISTS <同じ名前> …` を未コミットで握り、`registerEmbeddingSpace` を撃ってから COMMIT する形（migration の代用）で、**決定的に再現した**:
  - 0022 の零ノルムの部分索引: `23505` / `pg_class_relname_nsp_index`。
  - **0027 の `memory_id` の索引**（33巡目は測っていなかった）: 同じ。**0027 の組でも起きる。**
  - `detail` は `Key (relname, relnamespace)=(<索引名>, <schema の oid>) already exists.`。

  **逆向き**（migration の側が落ちる）も、実地で再現した【実測】。`registerEmbeddingSpace` の索引作りの最中（autocommit の1文が走っている間）に、`runMigrations`（0022 を未適用に戻した DB）が同じ名前を作ろうとすると、`registerEmbeddingSpace` がコミットした時点で migration が `23505` で落ち、ファイルごと巻き戻る（台帳に 0022 の行は残らない）。
  - 決定的な代用（register 側の `CREATE INDEX` を未コミットで握る）: 再現。
  - 本物の文: 埋め込み表に 30万行（外部キーを外して挿入。窓を広げるため）を入れ、`registerEmbeddingSpace`（別の Pool）と `runMigrations` を同時／100〜450 ms ずらして撃つ。12 回中 **3 回** `migrate=23505`、register が落ちた回は 0。16 回の別の組でも migrate 側 3 回。33巡目の 30 回中 0 回は、表が空で窓が狭かったため。

- **決めたこと**:

  1. **`registerEmbeddingSpace` の 2 つの `CREATE INDEX IF NOT EXISTS`（零ノルムの部分索引・`memory_id` の索引。migration が作る組）は、`23505` で落ちたら、同じ文を 1 回だけ打ち直す**（`create-index-race.ts` の `createIndexIfNotExistsAbsorbingRace`。公開 API ではない。`index.ts` から export しない）。打ち直す時点では相手がコミット済みなので、「既にある」で通る。
  2. **吸収する条件は絞る**: `code` が `23505`、かつ `constraint` が `pg_class_relname_nsp_index`、かつ `detail` が `Key (relname, relnamespace)=(<自分が作ろうとした索引名>,` で始まるとき。ほかの `23505`（別の名前の索引、別の制約）と、ほかの SQLSTATE は今までどおりそのまま投げる。schema の oid は照合しない（oid は文面にしか出ず、名前に schema を含めた比較には追加の問い合わせが要る。索引名は空間の組から導く長い名前で、別 schema の同名の索引とぶつかるのは `registerEmbeddingSpace` を別 schema で同時に呼ぶときだけ【判断】）。
  3. **打ち直しは 1 回だけ**。打ち直しても落ちたら、2 回目のエラーをそのまま投げる。
  4. **`CREATE TABLE IF NOT EXISTS` と HNSW の索引は対象外**。migration はどちらも作らない（`memory_embeddings_<space>` は `registerEmbeddingSpace` だけが作り、migration は既に在る表に索引を足すだけ）。`registerEmbeddingSpace` どうしの衝突は advisory lock が守る（ADR 0018）。もっとも、この探り棒の範囲で別の組は見つからなかった。
  5. **新しい例外は出さない。公開 API・既定値・migration ファイルは変えない。** 落ちる入力が減るだけである。
  6. **逆向きは直さない**（材料。下の負債 D1b）。

- **検討した代替案**:

  - **`registerEmbeddingSpace` も `MIGRATION_LOCK_KEY` を取り、migration と直列にする**: 正方向も逆向きも塞げる。ただし、migration が長い間 lock を握ると、`registerEmbeddingSpace` が `lockTimeoutMs` で落ちる入力が増える（新しい失敗）。0331 が避けた「無関係な待ち」も戻る。線にかかるので採らない（逆向きの案 (a) として下に残す）。
  - **吸収の条件を `23505` だけにする（名前を照合しない）**: 別の名前の索引・別の制約の `23505` まで黙って打ち直し、本物のエラーを隠す。却下（変異 (ii) の歯が縛る）。
  - **何度でも打ち直す**: 相手が長く続く間に回り続け、止まらない。却下（変異 (iii) の歯が縛る）。
  - **`EXCEPTION WHEN unique_violation` を 0022・0027 の DO ブロックに足す**: 出荷済みの migration ファイルの中身を変える。材料止まりの線（逆向きの案 (c)）。

- **引き受けた負債**:

  | # | 内容 | 再現・結果 | 緊急度 | 直さなかった理由 | 覆る条件 |
  | --- | --- | --- | --- | --- | --- |
  | D1b | **逆向き**: `registerEmbeddingSpace` の索引作りの最中に `runMigrations` が同じ名前を作ろうとすると、migration が `23505` で落ち、ファイルごと巻き戻る | 【実測】30万行で `registerEmbeddingSpace` と `runMigrations`（0022 未適用）を同時に撃つ: 12 回中 3 回（別の 16 回でも 3 回）。決定的な代用でも再現。台帳に 0022 の行は残らず、呼び直せば通る | 低（0022・0027 より前の版から上げた直後の、同時起動で、`registerEmbeddingSpace` の索引作りが長く掛かる大きい表のときだけ。呼び直せば通る） | 3 案のどれも線にかかる（下）。選ぶのはクローンがオーナーへ回す | ローリングデプロイでの migration の失敗の報告が来たとき |

  **逆向きの 3 案と、かかる線**:
  - (a) `registerEmbeddingSpace` も `MIGRATION_LOCK_KEY` を取り、migration と直列にする → `lockTimeoutMs` で落ちる入力が増える（新しい失敗）。
  - (b) runner が `23505`（`pg_class_relname_nsp_index`）で落ちたファイルを 1 回だけ流し直す → runner の振る舞いの変更。
  - (c) 0022・0027 の DO ブロックに `EXCEPTION WHEN unique_violation` を足す → 出荷済みの migration ファイルの中身を変える（材料止まりの線）。

- **これが覆るとしたら**:

  1. 逆向きの失敗の報告が来て、(a)〜(c) のどれかを選ぶとき（選んだら、この吸収は不要になるか、二重になる）。
  2. `registerEmbeddingSpace` が `23505` を吸収した後の打ち直しでも落ちる報告が来たとき（そのときは 1 回では足りない形が在る。無限には打ち直さない）。
  3. migration がほかの `registerEmbeddingSpace` の索引（HNSW など）も作るようになったとき（決定 4 の前提が崩れる）。

- **測ったこと**（【実測】2026-10-01、Postgres 17、UTF8（`C.UTF-8`）、1 ファイルずつ名指し）:

  **歯**（先に書いて赤を見せた）:
  - `vector-space-migration-index-race.postgres.test.ts`（2 本。零ノルム・`memory_id`）。migration の代用の `BEGIN; CREATE INDEX IF NOT EXISTS <同じ名前>` を未コミットで握り、`registerEmbeddingSpace` が `pg_locks` の `transactionid` の待ちに入ったのを見てから COMMIT する。**決定的**（毎回再現）。`pg_locks` を読むので直列の群（`SERIAL_TEST_FILES`）に入れた。
    - **直す前: 2 本中 2 本が赤**（`expected 'rejected: 23505' to be 'resolved'`）。**直した後: 緑**。
  - `create-index-race.test.ts`（6 本。DB を使わない）。吸収する範囲の線: 自分の名前の `23505` は 1 回だけ打ち直して通す／別の名前の `23505` は打ち直さず投げる／前方一致するだけの別の名前（`idx_mine_2`）も投げる／別の制約の `23505`・`42P07` は投げる／打ち直しても落ちたら 2 回目をそのまま投げる（呼び出しは 2 回）／`detail` が無い・null は false。

  **変異**（`cp` で退避→変異→戻す。戻した後に両ファイルが緑）:

  | # | 変異 | 結果 |
  | --- | --- | --- |
  | (i) | 吸収の分岐を外す（常に投げる） | 8 本中 4 本が赤（`create-index-race.test.ts` の「打ち直して通す」「打ち直しは 1 回だけ」、`vector-space-migration-index-race` の 2 本） |
  | (ii) | 名前の照合を外す（`Key (relname, relnamespace)=(` で始まれば吸収） | `create-index-race.test.ts` の「別の名前は吸収しない」「前方一致の別の索引も吸収しない」の 2 本が赤 |
  | (iii) | 打ち直しを 5 回まで許す | `create-index-race.test.ts` の「打ち直しは 1 回だけ」の 1 本が赤 |

  **本物の文での再現率**（埋め込み表に 30万行。`registerEmbeddingSpace` と `runMigrations`（0022 を未適用に戻した DB）を、migrate を先に、register を 0・100・200・300 ms 遅らせて撃つ。16 回）:
  - 直す前: `register=23505` が **1 回**（残り 15 回は register が通る）。
  - 直した後: `register=23505` が **0 回**。
  - どちらの実行でも `migrate=23505`（逆向き）が 3 回出た。窓の取り方（register が先に走っている間に migrate が始まる回）による。
  - 正方向の自然な再現率は低い（33巡目の 30 回中 2 回、今回の 16 回中 1 回）。再現率の低さは窓の短さによる。そのため、CI の歯は窓を決定的に作る形にした。

  **走らせたテスト（ファイル名指し）**: `packages/postgres/src/__tests__/` の `vector-space-migration-index-race.postgres.test.ts`、`create-index-race.test.ts`、`vector-space-concurrency.test.ts`、`vector-space-single-connection-pool.test.ts`、`embedding-zero-norm-migration.postgres.test.ts`、`erase-tenant-fk-indexes.postgres.test.ts`、`vector-space-dimensions-limit.test.ts`、`embedding-space-table-enumeration-consistency.postgres.test.ts`、`advisory-lock-cleanup.postgres.test.ts`。全テストは走らせていない。

- **測っていないこと**（未測定）:

  - 逆向きの 3 案の実装と効果（材料のみ）。
  - 別 schema（`options.schema`）で同時に呼ぶ形での吸収。
  - SQL_ASCII の DB。吸収は SQLSTATE と `constraint`・`detail` の文面で判定するので、`detail` の文面がロケールで変わる場合は照合が外れて吸収されなくなりうる【未確認】（`lc_messages` を変えた環境では未測定）。
