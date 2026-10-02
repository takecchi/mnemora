# ADR 0533: 文書とコードのずれを横に掃く（第4弾の1回目）— ADR 0526・0527 の分の文書を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-d9378a02 の指示による）が書いた。文書の側だけを直した（TSDoc 1か所）。コードの側を直すべき食い違いは見つからなかった。

**照合の基準は main `0bdc0e27`。** [ADR 0528](./0528-doc-code-drift-sweep-0496-0500-0522-0523.md) の続きで、0526（`33c070db`）・0527（`0bdc0e27`、#1624）の分を掃く（`git diff 161e403c 0bdc0e27`）。**このあとマージされる 0503・0505・0507・0508・0529・0530・0531・0532 などは、マージされた順に追い足す。**

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**:
  - 0526: 実測と歯だけ（`tick` 経由の `consolidate`・`reflect` ジョブの消した後の参照と、訂正で負けた記憶がある状態での `reextract`。3者一致で、割れは見つからなかった）。差は ADR と 2 つの歯だけ。
  - 0527: `Runtime.consolidate`・`reflect` が積む `created` イベントの `meta.sources` を、呼び出し側が渡した綴りではなく、store が返した行の id（小文字）で書く。ADR 0524 が材料に残した、大文字の `memoryIds` で `meta.sources` に呼び出し側の綴りが残る件の直し。
  - 決まり（前回と同じ）: CHANGELOG の `[1.2.0]` と migration-v1 の v1.2.0 の節（「`v1.2.0` で出す」の節）には触らない。既存の ADR 本文は対象外。

- **探した場所**【現物】:
  - 0527 の語の grep（`README.md`・`docs/*.md`・`packages/*/README.md`・`packages/core/src/*.ts`・`interfaces/*.ts`、`docs/decisions/`・`__tests__` を除く）: `meta.sources`・`meta\.sources`・`` `sources` ``。ヒットは `docs/memory-model.md` §11 の行12・13、`runtime.ts` の `reflect` の手順8と `consolidate`・`reflect` の `sources`（各 id の結末の配列。別物）、`memory-store.ts` の `consolidated` の `sources`（`provenance.sources`）。
  - `docs/memory-model.md` の行12・13・`meta` の表（1141 行目付近、`created` の `meta`）と、`created` の `meta` の説明を読んだ。
  - 0526 の側: `contested_resolved` を `docs/*.md`・`runtime.ts` に grep し、`reextract` の「退けた記憶」（`listWithdrawnAmong`）の TSDoc・`memory-model.md` の記述を ADR 0526 の表と照らした。
  - 差の確認: `git diff 161e403c 0bdc0e27 -- CHANGELOG.md docs/migration-v1.md packages/core/src`（`__tests__` を除く）。
  - 機械照合を、ADR 0528 と同じ文書の集合に再度通した（識別子・パス・リンク・`Type.member`・import・文言・TSDoc の2つの照合）。

- **0527 の突き合わせの結果**【現物】:
  - 実装: `runtime.ts` の `consolidate`・`reflect` の `created` の `meta.sources` が、`eligibleIds` から `eligibleMemories.map((m) => m.id)` に変わった。`eligibleMemories` は `eligibleIds` を同じ順で `byId` から引いた配列なので、順序・件数は変わらず、綴りだけが store の行の id になる。他の口（`forget`・`purge`・`markContested` ほか）が積む `meta` の id は元から小文字の正規形（ADR 0524 の実測）。
  - CHANGELOG `[1.3.0]` の `### Fixed` の項は、0527 自身が足している。内容（`created` の `meta.sources` だけが対象。`provenance.sources`・`superseded` イベントの `memoryId` は元から小文字。小文字で渡したときの値は変わらない。書かれた行は書き換えない）は実装と一致した。`docs/migration-v1.md` に項目は無く、不要（「新しく断る入力」でも「型・挙動の変わる破壊」でもない。0527 決定が migration に載せないと書く）。
  - **`meta.sources` に呼び出し側の綴りが残ると現在形で書いた文書・TSDoc は見つからなかった。** ADR 0524 の材料は、0524 の本文だけに書かれていて、README・docs・TSDoc には書かれていなかった。`memory-model.md` の行12・13（`meta.sources=<統合元の memoryId>`・`<土台の memoryId>`）は、綴りに触れておらず、0527 のあとも成り立つ。
- **直したもの（文書の側だけ）**: `packages/core/src/runtime.ts`（`Runtime.reflect` の手順8）。旧「`meta.sources: <eligible の id>`」→ 新「`meta.sources: <eligible の id。store が返した行の id＝小文字の正規形で、渡された綴りではない（ADR 0527。以前は渡された綴りで、直す前に書かれた行は書き換えない）>`」。根拠: `runtime.ts` の `created` イベントを組む箇所の `eligibleMemories.map((m) => m.id)`。0527 の差は TSDoc を直していなかった（手順8は `eligible の id` と書き、どちらの綴りかを言っていなかった）ので、誤りを直したのではなく、0527 で決まった約束を書き足した。
- **0526 の突き合わせの結果**【現物】: 文書・TSDoc の側に影響する記述は無かった。ADR 0526 が縛った振る舞い（種が非 active のとき `tick` のジョブは完了し何も作らない、近傍が非 active でも完了、`eraseTenant` の後のジョブの結末、LLM の障害で `failed`、訂正で負けた記憶があると `reextract` は抽出し直さず `skipped`）を書いた文書は、`docs/memory-model.md` の行12・13・`reextract` の TSDoc を読む限り、矛盾しなかった。`reextract` の「退けた記憶」が `forgotten`・`contested`・最新の `superseded` イベントの `meta.reason` が `contested_resolved` の `superseded` であることは、`listWithdrawnAmong` と ADR 0526 の表が一致する。
- **コードの側を直すべき食い違い**: 見つからなかった。材料として残す【判断】:
  - ADR 0527 の負債1: 直す前に書かれた `created` の `meta.sources` に、大文字の綴りが残る行がありうる。読む側が `meta.sources` を id として引くときは、大文字小文字を区別せずに突き合わせる必要がある。この注意を、`memory-model.md` の `created` の `meta` の説明にはまだ書いていない（0527 は書き換えない決定で、書き足しも依頼されていない）。書き足すかはクローンの判断。
- **前回との比較**【実測】: 識別子・パス・リンク・`Type.member`・import の照合は、ADR 0528 の最後の出力と、行番号を除いて同じ。TSDoc の2つの照合も同じ。文言の照合は、ADR 0528 の枝（#1622、まだこの枝の元に入っていない）が `docs/architecture.md` に足した1行（`setEventRetention` の int4 の文面）が、この枝には無いので1行少ない。それ以外は同じ。
- **陽性対照**【実測】: 一時の md に存在しない識別子 `eligibleMemoriesX` を書いて識別子の照合に通し、拾った（実在する `listWithdrawnAmong` は拾わなかった）。一時ファイルは削除した。`meta.sources` の綴りの記述の有無は grep の無ヒットで見た（`meta.sources` 自体が `runtime.ts` と `memory-model.md` でヒットすることは確かめた）。0527 の実装・CHANGELOG の突き合わせには機械の陽性対照が無い（手で読んだ）。
- **【未確認】**: 0526・0527 の歯（`fake-sources-lowercase.test.ts`・`consolidate-reflect-sources-lowercase.postgres.test.ts`・0526 の2つの parity の歯）を走らせていない。0527 が `meta.sources` を小文字にするのが、Fake・InMemory でも Postgres と同じ値になること（0527 の歯が縛ると書くが、再実行していない）。直す前に書かれた行が本番のデータに在るか。
- **走らせたコマンド**: `node scripts/generate-adr-index.mjs`、機械照合のスクリプト（repo の外）。ビルド・全テスト・DB の要るテストは走らせていない。

- **引き受けた負債**: この ADR の結果は `main` の `0bdc0e27` に対して測った記録で、`main` が進めば古くなる。照合の道具は repo に入れていない（ADR 0495 の代替案1のとおり）。
- **これが覆るとしたら**: 上の探し方が拾わない種類（散文の中で `created` の `meta` の id の綴りを言い換えた文）の古さが見つかったとき。

## 追い足し（基準 main `afb3bd90`、ADR 0529 の分）

0529（`afb3bd90`）が main に入ったので掃いた（`git diff 0bdc0e27 afb3bd90`）。この枝は `origin/main` を merge した（衝突は `docs/decisions/README.md` の索引だけ。`checkout --theirs` のあと `generate-adr-index.mjs` で作り直した）。0503・0505・0507・0508・0530・0531・0532 などは、まだ追い足していない。

- **0529 の中身**【現物】: 差は ADR 0529 と、2つの歯（`packages/core/src/__tests__/fake-tick-mixed-kinds-concurrency-lease-parity.test.ts`・`packages/postgres/src/__tests__/tick-mixed-kinds-concurrency-lease-parity.postgres.test.ts`）だけ。実装・TSDoc・README・約束の文書・CHANGELOG・migration-v1 は変わっていない（ADR 0529 決定1も、割れは見つからず、CHANGELOG・migration は変えないと書く）。
- **探した場所**【現物】:
  - `git diff 0bdc0e27 afb3bd90`（`CHANGELOG.md`・`docs/migration-v1.md`・README・`docs/*.md` の差は空）。
  - `tick`・リース・再取得を書いた TSDoc を読み、ADR 0529 の結果と照らした: `runtime.ts` の `TickOptions.leaseMs`（0 以下・入口の検査・処理がリースより長いとき・バッチの claim 時点から数えること）、`TickOptions.kinds`（claim の順は種類に関わらず `available_at` の古い順。既定の `kinds` の外は claim されず、名指しで渡すと `unsupported` として `fail`）、`Runtime.tick`、`UNSUPPORTED_KIND_ERROR_PREFIX`、`outbox-store.ts` の `claimBatch`（`claimed_at <= now - leaseMs`、古い順、同じ `available_at` の並びは約束しない）、`docs/architecture.md` §5.2・§5.11。
  - 語の grep: `available_at|availableAt|古い順|同じ \`tick\`|次の \`tick\`|unsupported outbox job kind|claimed_at <=|leaseMs 以上` を `runtime.ts`・`interfaces/outbox-store.ts`・`docs/architecture.md` に、`同じ \`tick\`|次の \`tick\`|後続の` を `runtime.ts`・`architecture.md`・`memory-model.md`・`core/README.md`・ルートの README に。
  - 機械照合を、前回（0526・0527 の分）と同じ文書の集合に再度通した。
- **突き合わせの結果**【現物】: 文書・TSDoc の側で古くなった記述は無かった。ADR 0529 が3者一致と測った振る舞いは、既存の TSDoc の約束と矛盾しない。
  - 種類を混ぜた `tick`: 4種類を1回で処理し、処理中に積まれた後続のジョブ（`extract` が作った記憶の `embed` など）は次の `tick`——`limit` が種類を問わず古い順で、claim は先頭で一括、という `TickOptions.kinds`・`leaseMs`（「バッチの claim 時点から数える」）の記述と一致する。
  - 知らない種類: 既定では claim されず終端にならない・名指しで渡すと `unsupported` で `fail`（`lastError: runtime.tick: unsupported outbox job kind: custom-kind`）は、`TickOptions.kinds`・`Runtime.tick`・`UNSUPPORTED_KIND_ERROR_PREFIX` と一致する。
  - リースが切れた後の再取得: 遅れた `complete`/`fail` が `leaseConflicts` に載る・provider が二重に走る・行は後から完了した側のまま・`claimedAt + leaseMs` ちょうどで再 claim できる（`claimed_at <= now - leaseMs` と一致）は、`TickOptions.leaseMs` の追記（Issue #1200・2026-09-30）と `claimBatch` の記述と一致する。
  - 並行する複数の `tick`: 二重 claim が無い・全件が高々1回（不変条件）は、`claimBatch` の `FOR UPDATE SKIP LOCKED` の記述と矛盾しない。誰が何件取るかは文書が約束していない（ADR 0529 も歯にしていない）。
- **コードの側を直すべき食い違い**: 見つからなかった。
- **前回との比較**【実測】: 機械照合の出力（識別子・パス・リンク・`Type.member`・import・文言・TSDoc の2つの照合）は、前回（0526・0527 の分）と、行番号を除いて同じだった。
- **陽性対照**【実測】: 一時の md に存在しない識別子 `DEFAULT_TICK_LIMITX` を書いて識別子の照合に通し、拾った（実在する `DEFAULT_TICK_LIMIT` は拾わなかった）。一時ファイルは削除した。「文書・TSDoc と 0529 の結果の一致」には機械の陽性対照が無い（手で読んだ）。
- **【未確認】**: 0529 の2つの歯（Fake・InMemory・実 Postgres）を走らせていない。ADR 0529 が書く Postgres の並行の分かれ方（160 回の観測）と、変異試験の結果。0529 が測っていないと書く範囲（`tick` 以外の層の並行）。
- **走らせたコマンド**: `git fetch origin && git merge origin/main`、`git checkout --theirs docs/decisions/README.md`、`node scripts/generate-adr-index.mjs`、機械照合のスクリプト（repo の外）。ビルド・全テスト・DB の要るテストは走らせていない。
