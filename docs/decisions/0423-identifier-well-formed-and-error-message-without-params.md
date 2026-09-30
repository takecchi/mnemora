# ADR 0423: 識別子の文字の扱いを揃え、区別できない値を入口で断る。利用者へ伝わる例外の message から入力値を落とす

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローン miku の委譲先が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  **(1) 識別子の文字の扱いが、実装によって違っていた。** `tenantId`・`subjectId`・`observe` の `externalId` は、
  正規化せず完全一致で比べる約束である（`packages/core/src/ctx.ts`）。ところが、次の2種類の文字を含む値の扱いは、
  実装ごとに違った。

  - **孤立サロゲート**（対をなさない UTF-16 のサロゲートコードユニット）。`@mnemora/postgres` は `text` 列に値を入れるとき、
    node-postgres が JS の文字列を UTF-8 へ変換し、孤立サロゲートを U+FFFD に置き換える。つまり、保存された形は
    「入力そのもの」ではなく、**入力が違っても保存の形が同じになりうる**（保存の形で区別できない）。
    `@mnemora/testkit` のインメモリ実装は JS の文字列のまま持つので区別する。**同じ入力で、2つの実装の結果が食い違っていた。**
  - **NUL**（U+0000）。Postgres の `text` 列は保存できず、DB の生の例外（`invalid byte sequence`）になる。
    インメモリ実装は、欄によっては通っていた。

  すでに [Issue #1075](https://github.com/takecchi/mnemora/issues/1075) で実測されており、`MemoryStore` の doc コメントは
  「現状を記録するだけで、どれに揃えるか——正規化・拒否・このまま——は決めていない」と書いて止まっていた。

  **(2) 利用者へ伝わる例外の message に、入力値が入っていた。** drizzle の `DrizzleQueryError` の message は
  `Failed query: <SQL>\nparams: <値>` で、`params` には SQL に渡した値（本文を含む）がそのまま入る。`observe`・`recall` は
  store の例外をそのまま利用者へ伝える。outbox の `last_error`（[ADR 0363](./0363-outbox-last-error-omit-params-and-cap-length.md)、
  [Issue #1064](https://github.com/takecchi/mnemora/issues/1064)）と、outcome の `error`（#1511）は、すでに `params` を落としていた。
  例外そのものの message だけが残っていた。

- **決めたこと**:

  1. **識別子に孤立サロゲートか NUL が含まれていたら、入口で明示の例外（`MalformedIdentifierError`）で断る。書き換えて通すことはしない。**
     対をなすサロゲート（絵文字など）は正しい文字であり、断らない。
  2. **例外の型は `MalformedIdentifierError`（`kind: "malformed_identifier"`）。** [ADR 0418](./0418-store-error-kind-guards.md) の作法に合わせ、
     判定は `instanceof` ではなく `isMalformedIdentifierError`（`kind`、無ければ `name`）で行う。欄 `field`（断った欄の名前）・
     `reason`（`"lone_surrogate"` か `"nul"`）・`index`（位置）を持つ。**message に入力値は入れない。**
  3. **判定は core に1つ置き、公開する**（`packages/core/src/identifier.ts`）。`MalformedIdentifierError`・`isMalformedIdentifierError`・
     `assertWellFormedIdentifier`・`assertWellFormedCtx`・`assertWellFormedFilter`・`findMalformedIdentifierPart`・型 `MalformedIdentifierReason`。
     公開する理由は、store の実装（`@mnemora/postgres`・`@mnemora/testkit`）が別の package であり、同じ判定を共有する必要があるため
     （公開 API の門は [ADR 0178](./0178-public-api-surface-gate.md)。snapshot を更新した）。自前の adapter も同じ関数を使える。
  4. **断る場所は2つ。** (a) `createRuntime` が返す `Runtime` の全メソッドの入口（第1引数の `Ctx` の `tenantId`・`subjectId`、
     `observe` の入力の `subjectId`・`externalId`）。(b) store の実装——Postgres とインメモリの、`ctx` を取る全メソッドの入口
     （`ctx.tenantId`・`ctx.subjectId`）と、識別子を入力に持つ口（`createObservation`・`createObservationWithOutbox` の `subjectId`・`externalId`、
     `createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の `subjectId`、`createRecall` の `subjectId`、
     `aggregateScope` の `scope.subjectId`、`findActiveByClaimKey`・`findContestedByClaimKey`・`listActiveClaimPredicates` の `query.subjectId`、
     `VectorStore`・`LexicalStore` の `search`/`searchMany` の `filter.tenantId`・`filter.subjectId`）。
     **どちらも書き込みより前に断る**（何も書かない）。
  5. **対象にしないもの。** 本文（`text`・`content`・`payload`・`attributes` の値・`digest`）。本文の孤立サロゲートを U+FFFD に置き換える今の扱い
     （`text` 列）と、`jsonb` 列が断る今の扱いは、**変えていない**。`subjectCandidates` も対象にしない（呼び出し側が渡す候補の一覧で、
     識別子として完全一致で比べる値としては扱っていない。ただし、LLM が選んだ候補は Memory の `subjectId` として store に渡るので、
     そのとき (b) で断られる）。`tags` の要素・`claimKey` の主語と述語・ラベル名も今回は対象にしていない（下の「引き受けた負債」）。
  6. **利用者へ伝わる例外の message から、`params:` より後ろを落とす。** ADR 0363 と同じ作法で、SQL の文は残し、`params` の値だけを落とし、
     「落としたことが読める印」（`(omitted by mnemora, N chars)`）を残す。`Runtime` の全メソッドが、store などが投げた例外をこの処理に通してから投げ直す。
     **例外は新しく作らず、その場で `message`（と、それを含む `stack`）を書き換える。** `kind`・`name`・`cause`・独自の欄は、そのまま残る。
     `cause` の連鎖にも同じ処理を掛ける。`params:` の目印が無い例外は何も変わらない。整形の関数は #1511 で切り出した
     `failure-description.ts` の `omitDrizzleParams` を使う（出力の形が outbox と揃う）。

- **検討した代替案**:

  1. **識別子を正規化する（孤立サロゲートを U+FFFD に置き換えてから比べる、NUL を除く）。** 採らなかった。`ctx.ts` は「正規化せず完全一致で比べる」と約束しており、
     正規化は、呼び出し側が渡した値と保存される値を食い違わせる（読み返しても同じ値にならない）。また、正規化後の値が別の識別子と同じになる
     ——区別できない値を「区別できる」と見せる——問題を、別の形で残す。
  2. **文書に「使わないこと」と書くだけにする。** 採らなかった。現状がそもそも「doc に実態を書いて止まっている」状態であり（Issue #1075）、
     呼び出し側が識別子に外部の入力（ユーザー名など）をそのまま渡す経路では、注意に頼る方針は失敗する（`AGENTS.md` の「機械には検出まで」の考え方と同じ向き）。
  3. **Postgres の実装だけで断る。** 採らなかった。インメモリ実装（testkit の fixture）は、利用者がテストで本番の代わりに使うので、
     2つの実装で結果が食い違うと、テストが本番を保証しなくなる。適合テスト（conformance）も、両方に同じ `it` を課す形にした。
  4. **zod の `CtxSchema` に判定を足し、そこで検査する。** 採らなかった。`Runtime` も同梱の store も、この schema で `ctx` を検査していない
     （`ctx.ts` の doc）。schema を通る経路を新しく作るより、入口の関数を共有するほうが、抜けが少ない。
  5. **本文にも同じ検査を掛ける。** 採らなかった。本文は識別子と違い、完全一致で比べる値ではなく、置き換えの影響は「読み返した値が少し違う」に留まる。
     今の扱いを変えると、通る入力が大きく減る。
  6. **例外を包み直す（新しい `Error` を作って `cause` に元の例外を入れる）。** 採らなかった。`kind`・独自の欄と、利用者が既に書いている分岐
     （`isMemoryStatusConflictError` など）が壊れうる。元の例外の `message` を書き換えるほうが、見える形の変化が小さい。
     `cause` に元の例外を残す形は、`cause` 経由で `params:` 入りの message が残るので、結局 `cause` にも処理が要る。
  7. **`Runtime` ではなく store の各メソッドで message を落とす。** 採らなかった。drizzle が例外を組み立てる場所は `@mnemora/postgres` の内側の至る所
    （40を超えるメソッド）にあり、抜けやすい。利用者が受け取る入口（`Runtime` の全メソッド）に1箇所で掛けるほうが、抜けが無い。

- **引き受けた負債**:

  - **通っていた入力が通らなくなる（破壊的変更）。** 孤立サロゲートか NUL を含む識別子は、これまで Postgres では U+FFFD に置き換わって通り、
    インメモリ実装では通っていた。conformance に `it` を足したので、自前の store 実装は新しく落ちうる（`docs/migration-v1.md` の項目41）。
  - **断った例外は、既に保存されてしまった行を直さない。** 過去に U+FFFD へ置き換わって保存された識別子は、そのまま残る（検査しない・書き換えない）。
  - **`tags` の要素・`claimKey` の主語と述語・ラベル名は対象にしていない。** `ctx.ts` は、これらも完全一致で比べると書いている。
    今回は `tenantId`・`externalId`・`subjectId` を優先し、ほかの欄は、値の出どころ（LLM の出力を含む）と影響を分けて判断するため、決めていない。
    **オーナーに判断を仰ぐ点として残す。**
  - **`Runtime` を通らずに store を直接呼ぶ呼び出しは、(b) で識別子だけ断られるが、message の `params` は落とさない。**
    `Failed query:` の message は、store が投げたまま。
  - **`DrizzleQueryError` の `params` プロパティ（値の配列そのもの）と、`cause` の pg エラーの `message`・`detail` は変えていない。**
    前者は `kind` や `cause` と同じく例外のプロパティで、利用者が調べるために読みうる。後者は pg が組み立てた文面
    （`invalid input syntax for type …: "<値>"` のように、値が載る経路がある。ADR 0363「塞がらない経路」と同じ）。
    `util.inspect` や `console.log(error)` は、これらのプロパティを表示しうる。
  - **`stack` の書き換えは、message と同じ文字列が先頭にある前提。** 形が違う `stack`（別の JS ランタイムなど）は、message だけが書き換わる。
  - `Runtime` のメソッドは、入口の関門を通すため、公開のメソッドが新しい関数に包まれる（`Runtime` の型・メソッドの集合は変わらない）。
    メソッドを足したとき、関門は自動で掛かる（メソッドの列挙から作っている）。ただし、**新しいメソッドが識別子を第1引数以外に取る場合は**、
    `guardRuntimeEntry` に検査を足すこと。機械では縛っていない。

- **これが覆るとしたら**:

  - 識別子の正規化を採る判断（オーナー）が出たら、(a)(b) の検査を正規化に置き換える。判定の関数は、正規化の前段としても使える。
  - Postgres が孤立サロゲートを区別して保存できる（たとえば `bytea` 列に切り替える）設計に進むなら、孤立サロゲートの拒否は外せる。NUL は `text` 列では残る。
  - 例外の包み直しが必要になる（`params` を落としきれない経路が見つかる）なら、`cause` の扱いも含めて見直す。

- **測ったこと**（【実測】2026-09-30、手元の Postgres 17。UTF8（`--locale=C.UTF-8`）と SQL_ASCII（`--locale=C`）の2つ）:

  - 歯を先に置き、Postgres（2脚）・testkit のインメモリ・core の runtime で赤になることを確かめた（PR の最初の commit）。
    赤の理由は「reject しなかった」「`kind` が `malformed_identifier` でない（DB の生の例外）」の2種類で、意図した差である。
  - 実装後、同じ歯が緑になった。対をなすサロゲート（絵文字）を含む識別子が、受け付けられ、そのまま読み返せる陽性対照も置いた。
  - 本文に孤立サロゲートを入れた `observe` の例外（`jsonb` 列が断る経路。本物の drizzle の例外）で、message と `stack` から本文が消え、
    SQL の文・`cause` の SQLSTATE（`22P02`）が残ることを見た。
  - **測っていないこと**: 本物の2版の core が並ぶ環境での動作。`stack` の形が違うランタイム。`tags`・claim key・ラベル名に対する同じ検査の影響。
    本番規模のデータで、過去に U+FFFD へ置き換わって保存された識別子の有無。
