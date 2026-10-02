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

## 追い足し（基準 main `1fde1b30`、ADR 0507 の分）

0507（#1620）が main に入ったので掃いた（`git diff afb3bd90 1fde1b30`）。この枝は `origin/main` を merge した（衝突なし）。0503・0505・0508・0530・0531・0532 などは、まだ追い足していない。

- **0507 の中身**【現物】: `created` の `meta.languageMismatch`（言語の事後検査）の、観測側の数え（本文の合成と、かな・漢字・ラテン文字の数）を、候補ごとから観測ごとに1回へ畳んだ（perf）。`language-mismatch.ts` に `profileObservationLanguage`・`detectLanguageMismatchFromProfile` を足し、`detectLanguageMismatch` は両者の合成にした。`runtime.ts` の `observationLanguageProfileOf` が `Observation` のオブジェクトを鍵にした `WeakMap` で畳む。観測のかな・漢字が下限に満たないときはラテン文字を数えない（結果は同じ）。判定の結果・`rule`・印の形・閾値は変えていない。
- **探した場所**【現物】:
  - 語の grep: `languageMismatch|detectLanguageMismatch|language-mismatch` を `README.md`・`docs/*.md`・`packages/*/README.md`・`packages/core/src/*.ts`・`interfaces/*.ts`（`docs/decisions/`・`__tests__`・`CHANGELOG`・`migration-v1` を除く）に。`33万字|62 ms|約6秒|数え直` を同じ範囲に。ヒットは `docs/memory-model.md` の行2の `created` の `meta.languageMismatch` の説明と、`language-mismatch.ts`・`runtime.ts` の TSDoc・コメントだけだった（「数え直し」の他のヒットは、別の話の「散文で数え直さない」の類）。
  - 読んだ所: `docs/memory-model.md`（§11 の行2の `meta.languageMismatch`）、`language-mismatch.ts` の冒頭の TSDoc（閾値の根拠・コード片と URL の扱い）、`runtime.ts` の `buildCreatedEventFor` とその直前のコメント。
  - 差の確認: `git diff afb3bd90 1fde1b30 -- CHANGELOG.md packages/core/src`。CHANGELOG `[1.3.0]`（`### Changed` の項）は 0507 自身が足している。`docs/migration-v1.md` に項目は無い。
  - 機械照合を、前回（0529 の追い足しのあと）と同じ文書の集合に再度通した。
- **突き合わせの結果**【現物】:
  - `memory-model.md` の説明は、判定の条件（観測のかな・漢字が4字以上で、かな・漢字 ÷（かな・漢字 + ラテン文字）が 0.3 以上、本文にかな・漢字が無くラテン文字が大半）、値の形（`{ rule: 'cjk_observation_latin_content', contentLatinLetters, contentLatinShare }`）、検査する経路（sync・deferred・`reextract`。全文フォールバックと行12・13は付かない）を書く。0507 はこのどれも変えておらず、数え方（観測ごとか候補ごとか）を書いた記述はもともと無い。**観測ごと・候補ごとに数えると書いた古い記述は見つからなかった。**
  - CHANGELOG の項（判定の結果・`rule`・印の形・公開 API は変えない。100 候補で約 4.9 秒 → 約 0.06 秒の手元の1回の実測。門にしていない）は、ADR 0507 の【実測】（4.7〜5.0 秒 → 54〜73 ms）の範囲に入る。実装と矛盾しない。
  - `language-mismatch.ts` の新しい TSDoc（観測ごとに1回数えて使い回す・数えるのは観測の本文だけで候補には依らない・`detectLanguageMismatchFromProfile` は結果が同じ）は、実装と一致した。`runtime.ts` の `observationLanguageProfileOf` のコメント（同じ抽出の候補は同じ `Observation` のオブジェクトを渡す・弱参照）は、ADR 0507 決定3の【現物】と同じ。
- **直したもの**: なし（文書の側に古い記述が無かった）。
- **材料として残す【判断】**（直していない）:
  - `language-mismatch.ts` の `profileObservationLanguage` の TSDoc に「33万字で数十 ms」という測った値が書かれている。実測の記録としての注記だが、`main` の実装や半減期の変更で動く値で、AGENTS.md の「数を、道具と生成物に焼き込まない」の線に近い（コードのコメントは対象の道具・生成物ではないので、規律の外とも読める）。直すかはクローンの判断。
  - ADR 0507 の負債: `WeakMap` は「同じ観測なら同じオブジェクトが渡る」ことに頼る（別のオブジェクトが渡れば畳みが効かないだけで、結果は正しい）。文書には書かれていない。
- **コードの側を直すべき食い違い**: 見つからなかった。
- **前回との比較**【実測】: 機械照合の出力（識別子・パス・リンク・`Type.member`・import・文言・TSDoc の2つの照合）は、前回と、行番号を除いて同じだった。
- **陽性対照**【実測】: 一時の md に存在しない識別子 `profileObservationLanguageX` を書いて識別子の照合に通し、拾った（実在する `profileObservationLanguage` は拾わなかった）。一時ファイルは削除した。「数え方を書いた古い記述が無い」ことは grep の形（`languageMismatch` 系のヒットが上の範囲だけ）で見た。実装と文書の突き合わせには機械の陽性対照が無い（手で読んだ）。
- **【未確認】**: 0507 の歯（`language-mismatch-count-once.test.ts`）を走らせていない。CHANGELOG の実測値（約 4.9 秒 → 約 0.06 秒）を測り直していない。`Observation` が呼び出しの途中で書き換わる経路が無いこと（ADR 0507 も全経路の確認はしていないと書く）。
- **走らせたコマンド**: `git fetch origin && git merge origin/main`、`node scripts/generate-adr-index.mjs`、機械照合のスクリプト（repo の外）。ビルド・全テスト・DB の要るテストは走らせていない。

## 追い足し（基準 main `f3e44794`、ADR 0503 の分）

0503（#1621）が main に入ったので掃いた（`git diff 1fde1b30 f3e44794`）。この枝は `origin/main` を merge した（衝突なし）。0505・0508・0530・0531・0532 などは、まだ追い足していない。

- **0503 の中身**【現物】: `MemoryStore` の `resolveContestedPair?`・`resolveContestedGroup?`・`updateStatus`・`updateStatusWithEvent` が、置き換えた側（`supersededById`）の約束を壊す入力を、書く前に `RangeError` で断る（`@mnemora/postgres` の `assertSupersededByShape`・`assertNoSupersededCycle` と、testkit の InMemory）。断るのは、(1) `status: "superseded"` に `supersededById` が無い、(2) 自己置換、(3) `resolveContested*` で `active` に `supersededById` を付ける、(4) 同じ呼び出しのメンバーの中の循環（2者は互いを指す、群は輪になる）、(5) `resolveContestedGroup` で群の外の `forgotten` な記憶を指す。`updateStatus*` は (1)(2) だけ（`active` などに `supersededById` を付けても断らない）。CHANGELOG `[1.3.0]` の `### Breaking` と migration-v1 の項目59は 0503 自身が足している。
- **探した場所**【現物】:
  - 語の grep: `supersededById|superseded_by_id` に `省略|無く|通る|黙|断|検査` を重ねたもの（`docs/memory-model.md`・`docs/architecture.md`・README・`packages/*/README.md`）。`packages/core/src/interfaces/memory-store.ts` の `supersededById` を全部読んだ。
  - 読んだ所: `MemoryStore.updateStatus`・`updateStatusWithEvent`・`resolveContestedPair?`・`resolveContestedGroup?` の TSDoc、`docs/memory-model.md` の「⚠ 2026-09-26 追記（Issue #854）」と、その ADR 0439 の追記、`docs/architecture.md` §5 の port の写し。
  - 差の確認: `git diff 1fde1b30 f3e44794 -- CHANGELOG.md docs/migration-v1.md packages/core/src/interfaces/memory-store.ts packages/postgres/src/memory-store.ts packages/testkit/src`。
  - `docs/migration-v1.md` の 🔴 の番号の並び（54・55・56・57・58・59）と、項目57〜59の「中身は CHANGELOG の…を見ること」の指す節。
  - 機械照合を、前回と同じ文書の集合に再度通した。CHANGELOG・migration-v1 は、0503 の項の行に識別子・文言の照合を当てた。
- **突き合わせの結果**【現物】:
  - 実装の条件・例外の型・message・断る位置は、TSDoc と CHANGELOG と一致した。型は素の `RangeError`、message は `<口>: <欄>.supersededById is required when status is "superseded"`・`… must not be the memory itself`・`… must not be set unless status is "superseded"`（`resolveContested*` だけ）・`<口>: supersededById must not form a cycle among the members`・`resolveContestedGroup: members[<i>].supersededById must not be a forgotten memory outside the group`。値は message に入らない。断る位置は、status の検査（ADR 0499）のあと・id の存在確認より前（(5) だけはテナントの照合のあと）。`updateStatus*` は `contested` の検査のあと、対象の存在確認・テナント照合・`expectedStatus` の判定より前。
  - 「断らないもの」（勝者を指す `superseded`・`both_active`・群の外の `active` を指す `superseded`・`updateStatus*` で別の記憶を指す `superseded`・`superseded` 以外で `supersededById` 無し）も、実装の `forbidWhenNotSuperseded` と一致した。
  - migration-v1 の 🔴 の番号は 54〜59 と続き、飛び・重複は無い。
  - `docs/architecture.md` §5 の port の写しに、`supersededById` の検査を書いた所は無かった（型の写しだけ）。
- **直したもの（文書の側だけ）**:
  1. `docs/migration-v1.md` の項目57・58・59（「🔴 破壊的変更（v1.2.0 → 次の版）」。未リリースの節）の「何が変わったか」: 「[CHANGELOG.md] の `[1.2.0]` 節 `### Breaking` を見ること」→ `[1.3.0]` 節。0499・0502・0503 の項は #1619 で CHANGELOG の `[1.3.0]` の `### Breaking` へ移ったが、migration の指す先が `[1.2.0]` のままで、そこには該当の箇条が無い（棚卸しで `[1.2.0]` が `d49c46c` までに区切られた）。項目54〜56（v1.2.0 の節）は `[1.2.0]` を指していて正しいので触っていない。
  2. `docs/memory-model.md`（「⚠ 2026-09-26 追記（Issue #854）」のあとの ADR 0439 の追記）: 「アプリ側の唯一の検査（`isContestedWithoutCompanion`）は…」と書いた #854 の節が、ADR 0503 からさらに成り立たなくなったので、追記に ADR 0503 の一文を足した（`supersededById` の約束を壊す入力の5つを `RangeError` で断る）。#854 の本文は当時の記録として書き換えていない。
  3. CHANGELOG `[1.2.0]`・migration-v1 の v1.2.0 の節には触っていない。
- **コードの側を直すべき食い違い**: 見つからなかった。材料として残す【判断】: (a) 0503 は conformance suite に `it` を足していない（約束を足すのはオーナーの判断、と CHANGELOG・migration が書く）ので、自前の `MemoryStore` 実装には検査が付いてこない（migration に「必要なら自前で足す」と書いてある）。(b) migration 項目59の「DB マイグレーション」の欄に、直す前に書かれた `superseded_by_id` が NULL の行（戻せない敗者）や自己参照の行を調べる SQL を載せていない（【未】必要なら足す、と 0503 自身が書く）。
- **前回との比較**【実測】: 機械照合の出力（識別子・パス・リンク・`Type.member`・import・文言・TSDoc の2つの照合）は、前回（0507 の追い足しのあと）と、行番号を除いて同じだった。migration の項目59の行の識別子の照合は、何も出さなかった。
- **陽性対照**【実測】: 一時の md に存在しない識別子 `assertSupersededByShapeX` を書いて識別子の照合に通し、拾った（実在する `assertSupersededByShape` は拾わなかった）。一時ファイルは削除した。migration の指す節のずれは、CHANGELOG の見出し（`## [1.3.0]` の下の `### Breaking` に 0499・0502・0503 の3項がある）と、migration の項の位置を数えて見つけた。message・条件の突き合わせには機械の陽性対照が無い（手で読んだ）。
- **【未確認】**: 0503 の歯（`in-memory-superseded-by-checks.test.ts`・`store-superseded-by-checks.postgres.test.ts` と、既存の歯の直し）を走らせていない。(5) 群の外の `forgotten` な記憶の判定が、本物の Postgres で同じ message になること。0503 が足さなかった conformance の `it`。
- **走らせたコマンド**: `git fetch origin && git merge origin/main`、`node scripts/generate-adr-index.mjs`、機械照合のスクリプト（repo の外）。ビルド・全テスト・DB の要るテストは走らせていない。
