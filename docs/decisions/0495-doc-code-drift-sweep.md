# ADR 0495: 文書とコードのずれを横に掃く — パッケージの README・約束の文書・公開の型の TSDoc を、今の main の型と実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。文書の側だけを直した。コードの側を文書に合わせる必要がある食い違いは見つからなかった。

**この ADR は書き直されている。** 最初の版を書いた担い手のセッションは失われ、その版が使った照合スクリプトも残っていない（repo の外に置いて、コミットしていなかった）。最初の版の【実測】は再現できないので、**後任の担い手が、`main` の `3ba8e4b5`（ADR 0492 の merge の時点）に対して、照合をやり直して**、自分が実際に走らせた結果で書いた。最初の版が直した3件（下の「直したもの」の 1〜3）はそのまま残り、今回の掃きで見つけた2件（4・5）を足した。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0459 以来の、文書とコードのずれの掃き。今日（2026-10-01〜02）main に入った ADR（0476〜0485・0487・0489・0490・0491・0492。0486・0488 は未マージ、0493・0494 は別の PR の面）のあとで、古くなった所が無いかを、機械で照らせる形を中心に見た。対象外: `docs/migration-v1.md`・CHANGELOG・`examples/chat/README.md`・`docs/decisions/*`・`docs/north-star.md`。

- **照らした範囲**【現物】:
  - 文書: `packages/core`・`testkit`・`postgres`・`bullmq`・`openai`・`anthropic`・`local-embedding` の各 `README.md`、`docs/recall.md`・`docs/memory-model.md`・`docs/architecture.md`・`docs/conformance.md`・`docs/vision.md`。
  - TSDoc: `packages/*/src` のうち `__tests__`・`__fixtures__`・`bench` と `*.test.ts` を除いた `.ts`（core・testkit・postgres・bullmq・openai・anthropic・local-embedding）。
  - 照合の相手（コード側）: `packages/*/src`・`packages/*/migrations`・`examples/chat/src`・`scripts` の語（識別子と文字列リテラル。TypeScript のパーサで取り、コメントは含めない）と、`pnpm run build` で作った各パッケージの公開の入口（`dist/*.d.ts`）の export。

- **照らした形と結果**【実測】（`main` の `3ba8e4b5` + この枝。スクリプトは repo の外に置いて、コミットしていない。道具として残す価値があるかは【判断】で下に書く）:
  1. **識別子の実在**: 上の文書のバッククォートの語（camelCase・snake_case・Pascal・大文字定数）と、コード片の中の語を、コードの語に照らした。コードに無い語は出たが、**現物を引いて見ると、すべて次のどれかだった**: 外部の名前（Postgres・SQL・BullMQ・openai・Anthropic・transformers.js・環境変数）、例・仮名（`groupRuntime`・`MyEventStore`・`tenant_a`）、alteroid の名前（`JournalStore` ほか）、将来の設計（`Sensor`/`SpeechPolicy`）、「落とした」「以前の名前」と書く否定・経緯の文（`exactCounts`・`ClaimKeyOptions.formContestedGroups`・`annWindowHadNoInScopeCandidates`・`budget_exhausted`・`tag_match`・`score.semanticSimilarity`〔旧称だと書いた段落〕）、綴り違いの例（`scoreTreshold`）、examples/chat・testkit の補助 class（`CachingEmbeddingProvider` ほか）、SQL の索引名の接頭辞・説明用の名前。**実在しない名前を現在のものとして書いた所は、この照合では見つからなかった。**
  2. **`Type.member` の実在**: 文書の `` `RuntimeDeps.relationStore` `` のような `型名.メンバー` を、公開の入口の型に TypeScript の型検査器で引いた。出たのは、否定・経緯の文（`RecallQuery.exactCounts`・`ClaimKeyOptions.formContestedGroups`・`RecallQuery.relations`）と、zod の schema の名前（`RecallAssociationQuerySchema.minSimilarity` など、型の欄の言い換え）だけだった。
  3. **TSDoc の識別子**: 上の TSDoc のコメント（`/** */` と `//`）の、バッククォートと `{@link …}` の語を、コードの語に照らした。**実在しないものを指していた所が 2 件**（下の「直したもの」の 4・5）。それ以外は、外部の名前、プレースホルダ（`XxxProvenance` ほか）、以前の名前だと書いた経緯（`annReachablePool`・`describeJobFailure`〔`{@link describeFailure}` を指すと本文が言う〕）、非公開の関数（`connectWithErrorListener`）だった。
  4. **パス・リンク・migration のファイル名**: 文書の `packages/…`・`docs/…`・`examples/…`・`scripts/…` のパスと相対リンク、`NNNN_*.sql` の実在。出たのは、alteroid のリポジトリのパス（`memory-model.md` の `packages/core/src/store.ts`）、将来の例（`packages/tei`）、説明用の例（`9001_slow.sql`）、`docs/decisions/` の末尾スラッシュ付きのリンクだけだった。
  5. **README・約束の文書の `import { … } from "@mnemora/…"` の名前**: 公開の入口（`dist/*.d.ts`）の export に照らした。**ずれは無い。**
  6. **README のコード片**: `pnpm run build` のあとで `node scripts/check-doc-snippets.mjs`。`ts check` の印の付いた片は全部通った。
  7. **既存の歯**: `scripts/__tests__/` の `architecture-section5-port-interface-correspondence`・`architecture-section5-port-signature-correspondence`（architecture.md §5 の port の写し）・`runtime-method-doc-correspondence`・`readme-postgres-objects`・`doc-reference`・`conformance-it-count-formula` を名指しで走らせた。通った。
  8. **既定値・数値**: 文書の「既定」の数値と名前を、定数・スキーマに手で引いた。`DEFAULT_RECALL_ASSOCIATION`（`maxCount`）・`DEFAULT_ASSOCIATION_ANCHOR_COUNT`・`DEFAULT_ASSOCIATION_MIN_SIMILARITY`・`DEFAULT_DIGEST_BAND_LIMIT`（と `digestBandLimit` が正の整数であること）・`DEFAULT_SCORE_THRESHOLD`・`DEFAULT_DECAY_THRESHOLD`・`DEFAULT_HALF_LIFE_HOURS`・`relationMaxCount` の範囲（1〜1000）・`RecallQuery.limit`・`DeterministicEmbeddingProvider` の次元・`@mnemora/local-embedding` の `DEFAULT_LOCAL_EMBEDDING_*` の全部と `retry` の既定・`@mnemora/bullmq` の `jobName` の既定・`@mnemora/postgres` の `lockTimeoutMs`（`DEFAULT_LOCK_TIMEOUT_MS`）と `extensionMode` の既定・抽出の `confidence` の既定、がすべて文書と一致した。外部 SDK の版と既定（`openai@7.10.0`・`@anthropic-ai/sdk@0.124.0` の `maxRetries: 2`・`timeout: 600000`、`bullmq@6.3.8` の `lockDuration: 30000`・`stalledInterval: 30000`）は、`package.json` と、インストールした SDK の現物の読みで一致した。
  9. **今日の直しごとに古くなった所**: `git diff 86e21bb3 origin/main`（ADR 0459 の掃きの後に、`packages/*/src` の本体と、README・約束の文書へ入った差）の本体の変更を読み、文書の該当を引いた。引いた先: ADR 0460・0464（`registerEmbeddingSpace` の lock と索引の競合。postgres README の `RESET lock_timeout` の説明）、ADR 0473（空・逆転した有効期間と claim key。memory-model.md）、ADR 0474（`tagMatch` の数え方。recall.md）、ADR 0476（label の upsert の順。CHANGELOG 側のみで、README・約束の文書に記述なし）、ADR 0483・0487（`TokenCounter`・`usage.counter`。architecture.md・recall.md）、ADR 0485（`findCorrectionCandidates` の `excludeMemoryIds`。README・約束の文書に細部の記述なし）、ADR 0489（`embeddingInput`。openai README の「戻り値が空文字だと 400」と矛盾しない）、ADR 0490（`language-mismatch.ts` の `LATIN` が文字だけを数える。memory-model.md §11 の `meta.languageMismatch` の記述〔かな・漢字 ÷（かな・漢字 + ラテン文字）≧ 0.3、ラテン文字が大半、`{ rule, contentLatinLetters, contentLatinShare }`〕と、定数・返り値の形が一致した）、ADR 0491（`claim-key.ts` の限界。memory-model.md の「1件ずつ届く経路」の記述と矛盾しない）、ADR 0479・0480・0481・0484・0492（Fake・テストのみで、文書の記述を変えない）。**古くなった所は無かった。**

- **直したもの（文書の側だけ）**:
  1. `docs/recall.md` の `score.semanticSimilarity` → `score.similarity`（`ScoreBreakdown` の欄は `similarity`。現物は `packages/core/src/recall.ts` の `ScoreBreakdown`）。（最初の版）
  2. `packages/core/src/strategies/decay.ts` の TSDoc の `floorSeqAt`（実在しない）→ `defaultDecayStrategy.floorAt`（時刻）・`defaultActivityDecayStrategy.floorAt`（活動時計。通し番号）。（最初の版）
  3. `packages/postgres/src/pgvector-capability.ts` の TSDoc の `PostgresVectorStore` 内の `assertPgvectorCapability`（実在しない）→ `vector-store.ts` の `PgvectorCapabilityGate`。（最初の版）
  4. `packages/core/src/recall-runtime.ts` の `RecallRuntimeDeps.tenantSettingsStore` の TSDoc の `createRecallRuntime`（実在しない。この ADR の掃きで見つけた）→ `runRecall`（同じファイルの `export async function runRecall`、`index.ts` から `export *`）。
  5. `packages/core/src/interfaces/memory-store.ts` の `findActiveByClaimKey?` の TSDoc の `claimKeySubject`/`claimKeyPredicate`（実在しない。この ADR の掃きで見つけた）→ `claimKey.subject`/`claimKey.predicate`（列は `claim_key_subject`/`claim_key_predicate`）。
  実装は変えていない（TSDoc のコメントだけ）。

- **コードの側を直すべき食い違い**: 見つからなかった。探した場所は上の 1〜9（約束の文書が正で実装がずれている形は、既定値・署名・export・メッセージの照合のどれにも出なかった）。**ただし 1〜9 は、散文の主張の全数を見ていない**（下の【未確認】）。

- **陽性対照**【実測】（「出なかった」を根拠にする 1〜5 の探り棒が生きていることを、わざとずれを入れて示した。入れたずれは、repo の外のコピーか、走らせたあとに消した一時ファイルで、コミットしていない）:
  - 識別子・`Type.member`・import・パス・リンク・migration のファイル名・長い文言: `runtime.recallX`・`DEFAULT_RECALL_LIMITX`・`RecallQuery.limitX`・`import { createRuntimeX }`・`packages/core/src/nonexistent-file.ts`・`./nope.md`・`9999_x.sql`・存在しない文言を書いた md を、それぞれの照合に通した。**全部を拾った**（`recallX`・`DEFAULT_RECALL_LIMITX`・`limitX`・`createRuntimeX`〔fence 内の語としても、import の `MISSING` としても〕・`RecallQuery.limitX`・パス・リンク・migration・文言）。
  - TSDoc: 一時の `.ts` に `` `floorSeqAt` `` と `{@link noSuchSymbolHere}` のコメントを書いて走らせた。**両方を拾った**（走らせたあと、その一時ファイルを消した）。
  - architecture.md §5 の写し: `getRecall(` を `getRecallX(` に変えて 2 本の歯を走らせると、メンバー名の集合の一致の歯が赤になり、元に戻すと緑に戻った。ただし**この歯が比べる相手は、コミット済みの公開 API の写し（snapshot）**で、`dist` ではない。snapshot が古ければ、この歯はそのずれを見ない。
  - 既定値の手での突き合わせ（8）には、機械の陽性対照が無い。

- **走らせたコマンド**: `pnpm install --frozen-lockfile`・`pnpm run build`・`node scripts/check-doc-snippets.mjs`・`node scripts/generate-adr-index.mjs`・上の 7 の `scripts/__tests__/*.test.mjs` の名指しの vitest。ローカルで全テストは走らせていない。広い検査（`pnpm test` のルート実行・DB の要るテスト・`pnpm run lint`）は走らせていない。CI に任せる。

- **見ていない形**【未確認】:
  - 散文の中の定性的な主張（「〜は〜しない」「〜のとき〜を投げる」）の全数。例外の型と文言は、バッククォートで引いた**文言そのもの**が現物にあるかを機械で引き、README の例外の表（postgres の「例外の見分け方」など）の `err.name` と、メッセージの接頭辞は手で数件引いた。全数ではない。
  - 表・図の中の数値の全数（既定値は上の 8 の範囲）。
  - 実 API・実 Redis・実 Postgres を要する記述（openai の入力の境界、anthropic の `maxTokens` の閾値、bullmq の実測、postgres の実測）。外部 SDK の版・既定の一致だけを見た。
  - `README` の「ほかに export しているもの」の表が、export の全部を網羅しているか（逆向き）。表にある名前が export にあるかは見た（core・postgres。ずれは無し）。載っていない export は多数あるが、この表は「約束は各 TSDoc」と書いて網羅を主張していない。
  - `docs/roadmap.md`・`docs/alteroid-findings.md`・`docs/release-v1.md`・`docs/release-notes-v1.1.0.md`・`docs/north-star-paths.md`・`docs/autonomy.md`・`examples/chat/README.md`。
  - 照合の相手の語が、**コメントを除くため**、コードの中の識別子のコメントだけに在る名前は「実在しない」として出る（上の 1 で出たものを、現物で一つずつ分類した理由）。逆に、**文字列リテラルの語も含めたため**、メッセージの中にだけ在る名前は「実在する」として通る。このため 1 は、実在の下限の検査であって、役割（その名前がその型の欄か）までは見ない。役割は 2・5・7 が一部を見る。

- **検討した代替案**:
  1. **照合スクリプトを `scripts/` に入れて CI の門にする。** 採らなかった。偽陽性（上の 1 で出た、経緯・外部の名前・例の語）の上限を置けず、AGENTS.md「偽陽性率に上限を置けない検査は門にしない」に当たる。出た語を人が分類する前提の「候補の一覧」の道具で、門にはしない。道具として残すかは、オーナー・クローンの判断に残す（残さないなら、この ADR の「照らした形」を手順として読み直せる）。
  2. **既定値を道具で突き合わせる。** 採らなかった。文書の「既定」の書き方が揺れていて（`既定 10`・`既定 DEFAULT_…`・`= 3`）、定数名との対応を機械で作ると、対応表が写しになる（AGENTS.md「数を、道具と生成物に焼き込まない」）。手で引いて、引いた先をこの ADR に書いた。

- **引き受けた負債**:
  - 上の【未確認】の全部。とくに、散文の定性的な主張の全数と、実 API を要する記述。
  - この ADR の「照らした形と結果」は、`main` の `3ba8e4b5` + この枝に対して測った記録であり、`main` が進めば古くなる。再現する人は、同じ形で当て直すこと。

- **これが覆るとしたら**: 上の 1〜3 の「出なかった」が、探り棒の限界（役割を見ない・コメントだけに在る名前を拾う）に由来していて、役割まで見る照合（たとえば、文書の `Type.member` の網羅や、関数の引数・返り値の形の照合）が、現在の一覧に無い食い違いを出したとき。そのときは、この ADR の結果は「当たった範囲の結果」だったことになる。
