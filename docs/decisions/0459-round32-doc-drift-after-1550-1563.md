# ADR 0459: 穴探し32巡目 — 今日（2026-10-01）マージされた PR（#1550〜#1563）のあとの文書のずれを直す（文書だけ）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。直す線はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。**コードとテストは変えていない（文書だけ）。**

- **文脈**:

  2026-10-01 に #1550〜#1563（ADR 0441〜0451・0453・0456・0457）が main に入った。そのあとで、文書が現物とずれていないかを横に点検した（#1428 の前例: 署名を変えたら `docs/architecture.md` §5 の写しも直す）。
  **#1564（ADR 0454、reextract）と #1565（ADR 0452、testkit の fake と Float32Array）は、この ADR の時点で未着地**なので、その2本に関わる文書は対象から外した（着地したら、同じ PR か続きの PR で当てる）。

- **点検したものと結果**:

  1. **`docs/architecture.md` §5（port の写し）と `packages/core/src/interfaces/*` の署名**: 12の interface（MemoryStore・VectorStore・LexicalStore・RelationStore・LLMProvider・EmbeddingProvider・EventStore・OutboxStore・TenantSettingsStore・Scheduler・TokenCounter・Clock）の、メソッドの集合と各メソッドの宣言（空白・末尾のカンマ・引用符・`| undefined` を除いて比べた）が**すべて一致した**【実測。`.mgr-notes/r32-methods.mjs`。陽性対照: 写しの `abortIfSuperseded` を書き換えると、その行が不一致として出た】。
     今日の PR は `interfaces/*` の署名を変えていない（#1553 は TSDoc だけ）ので、署名のずれは無かった。**ずれていたのは文章のほう**で、次の2点を追記で直した（本文は書き換えていない）。
     - §5.5: 「この interface の適合テストは `packages/testkit` に存在しない」（ADR 0072 の負債1・Issue #116）は、`describeEmbeddingProviderConformance`（ADR 0095）が在る今は成り立たない。LLM 側の `describeLLMProviderConformance`（ADR 0266）も含めて追記した。
     - §5.4・§5.5: abort の記述が ADR 0428・0445 より前のまま（local-embedding は「推論の前後で確認するだけ」、openai・anthropic を直に呼んだときの `signal.reason`・事前 abort の扱いが無い）。正本の `interfaces/*` の 2026-10-01 追記を指す追記を足した。
  2. **README（`packages/core`・`postgres`・`testkit`・`bullmq`）の例と説明**: #1555（close の冪等化・rollback の元のエラー）・#1556（CLI・`migrationsDir`）・#1561（savepoint）・#1562（NUL・H4）・#1553（abort）・#1558（bullmq）は、それぞれの PR が README を直しており、今日の他の PR との食い違いは**見つからなかった**【現物。`closePostgresClient`・`rollbackError`・`migrationsDir`・NUL・abort・savepoint・入れ子の `transaction` を grep して読んだ】。
     ただし1か所、README ではなく `docs/memory-model.md` §11 に残っていたずれを直した: `created` の `meta.droppedFields`（ADR 0443（抽出）・0456（統合・内省）。保存できない補助の欄だけを落とした記録）が、`meta.droppedCandidates` の節の隣に書かれていなかった。`droppedFields` の形（`index`・`contentHash`・`field`・`reason`・`count?`・`tagIndexes?`）を、コード（`llm-aux-fields.ts`・`runtime.ts`）から書き足した。
  3. **CHANGELOG `## [1.2.0] - 未リリース`**: 今日マージされた PR（0:00 以降）を ADR 番号で突き合わせた。コードを変えた PR（#1534〜#1562 の `packages/*/src` を触るもの）は、ADR 0429〜0446・0448・0449・0451・0456 を含めて**すべて載っていた**。
     載っていない ADR 0442・0447・0450・0453・0457 は、**docs だけの PR で、その節の「何を載せるか」の規則（docs のみの PR は載せない）に従って載せない**。#1551 は `packages/core/src` を2ファイル触るが TSDoc だけ。ずれは**無し**。CHANGELOG は変えていない。
  4. **`docs/migration-v1.md`**: 🔴（v1.1.0 → 次の版）には、今日の変更のうち破壊的と数えたもの（項目49〜51。ADR 0436・0437・0439）が既に載っている。**🟡 には v1.1.0 → 次の版の節が無かった**ので、足した（下の決定2）。

- **決めたこと**:

  1. `docs/architecture.md` §5.4・§5.5 に、2026-10-01 付けの追記を足す。`docs/memory-model.md` §11 に `meta.droppedFields` の記述を足す。
  2. **`docs/migration-v1.md` に「🟡 v1.1.0 → 次の版で、挙動が変わるが手順は要らないもの —— 未リリース」の節を足す**。見出しの形・「未リリース」の印は既存の 🔴 の同名の節に揃えた。載せる基準は「利用者が気づく必要があるか」。
     - **載せたもの**: #1555（rollback の失敗が元のエラーに・`begin` の接続の後始末・close）、#1561（savepoint の rollback の失敗が元のエラーに）、#1556（`runMigrations` の `migrationsDir`。CLI のプールの `error` のリスナー）、#1552・#1562（NUL の補助の欄を落とす・読み取りの絞りの NUL を名指しで断る）、#1562 の H4（別テナントを指すイベントを断る）、#1552（バインド上限の崖）、#1554（`applyCorrection` が書く前に落とす）、#1553（local-embedding のチャンクの合間の abort）。
     - **載せなかったもの**（理由は節の末尾にも書いた）: #1550（文書・スクリプトの修正。「TypeScript の `lib` は ES2022 以上」は既存の要件を書いただけ）、#1551（文書だけ）、#1557・#1559・#1560（操作×状態の行列の確認の記録。振る舞いは変えていない）、#1558（bullmq の文書の実測。コードの振る舞いは変えていない）、#1563（README の実測による訂正）、#1564・#1565（未着地）。
     - **この節は、今日の分（#1550〜#1563）だけを載せた**。それより前に `main` へ入った `[1.2.0]` の変更は棚卸ししていない（節に明記した）。
  3. **マネージャーから受け取った例と現物の食い違い（直して載せた）**: 「#1556 の CLI が DB に触れる前に落ちるようになった」は、現物では **`runMigrations`（ライブラリ）に読めない `migrationsDir` を渡したとき**の変更である。CLI は同梱の既定のディレクトリしか使えないので、この変更は CLI の利用者には届かない
     （ADR 0448 決定2。CLI の側の変更は、プールに `error` のリスナーを付けたこと）。出所は #1556 だが、利用者が誰かを直して書いた。「#1562 の H4（別テナントを指すイベントを断ること）」は現物と合っていた（ADR 0456 の H4。直したのは `@mnemora/postgres` だけで、testkit のインメモリ実装は確かめていない。ADR 0456 の M7）。
  4. **CHANGELOG・コード・テスト・conformance suite は変えない。**

- **検討した代替案**:

  1. **🟡 を、過去の世代のように「節を置かず CHANGELOG を指すだけ」にする。** 採らなかった。マネージャーの指示（節を足す）と、今日の変更に「例外の形・場所が変わる」ものが複数あり、🔴 の一覧には載らない（破壊的と数えていない）ので、移行の読者が CHANGELOG の長い節を掘る前に目に入る場所が要る。
  2. **`[1.2.0]` の全部を🟡に棚卸しする。** 採らなかった。今日の分だけで十分に大きく、それ以前は棚卸しを別の機会に回す（節に「まだ棚卸ししていない」と書いた）。
  3. **architecture.md §5 の本文を書き換える。** 採らなかった。この文書は追記で訂正する作法（ADR の「採用済みの本文は書き換えない」と同じ。§5 の既存の追記の形に揃えた）。

- **引き受けた負債**:

  - 🟡 の節は、今日の分以外を棚卸ししていない。#1564・#1565 の分も未着地のため載っていない。
  - architecture.md の §5 の他の節（5.1 の savepoint など）の散文の契約文が、今日の変更で古くなっていないかは、署名の一致の確認の外で、grep（`savepoint`・`rollback`・`createMemoriesWithOutboxAndEvents`）に当たった範囲でしか見ていない。
  - README の読みは、PR が直した箇所を grep で当たった範囲である。READMEs 全体を頭から読み直してはいない。

- **これが覆るとしたら**:

  - 🟡 を番号付きの一覧にする（🔴 と同じく件数を数える）とオーナーが決めたとき。
  - CHANGELOG の「何を載せるか」が、docs のみの PR を載せる方針に変わったとき（ADR 0442・0447・0450・0453・0457 を載せる）。

- **測っていないこと**: `@mnemora/testkit` のインメモリ実装が、H4 の入力（別テナントを指すイベント）を断るか。#1564・#1565 の着地後の文書。

## 追記（2026-10-01、#1564・#1565 の着地後）: 除いていた2本を、同じ PR で当てた

上の本文は、#1564（ADR 0454、reextract）と #1565（ADR 0452、testkit の fake・カセットと Float32Array）が未着地の時点の記録である。2本とも main に入ったので、origin/main を取り込み（衝突なし。索引は生成器で「最新」と確認）、1〜4 を同じように点検して当てた。

- **1. architecture.md §5**: #1565 は testkit の公開の署名（`RecordingEmbeddingProvider`・`RecordingLLMProvider`・`SeededEmbeddingProvider`・`SeededLLMProvider` の `opts?: AbortOptions`）を足したが、`docs/`・README・`examples/chat/README.md` に、これらのクラスの**署名の写しは無かった**【現物。クラス名を grep】。`interfaces/*` の署名も #1564・#1565 は変えていない。
  ずれていたのは §5.5・`docs/recall.md` の文章で、`recall()` が型付き配列のクエリ埋め込みを受けるようになったこと（ADR 0452 決定8）が書かれていなかった。追記で足した（§5.5 の 2026-10-01 追記の (3)、recall.md の 2026-10-01 追記）。
- **2. README**: `packages/testkit/README.md` の「ほかに export しているもの」が、新しく断る入力（壊れたカセット・違う空間／モデルの記録・delegate の壊れた戻り・Seeded の `delegate.space` との照合）を書いていなかったので足した。core・postgres の README には、reextract・Float32Array・testkit の fake に関わる記述が無く、ずれは無かった。
  reextract（ADR 0454）は、#1564 自身が `docs/memory-model.md` と TSDoc を直しており、`docs/architecture.md` の reextract の記述（§3.4・§5.1 の写し）は置き換えた側の選び方に触れていないので、ずれは無かった。
- **3. CHANGELOG `[1.2.0]`**: #1564（ADR 0454）・#1565（ADR 0452）とも載っていた。**漏れなし、変更なし。**
- **4. migration-v1 の 🟡**: 次を足した。
  - 載せたもの: reextract の置き換えた側が active になる行になる（#1564）、冪等な再送の戻り値に3欄が付く（#1564 決定4。再送を `contestedDetection === undefined` で見分けていた呼び出し側に影響）、recall が型付き配列を受ける（#1565）、testkit の fake・カセットが新しく断る入力（空間・モデルの混在、壊れたカセット、`text` と鍵の不一致、不正な `dimensions`（`0` を含む）、delegate の壊れた戻り、Seeded の delegate 空間の食い違い）と、振る舞いの変更（opts の転送・並列の memo・参照の非共有）。
    **testkit のこれらは🟡に載せ、🔴 には数えない**（「公開の fixture が新しく例外を投げる変更は破壊的と数えない」。オーナーの回答（ask_human `3f3411c5`）。`@mnemora/testkit` の provider の fake・カセットはその「fixture」の延長と読んだ【判断】）。
  - 載せなかったもの: #1564 の残り（行列の記録・`Runtime.observe` の TSDoc の訂正。文書だけ）は、節の末尾の一覧に理由つきで書いた。
  - 節の末尾の「着地したら足す」の項目は片付けた。
- **doc-reference の言い回し**: 前回、未着地の ADR 0454 への参照が赤になるので「reextract・testkit の fake と Float32Array」と書いた箇所は、#1564・#1565 の項目に置き換わったので、ADR 0452・0454 を指す形（実在する）になっている。
- **確かめたこと**: `Float32Array` を返す provider で、ingest（`processEmbedJob` → `toVectorLiteral`）から recall まで、main の上で通した【実測】（手元の確認。コミットしていない）。
