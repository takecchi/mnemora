# ADR 0425: `runMigrations` は、台帳と手元のファイルのずれを見つけたら警告を出して続行する

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

2026-09-30 にクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  穴探し6巡目（mgr-196bed1a）が、`runMigrations`（`packages/postgres/src/migrate.ts`）に次の2つの穴を挙げた。
  どちらも、台帳（`_mnemora_migrations`）に載っている名前の集合と、手元の `migrations/*.sql` の集合が食い違うときに、何も言わずに進む。

  - **S-1**: 台帳から `0011_memory_events_kind_restored.sql` の行だけが欠けた DB で migrate を流すと、0011 が単独で当たり直り、
    `memory_events_kind_check` が 0011 の時点の値の並びに戻る。0018 が足した `'unsuperseded'` が、エラーも出ずに消える
    （`restoreSuperseded` が積むイベントの INSERT が、後になって CHECK 違反で落ちる）。台帳の行が欠ける経路は、手でのメンテナンス・
    部分的な復元・台帳を別に持ち出した移行などで、起こりうる。
  - **S-3**: 新しい版（例: 0032 まである）で上げた DB に、古い版（例: 0025 まで）から migrate を流すと、未適用のファイルが無いので
    「すべて適用済み」になる。手元の版が DB より古いことは、どこにも出ない。

  [ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md) は、`docs/autonomy.md` §3 の ⛔ 表から「§5 級の判断を自分で決めること」と
  「公開 API の破壊的変更」の2行を外し、担い手が決めて ADR に書いてよいとした。**ただし同 ADR は「迷ったら止まる」という規律は残している。**
  警告を足すだけなら、既存の利用者の呼び出しは壊れず、公開の型も変わらないので、この範囲は「決めて書く」側に収まる。
  2026-09-24 にオーナーが示した方針（「決められるものは判断して進めてよい」）も、同じ向きである。

- **決めたこと**:

  1. **`runMigrations` が、台帳（読んだ `alreadyApplied`）と `listMigrationFiles(migrationsDir)` を突き合わせ、次の2つを見つけたら
     `console.warn` で警告して続行する。** 新しく throw しない。適用の順序も中身も変えない。
     - (a) 未適用のファイルのうち、番号が、台帳に載っている番号の最大値より小さいものが在る。**そのファイルも、いまどおり当てる。**
       番号はファイル名の先頭の数字（`listMigrationFiles` は名前の昇順で並べ、ファイル名は 4 桁の 0 詰めなので、数としての順と一致する）。
     - (b) 台帳にある名前が、手元のファイルに無い。
  2. **警告は (a)(b) で別々の1回ずつ。** 文面に、どのファイル・名前か（(a) は台帳の最大の番号の名前も）と、何が起きうるか
     （(a) は当たり直しが後の migration の変更を巻き戻しうる、(b) は手元の版が DB より古い可能性）を入れる。
     CLI（`src/bin/migrate.ts`）は `runMigrations` を呼ぶので、そのまま標準エラーへ出る。
  3. **公開面を増やさない。** `--strict` のような公開オプション・公開型・戻り値の欄を足さない。突き合わせの関数は `migrate.ts` の
     モジュール内に閉じ、export しない（`index.ts` は `export * from "./migrate.js"` なので、export すれば公開 API になる）。
     `scripts/__snapshots__/public-api/postgres.d.ts` は変わらない。
  4. **接頭辞は既存の作法（`client.ts` の pool error 警告）に合わせ、`[@mnemora/postgres]` を頭に付ける。**
     そのため、`src/__tests__/setup-pool-error-warning-guard.ts`（この接頭辞で始まる `console.warn` を throw に変える守り、Issue #1213）を
     直した。守りが掛かる条件を、**接頭辞だけ**から、**接頭辞 + pool error 警告の固定の文言**（新しい定数 `POOL_ERROR_WARNING_HEAD`、
     `pool-error-warning.ts`。`client.ts` も同じ定数から文言を作る）へ絞った。理由は下の「守りの扱い」。

- **守りの扱い**:

  部分的な `migrationsDir`（`9405_lock_timeout_scope.sql` だけを置いた一時ディレクトリなど）を使う既存のテストは、共有の台帳
  （`public._mnemora_migrations` に 0001〜0032 が載っている）に対して流すので、(b) の警告が**正当に**出る。
  守りが接頭辞で掛かっていると、`migrate-lock-timeout-scope.test.ts`・`migrate-partial-apply.test.ts` がこの警告で落ちる
  （守りを接頭辞に戻す変異で実測した）。落ちるのは守りの意図ではない——守りが防ぐのは「`onPoolError` を持たないテストが、
  pool error の既定の警告を見逃すこと」であり、migrate の警告はそれと関係が無い。
  採ったのは「守りを pool error 警告の文言まで絞る」。**守りを弱めたのではなく、対象を正確にした。**
  pool error の警告では相変わらず噛むことは、`pool-error-warning-guard.postgres.test.ts`（守りを無効にする変異で赤になることを実測した）と
  `readme-unbound-promises.postgres.test.ts` の A が縛っている。文言は `client.ts` と守りが同じ定数を使うので、片方だけ変わって守りが空振りすることは無い。

- **検討した代替案**:

  1. **新しい throw で止める。** 採らなかった。(a) のずれを持つ既存の利用者の migrate が、ある日から止まる。公開 API
     （`runMigrations` は「何度流しても通る」）の意味が変わる。止めるか続けるかは、利用者が判断することである。
  2. **`--strict` などの公開オプションを足し、指定されたときだけ止める。** 採らなかった。公開 API（`RunMigrationsOptions`・CLI のフラグ）が増える。
     警告を読んだ利用者が自分で止めたければ、標準エラーを見るなり `console.warn` を差し替えるなりで足りる。必要が出たら後から足せる（逆は破壊的）。
  3. **(a) のファイルを当てずに飛ばす。** 採らなかった。「適用の順序や中身を変えない」のが、この変更の範囲である。飛ばすと、
     台帳に行が無い理由が「本当に未適用」のときに、必要な migration が当たらなくなる。
  4. **警告用の別の接頭辞を使い、守りは変えない。** 採らなかった。`[@mnemora/postgres]` は package の出力の共通の頭で、利用者が grep する単位である。
     守りのほうを正確にするほうが、出力の作法を割らない。

- **引き受けた負債**:

  - 警告は `console.warn` なので、標準エラーを見ていない運用では気づかれない。止めないことの代償である。
  - (a) は「番号の最大値より小さい未適用」という見立てで、**意図して小さい番号を後から足した場合（ブランチ同士の取り込みなど）でも鳴る**。
    その場合の警告は偽陽性だが、当たり直しの危険（S-1）と同じ形なので、鳴ってよいと判断した。
  - (b) は、手元の版が古い場合だけでなく、利用者が手元の migration ファイルの名前を変えた場合にも鳴る。
  - 部分的な `migrationsDir` を使う既存のテストは、(b) の警告を出す（標準出力には出ないが、出ている）。テストは通る。
  - 警告は、当たり直しによる巻き戻しそのものは防がない。S-1 の被害（`'unsuperseded'` が消える）は起きる。気づけるようにしただけである。
  - `examples/chat/src/__tests__/setup-pool-error-warning-guard.ts` は接頭辞の複製を持つ（別の package）。そちらの守りは、この変更では絞っていない。
    そちらのテストが部分的な `migrationsDir` で `runMigrations` を流す形になったら、同じ絞り込みが要る。

- **これが覆るとしたら**:

  警告では足りず、止めるべきだという被害の報告が出たら、新しい throw でなく、まず opt-in の公開オプションを検討する
  （止める既定への変更は、`docs/migration-v1.md` の「破壊的」に当たる）。

- **測ったこと**:

  - `packages/postgres/src/__tests__/migrate-ledger-drift-warning.postgres.test.ts`（専用スキーマの中で走る）。
    実装前は、ずれ無しの再実行の1本だけが緑で、(a)(b) の2本が赤（警告が 0 件）だった。(a) は実 migrations で S-1 を再現し、
    `memory_events_kind_check` から `'unsuperseded'` が消えること、警告が当たり直されるファイルと台帳の最大の番号の名前を含むことを縛る。
  - 変異試験: (a) の条件を潰すと (a) の1本だけ、(b) の条件を潰すと (b) の1本だけが赤。守りを接頭辞に戻すと、部分的な
    `migrationsDir` を使う既存のテスト（2本）が赤。守りを無効にすると `pool-error-warning-guard.postgres.test.ts` が赤。
  - 警告の文面は、当たり直しの結果（S-1 の被害が具体的に何か）を一般形でしか書けない。`'unsuperseded'` が消えることの名指しは、テストと
    `packages/postgres/README.md` にある。
