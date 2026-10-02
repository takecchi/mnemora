# ADR 0520: 文書とコードのずれを横に掃く（続き）— ADR 0486・0488 の分の文書を、今の main の型と実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-d9378a02 の指示による）が書いた。文書の側だけを直した。コードの側を直すべき食い違いは見つからなかった。

**照合の基準は main `cd2c2b63`。** [ADR 0495](./0495-doc-code-drift-sweep.md)（基準 `3ba8e4b5`、PR #1602）の続きで、そのあとに main に入った ADR 0486（#1593）と ADR 0488（#1599）の分だけを掃く。ADR 0493・0494 の面（#1603・#1601）は main に入ってから追い足す。ADR 0495 が直した所（#1602 は main に未マージ）は、この掃きでも「まだ直っていない」として出る（下の「出たが対象外」）。それはこの ADR では直さない（#1602 と衝突させないため）。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: `git diff 3ba8e4b5 cd2c2b63` の本体の変更は、ADR 0486（testkit の `InMemoryMemoryStore` が `payload` を Postgres と同じ規則で保存する。`ExtractionContextSchema` の TSDoc に `text` の `max(2000)` の単位を書く）と ADR 0488（`FakeRelationStore`・`InMemoryRelationStore` の kind 検査・`createdAt` の複製・偽の `kind` の扱い）。この振る舞いを書いている文書・TSDoc に古い所が無いかを見た。対象外: `docs/migration-v1.md`・CHANGELOG・既存の `docs/decisions/*`・`docs/north-star.md`。

- **探した場所**【現物】:
  - 振る舞いの語を引いた: `DataCloneError`・`structuredClone`・`toJSON`・コードポイント・コード単位・`max(2000)`・`FakeRelationStore`・`InMemoryRelationStore`・`unknown relation kind`・`listRelated`・`payload`・`extractionContext` を、`docs/*.md`（decisions・CHANGELOG・migration-v1 を除く）・各 `packages/*/README.md`・`packages/*/src`・`scripts` から。出た所を読んだ。
  - 文書: `packages/core`・`testkit`・`postgres`・`bullmq`・`openai`・`anthropic`・`local-embedding` の各 README、`docs/recall.md`・`memory-model.md`・`architecture.md`（§5 の `RelationStore` の写しを含む）・`conformance.md`・`vision.md`。
  - TSDoc（全体の照合）: 前回と同じ形（`packages/*/src` の `__tests__`・`__fixtures__`・`bench`・`*.test.ts` を除く `.ts`）に加えて、0486・0488 の差で触れたファイル（`observation.ts`・`__fixtures__/in-memory-memory-store.ts`・`__fixtures__/in-memory-relation-store.ts`・`__tests__/runtime-fakes.ts`）と `interfaces/relation-store.ts` を、`__fixtures__`・`__tests__` も含めて照らした。

- **照らした形と結果**【実測】（スクリプトは ADR 0495 のものを repo の外で使い、コミットしていない。引数で作業ツリーを渡した）:
  1. 識別子の実在・`Type.member`・import の名前・パス・リンク・migration のファイル名・長い文言: 上の文書の全部に当てた。出たものは ADR 0495 の一覧と同じ種類（外部の名前・例・経緯の文）で、**新しく出たのは `docs/recall.md` の `score.semanticSimilarity` 1件だけ**（ADR 0495 が直したもの。#1602 が main に入るまで残る）。0486・0488 の差に由来する出力は無かった。
  2. TSDoc の識別子（触れたファイルを含む）: 出た語は `ObserveXxxInputSchema`（プレースホルダ）・`Panama`（`Intl` の解決結果の例）・`DataCloneError`（「それ以前は断っていた」と書く経緯）・`subjectID`（綴り違いの例）・`countByGroup`（「置き換えた」と書く経緯）・`cosine_similarity`（式の説明）だけだった。**実在しない名前を現在のものとして書いた所は無かった。**
  3. README のコード片: `node scripts/check-doc-snippets.mjs` は、印の付いた片をすべて検査して落ちた片は0件だった。
  4. 既存の歯: `scripts/__tests__/` の `architecture-section5-port-interface-correspondence`・`architecture-section5-port-signature-correspondence`・`runtime-method-doc-correspondence`・`readme-postgres-objects`・`doc-reference`・`conformance-it-count-formula` を名指しで走らせた。通った。
  5. 0486・0488 の差を、文書の側の記述に手で当てた【現物】: `ObserveEventInput.data` の TSDoc の表（関数・`Symbol`・`toJSON` の2行と、その下の歯・ADR の注記）は、`toStorablePayload` の実装（`toJSON(欄の名前)`・`Date` は呼ばない・配列の要素は `null`・プレーンでないオブジェクトは `structuredClone` に任せる）と一致した。`ExtractionContextSchema` の TSDoc の単位の記述は、ADR 0486 の実測の表と一致した（実装の `z.string().min(1).max(2000)` も同じ）。`docs/architecture.md` §5 の `RelationStore`（`listRelated`・`listRelatedMany?` の署名、実装する class の列挙）は 0488 の差で変わっておらず、一致した。

- **直したもの（文書の側だけ）**:
  1. `docs/memory-model.md`（`### observations` 節の「⚠ 2026-09-27 追記（Issue #1076）: `payload` は JSON として保存される」の段落）: 「`@mnemora/testkit` の fixture は JS の値をそのまま保持する」→ 関数・`Symbol`・`toJSON` を持つ値は ADR 0486 から Postgres と同じ規則で変える旨を括弧で足した。根拠: `in-memory-memory-store.ts` の `toStorablePayload`、`observation.ts` の `data` の TSDoc の表。0486 の前は断っていたので、段落が言う「そのまま保持」の範囲が狭まった（段落は 2026-09-27 の記録なので、書き換えず括弧で追記した）。
  2. `packages/core/src/interfaces/relation-store.ts` の `listRelated` の TSDoc: 「`kind` を省略すると、すべての `kind` を対象にする」の下に、型の外の偽の値（`""`・`null`・`0`）が実行時に渡ったときも、3実装（Postgres・InMemory・core の Fake）とも絞り込まずに全件を返す、と足した。省略として約束する形ではなく、ADR 0488 で揃えた今の振る舞いであることも書いた。根拠: ADR 0488 決定4、各実装の `!kind` の分岐（`in-memory-relation-store.ts` の `relatedOf`、`runtime-fakes.ts` の `FakeRelationStore.listRelated`）。【判断】この追記は新しい約束ではなく現状の記述。残すかはクローンの判断に任せる。
  実装は変えていない（TSDoc のコメントと md だけ）。

- **ADR 0486・0488 の本体の変更で、文書が古くなっていなかったもの**【現物】: `ObserveEventInput.data` の TSDoc の表（0486 の PR が直した）、`ExtractionContextSchema` の TSDoc の単位（同）、`relation-store.ts` の `link` の `unknown relation kind` と `createdAt` の複製の記述（0488 の前から約束として在り、Fake がそれに揃った側）、`docs/architecture.md` §5。`docs/memory-model.md` の `MemoryEvent` の `actor`・`meta` の「fixture は `DataCloneError`」の追補（1095 行）は、`observe` の `data` ではなく `MemoryEvent` の欄の話で、0486 の差は触れていない（`event.ts` の TSDoc の表も同じ）。

- **コードの側を直すべき食い違い**: 見つからなかった。探した場所は上の 1〜5。

- **出たが対象外**: `docs/recall.md` の `score.semanticSimilarity`、`recall-runtime.ts` の `createRecallRuntime`、`memory-store.ts` の `claimKeySubject`/`claimKeyPredicate` は、ADR 0495 が直した所で、#1602 が main に入るまで残る。decisions・CHANGELOG・migration-v1 は対象外。

- **陽性対照**【実測】（わざとずれを入れて、照合が拾うことを見た。入れたずれは走らせたあとに消し、コミットしていない）:
  - 識別子・`Type.member`・import・パス・リンク・migration・長い文言: 一時の md に `runtime.recallX`・`DEFAULT_RECALL_LIMITX`・`RecallQuery.limitX`・`import { createRuntimeX }`・存在しないパス・`./nope.md`・`9999_x.sql`・存在しない文言を書いて、それぞれの照合に通した。全部を拾った（`recallX`・`DEFAULT_RECALL_LIMITX`・`limitX`・`createRuntimeX`〔fence の語としても import の `MISSING` としても〕・`RecallQuery.limitX`・パス・リンク・migration・文言）。
  - TSDoc（触れたファイル向けに範囲を絞った探り棒）: `in-memory-relation-store.ts` の 0488 のコメントに `` `PostgresRelationStoreX` ``・`` `toStorablePayloadX` ``・`{@link noSuchSym}` を書いて走らせ、3つとも拾った（走らせたあと、`cp` で元に戻した）。
  - 既定値の手での突き合わせには、機械の陽性対照が無い。この掃きでは既定値の変更が差に無いので、再照合していない。

- **走らせたコマンド**: `pnpm install --frozen-lockfile`・`pnpm run build`・`node scripts/check-doc-snippets.mjs`・`node scripts/generate-adr-index.mjs`・上の 4 の `scripts/__tests__/*.test.mjs` の名指しの vitest。全テスト・DB の要るテスト・`pnpm run lint` は走らせていない。CI に任せる。

- **見ていない形**【未確認】:
  - ADR 0493・0494（#1603・#1601）の面。main に入ってから追い足す。
  - 散文の定性的な主張の全数、表・図の数値の全数（ADR 0495 と同じ。今回は差に絡む所だけ手で引いた）。
  - ADR 0486 の【未確認】（クラスのインスタンスや `Map`・`Set` の中の関数が、Postgres と fixture で違うか）は、この掃きでも確かめていない。文書にこの形の記述は無い。
  - 0486・0488 の差に含まれるテスト（`*.test.ts`）の中の文言は、文書ではないので見ていない。
  - ADR 0495 が見ていない文書（roadmap・alteroid-findings・release-v1・autonomy・examples/chat/README ほか）は、今回も見ていない。

- **引き受けた負債**: この ADR の結果は `main` の `cd2c2b63` に対して測った記録で、`main` が進めば古くなる。照合の道具は ADR 0495 と同じく repo に入れていない（偽陽性の上限を置けず、門にしない理由は ADR 0495 の代替案1のとおり）。

- **これが覆るとしたら**: 0486・0488 の差に絡む記述で、上の探し方が拾わない種類（散文の中で fixture の挙動を言い換えた文）の古さが見つかったとき。
