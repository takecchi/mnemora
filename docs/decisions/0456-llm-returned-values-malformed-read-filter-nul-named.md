# ADR 0456: LLM が返した値の保存できない形（NUL・孤立サロゲート）で observe・consolidate・reflect が落ちないようにする・読み取りの絞りの NUL を名指しの例外で断る（穴探し29巡目、前例の横展開）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-3a4ae979）の委譲先が書いた。直し方はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。材料に回したものは「材料」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  29巡目は「前例の横展開」。ADR 0434〜0450 で直した穴の形（テナントの修飾漏れ、補助の欄の NUL、begin の後始末、大文字の id、バインド上限、書き込みの前に検査しない、など）を、repo の別の場所に当て直した。この ADR は **src を直す側**（S2 の穴 H4・S3・S4・S5・S10・S12・S13・S14）の記録である。src を変えない側（S1・S6・S7・S8・S9・S11 の確認、S2 のうち H4 以外の口の確認、文書の実測 S15）は ADR 0457（別の PR。この PR の時点では未着地） に残す。
  避けた面: 27巡目の embed ジョブ・reinforce、24巡目の testkit・savepoint（陽性対照でも触っていない）。`packages/testkit` には1行も手を入れていない。

  手元の PostgreSQL 17（UTF8、`C.UTF-8`）と、`@mnemora/core` の Fake に、使い捨ての探り棒（vitest 1ファイル。commit していない）を当てた。**探り棒には毎回、通るはずの入力の陽性対照を先に置いた**（下の表）。

  | 形（前例）                                | 当てた場所                                                                                                                                                                           | 結果                                                                                                                                                                 |
  | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | S3 補助の欄の NUL（0434・0443）           | LLM が返す値を保存する経路すべて。Postgres の各口に NUL を渡す表（約40口）                                                                                                           | **穴あり（下の H1・H2・H3）**                                                                                                                                        |
  | S5 識別子の検査（0423・0437）             | LLM が返す `subjectId`。store の `subjectId` を取る口                                                                                                                                | **穴あり（H1）**。store の `subjectId`・`subjectIds` を取る口は、`memory-store.ts` の15箇所と `tenant-settings-store.ts` の2箇所で検査済みで、抜けは見つからなかった |
  | S10 書き込みの前に検査しない（0446）      | `resolveOrphanedContested`（全行）、`consolidate`・`reflect`（手順5〜6）、`reextract`（`throw` と `await` の位置の走査）                                                             | 穴なし。検査は書き込みの前にあった（読みだけ。実測はしていない）                                                                                                     |
  | S12 日付の範囲（0440・0434）              | `RecallQuery` の `Date`、Postgres の各口の `Date`                                                                                                                                    | 材料（M2）                                                                                                                                                           |
  | S13 索引の上限（0435）                    | 抽出が返す tag（`createMemoryWithOutbox`）                                                                                                                                           | 既知の限界のまま（0443 が決めた）。材料（M3）                                                                                                                        |
  | S4 例外に params（0423・0437）            | 公開の `extractCandidates`・`deriveClaimKeys`                                                                                                                                        | 穴ではない（下の「穴ではなかったもの」）                                                                                                                             |
  | S14 abort（0445）                         | `runtime.ts` の `tick` のジョブのループ                                                                                                                                              | `throw abortReason(signal)` が合間にある。穴なし（読みだけ）                                                                                                         |
  | S2 別テナントを指す書き込み（0436・0439） | `MemoryStore` の書き込み口のうち、`NewMemoryEvent` を受けるもの（`memory_events` への INSERT 11箇所のうち、呼び出し側の `event.memoryId` を使う6口と、群・作成のイベントの一括挿入） | **穴あり（H4）**                                                                                                                                                     |

- **見つけた穴と、決めたこと**:

  1. **H1: LLM が返した `subjectId` が NUL・孤立サロゲートを含むと、`observe`（同期の抽出）が例外で終わる。**
     【現物】`ExtractedMemoryCandidateSchema.subjectId` は `z.string().min(1)` だけで、`sanitizeCandidateSubjectId`（`extraction.ts`）は `subjectCandidates` を渡さない経路では何も見ない。保存の口（`createMemoryWithOutbox`）は ADR 0423 の `assertWellFormedIdentifier` で拒む。
     【実測】（Postgres 17、`@mnemora/postgres` の全 store を配線した Runtime、LLM は `subjectId: "al\u0000ice"`／`"al\ud800ice"` を返す）直す前は `MalformedIdentifierError` で `observe` が reject。observation は残り（1行）、記憶は0件のまま、extract の job だけが増えた。陽性対照: `subjectId: "alice"`（記憶に入る）と、`subjectCandidates: ["alice"]` を渡した同じ入力（一覧に無いので弾かれて通る）は、直す前から通る。
     **直し**: `sanitizeCandidateSubjectId` が、識別子として保存できない値（`findMalformedIdentifierPart` が非 null）を、一覧の有無に関わらず `{ subjectId: undefined, rejected: true }` で返す。`undefined` は「LLM が省略した」と同じ着地点で、記憶は observation の `subjectId` で作られる（一覧に無い id を弾く既存の動きと同じ）。`reextract`・deferred の `tick` も同じ関数を通る。`rejectedSubjectIds` は、一覧を渡したときだけ載る既存の約束のまま（一覧が無い呼び出しでは載らない。doc に書いた）。
     **線**: 前例のある同種の穴（ADR 0443 が抽出の補助の欄に、ADR 0271・0304 が `subjectId` の弾き方にしたこと）。**今は例外で終わる入力が、記憶を作って通るようになる。通っていた入力は、1つも新しく断らない。** 対をなすサロゲート（絵文字）は弾かない（歯で縛った）。

  2. **H2: 統合・内省の LLM が返した `digest`・`tags` が NUL を含むと、`consolidate`・`reflect` が例外で終わる。**
     【現物】ADR 0443 は抽出（`observe`・`reextract`）の補助の欄だけを直した。統合（`ConsolidationLLMResultSchema`）・内省（`ReflectionLLMResultSchema`）も `digest`・`tags` を LLM から受け、同じ保存の口に書く。
     【実測】（Postgres 17）直す前は4通り（統合・内省 × digest・tags）すべて `DrizzleQueryError`（原因は `invalid byte sequence for encoding "UTF8": 0x00`）で reject。統合元・材料は `active` のまま（トランザクションごと戻る）。陽性対照: NUL の無い同じ形の入力は統合・内省とも通る。
     **直し**: `llm-aux-fields.ts` の `sanitizeCandidateAuxFields` を、`digest`・`tags` を持つ値なら受けられる形（ジェネリクス）にして、`consolidate`・`reflect` の LLM 応答の直後（本文の空白検査の後）で通す。`digest` の NUL は無いことにして `resolveDigest` のフォールバックへ、`tags` は NUL の要素だけ捨てる。**落とした欄は、統合先・内省の記憶の `created` イベントの `meta.droppedFields` に残す**（抽出と同じ形・同じ欄名。落とさなければ `meta` の形は変わらない）。本文（`content`）の NUL は直さない（本文は落とせない。従来どおり例外）。
     **線**: 前例のある同種の穴（0443）。**例外で終わる入力が通るようになるだけで、断る入力は増えない。**

  3. **H3: 読み取りの絞りの NUL が、DB の生の例外（`Failed query: …`）で落ちる。**
     【実測】直す前、`labels` の NUL は `invalid byte sequence for encoding "UTF8": 0x00`、`attributes` の key・value の NUL は `unsupported Unicode escape sequence`、claim key・`extractorVersion` の NUL は `0x00` の `DrizzleQueryError` で落ちた。陽性対照: NUL の無い同じ形の入力は通る。`RecallQuery.attributes` の key は文字種の正規表現が弾くが、**value は `z.string().max(256)` で NUL を弾かない**。`RecallQuery.labels` も弾かない。したがって `runtime.recall` から実際にここへ届く（Runtime が `params` は落とすが、名指しの文面にはならない）。
     **直し**: ADR 0424 O-6-1（検索語の NUL）と同じ作法で、DB に触れる前に `<口>: <欄> must not contain NUL characters (U+0000)` の `Error` を投げる。対象: `PostgresMemoryStore.aggregateScope`（`scope.labels[i]`・`scope.attributes (key|value)`）、`findActiveByClaimKey`・`findContestedByClaimKey`（`claimKey.subject`・`claimKey.predicate`）、`listBySourceObservation`（`extractorVersion`。`observationId` が uuid の形でないときは今までどおり DB に行かず `[]` を返すので、その後で検査する）、`PostgresLexicalStore`・`PostgresTrigramLexicalStore`・`PostgresVectorStore` の `search`（と `searchMany`）の `opts.filter.labels[i]`・`opts.filter.attributes (key|value)`。検査は `input-check.ts` の `assertNoNulInScopeFilter` と、既存の `assertNoNul`。
     **線**: 前例のある同種の穴（0424）。**断る入力は増やしていない**（以前も同じ入力で例外）。`@mnemora/testkit` のインメモリ実装は、この口の多くを既に同じ文面（`<口>: <欄> must not contain NUL characters (U+0000)`）で拒む（ADR 0434）ので、例外の形はむしろ揃う。ただし、欄の名前の付け方（`opts.filter.attributes (value)` など）まで揃えたかは確かめていない（testkit を触らない約束のため。下の M5）。

  4. **H4: `NewMemoryEvent.memoryId` が別テナントの記憶でも、イベントが書ける。**
     【現物】ADR 0436 は `EventStore.append`、ADR 0439 は `MemoryStore` の書き込み口が受ける参照 id（`supersededById`・`contestedWithId`・`sourceObservationId`・`recordUsage` の id）を検査した。しかし、`MemoryStore` の口が**引数として受け取る `NewMemoryEvent` の `memoryId`** は、どちらの表にも載っていない。`updateStatusWithEvent`・`supersedeWithNewMemories`（`supersede[i].event`）・`purgeMemory`・`markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested` は、`event.memoryId` をそのまま `memory_events` へ書く。群の口（`markContestedGroup`・`resolveContestedGroup`）は `insertMemoryEventsBatch` で、作成のイベント（`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の `buildCreatedEvent`）は `insertCreatedEventRow` で、同じことをする。`memory_events.memory_id` の外部キーは `tenant_id` を含まない。
     【実測】（Postgres 17）A の `ctx` で B の記憶 id を `event.memoryId` に入れた呼び出しは、直す前は6口すべてが成功し、B の記憶に `tenant_id = 'ev-a'` の `memory_events` が積まれた（B の記憶に6件、1口につき1件）。uuid の形でない `event.memoryId` は生の `DrizzleQueryError`。陽性対照: 自分の id を指すイベントは通る（直す前から）。B の記憶を指す A のイベントの行は、外部キーが `tenant_id` を含まないので、B の側の後始末（purge・erase）を止めうる形でもある（ADR 0438 の C1 と同じ形。この ADR では止まることまでは実測していない）。
     **直し**: ADR 0436・0439 と同じ作法で、イベントを書く前に、同じトランザクションの中で、`event.memoryId` が `ctx` のテナントの記憶であることを確かめる（`assertEventTargetInTenant`、`memory-store.ts`）。実在しない・別テナントは区別せず `PostgresMemoryStore: memory not found for tenant: <id>`。投げればトランザクションごと戻るので、status の更新も残らない（「status の更新とイベントは同値」の不変条件）。呼び出しが今更新・作成した行の id と同じなら問い合わせない（余計な往復を増やさない。比較は大文字小文字を無視）。群の一括挿入は、更新した行の id 以外を指すイベントだけを、1文で確かめる。`null`・`undefined`（記憶を指さないイベント）は確かめない。
     **線**: 前例のある同種の穴（0436・0439）。**断る入力は、別テナントの記憶を指すイベントだけ**（正規の呼び出し——`Runtime` は常に自分の行を指す——は1つも断らない）。uuid の形でない `event.memoryId` は、以前は生の DB 例外で落ちていたので、断る入力は増えない。同じテナントの別の記憶を指すイベント（`id` と `event.memoryId` が食い違う）は、境界の穴ではないので断らない（M6）。

- **穴ではなかったもの**（探した場所つき）:

  - **S4 の `extractCandidates`・`deriveClaimKeys`**: どちらも LLM の例外を捕まえて `failure` に丸める。【実測】偽の LLM が `Failed query: SELECT 1\nparams: SECRETBODY` を投げると、`failure.message` に `params:` 以降が**そのまま残る**。ただし、これは LLM の provider（`@mnemora/openai`・`@mnemora/anthropic`）が DB のクエリを持たないからこそ起きない形で、実在する経路ではない（DB を内側に持つ自作の `LLMProvider` だけが当たる）。直していない。材料ではなく、**当たった範囲での結果であり、断定ではない**。
  - **S5 の `Runtime` の入口**: ADR 0423 の関門（`guardRuntimeEntry`）は `ctx`・`observe` の `subjectId`・`externalId` だけを見る。`recall` の `query.subjectId` は store の口（`assertWellFormedFilter`）が見るので、孤立サロゲートは `MalformedIdentifierError` になる（実測していない。読みだけ）。

- **材料（オーナーの領分。直していない）**:

  - **M1: 本文・tags・claim key・ラベル名の孤立サロゲートは、断られず、U+FFFD に置き換わって保存される。**【実測】`createMemory` に `content: "cab\ud800cd"`・`tags: ["ab\ud800cd"]`・`claimKey: { subject: "ab\ud800cd" }`、`registerLabel("ab\ud800cd")` を渡すと、すべて例外にならず、読み戻した値は `"cab�cd"` などになり、元の文字列と等しくない（`equal? false`）。別の孤立サロゲートの2つの tag が同じ値に潰れうる。ADR 0423 が「本文は検査しない」「`tags`・claim key・ラベル名は今回は対象にしない」と決めた範囲のまま。**これを断る（`MalformedIdentifierError` 相当）と、今は通っている入力が新しく例外になる**——値の例: LLM が返した tag `"絵\ud83d"`（絵文字の前半だけが切れたもの）。直していない。
  - **M2: 日付の範囲外（紀元前4713年より前）が、Postgres で `timestamp out of range` の生の例外になる。**【実測】store 直接で、`validAt`・`occurredAfter`・`validFrom`・`recordedAt` に `new Date(Date.UTC(-5000, 0, 1))` を渡すと `DrizzleQueryError`（`timestamp out of range: "5001-01-01T00:00:00.000+00:00 BC"`）。10000年・JS の最大の `Date`（`8.64e15`）・1年は通る。`Invalid Date` は、`Runtime.recall` では zod が `ZodError` で弾く（Fake で実測。`Runtime.recall` を Postgres で通した実測はしていない）。purge の口は、範囲外の `olderThan` を「その前の行は無い」として扱う（`PG_TIMESTAMPTZ_MIN_MS`）。**検索の絞りの日付も同じ扱いにする（0件を返す）のは、今は例外で終わる入力を成功にする——結果が「黙って成功」に変わる**ので、直さず材料にした。型付きの例外に包む案は、公開の例外クラスを増やす（公開 API の snapshot が変わる）ため、これも材料にした。
  - **M3: 圧縮が効かない長い tag は、観察ごと例外で終わる。**【実測】LLM が返した tag が、ランダムな CJK 1000字（約3000バイト）で、`observe`（同期）が `DrizzleQueryError`（GIN 索引 `idx_memories_tags` と、`labels (tenant_id, name)` の一意制約の索引の上限）で reject。`"a".repeat(20000)` のような圧縮が効く値は通る。ADR 0443 決定1・doc が「字数では線を引かない・断る入力を増やさない」と決めた既知の限界のまま。字数の上限を入口に置くのはオーナーの領分。
  - **M4: 書き込みの口の NUL（`event.append` の `digestSnapshot`・`meta`・`actor.id`、`createMemory` の `digest`・`tags`・`attributes`・`extractorVersion`・claim key、`createObservation` の `payload`、`createRecall` の `query`）は、`@mnemora/postgres` が生の `DrizzleQueryError` で落とす**（【実測】）。Runtime 経由では `params` が落ちる。名指しの文面に直すのは message だけの変更だが、`createMemoriesWithOutboxAndEvents` の候補ごとの SAVEPOINT が例外の文面を使って落とした候補を説明している（ADR 0443・`describeDroppedCandidate`）ので、24巡目の面（savepoint）に触れる。**この ADR では触れていない。**
  - **M5: インメモリ（testkit）と Postgres で、例外の形がずれる件**: 読み取りの絞りの NUL は、Postgres がこの ADR で名指しの `Error` になり、インメモリは既に名指しの `Error` だった。欄の名前の付け方（`opts.filter.attributes (value)`・`scope.labels[1]` など）が両者で同じかは確かめていない。`describe*Conformance` に足すのはオーナーの領分で、testkit は触らない約束なので、触っていない。

  - **M6: `id` と `event.memoryId` が食い違う呼び出し（同じテナントの別の記憶を指すイベント）は、断っていない。**【実測】`updateStatusWithEvent(A, w2, "archived", {}, ev(w3))` は成功し、`w3` に `memory_events` が1件積まれる（`w2` の status が変わったのに、イベントは `w3` のもの）。境界の穴ではないが、「status の更新と対応するイベントは同値」の約束（`updateStatusWithEvent` の doc）には反する。`Runtime` は常に一致させる。断ると新しい種類の入力を断ることになる（オーナーの領分）ので、直していない。
  - **M7: インメモリ（testkit）が `event.memoryId` の別テナントを断るかは、確かめていない**（testkit に触れない約束。H4 の歯は `@mnemora/postgres` だけに置いた）。

- **決めたこと（まとめ）**:
  1. `sanitizeCandidateSubjectId` が、NUL・孤立サロゲートを含む `subjectId` を、一覧の有無に関わらず弾く（H1）。
  2. `consolidate`・`reflect` が、LLM の `digest`・`tags` の NUL を、抽出と同じやり方で落とし、`created` の `meta.droppedFields` に残す（H2）。
  3. `@mnemora/postgres` の読み取りの口（上のH3の一覧）が、`labels`・`attributes`・claim key・`extractorVersion` の NUL を、DB に触れる前に名指しで断る（H3）。
  4. `MemoryStore` の書き込み口が受ける `NewMemoryEvent` の `memoryId` が、`ctx` のテナントの記憶であることを、書く前に確かめる（H4）。
  5. **公開 API の型・シグネチャは変わらない。** `sanitizeCandidateSubjectId` は `@mnemora/core` から出ている関数で、型は同じ。振る舞いの変化は、「保存できない値を返す LLM の応答」だけに効く。DB のマイグレーションは無い。

- **歯と、赤→緑の実測**（【実測】2026-10-01。コマンドは `packages/core`・`packages/postgres` で `pnpm exec vitest run <ファイル>`、`DATABASE_URL` は手元の Postgres 17）:

  | 歯                                                                                                  | 直す前（直した src を `HEAD` の版に戻して実行）                                                                          | 直した後 |
  | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
  | `packages/core/src/__tests__/llm-malformed-aux-values.test.ts`（9本）                               | 7本が赤（H1 の純関数3本と Runtime 2本、H2 の統合・内省2本）。陽性対照の2本は緑                                           | 9本緑    |
  | `packages/postgres/src/__tests__/llm-malformed-aux-values.postgres.test.ts`（6本。実 DB）           | 4本が赤（`observe` の NUL・孤立サロゲート、`consolidate`、`reflect`）。陽性対照の2本は緑                                 | 6本緑    |
  | `packages/postgres/src/__tests__/read-scope-filter-nul.postgres.test.ts`（6本。実 DB）              | 6本が赤。各 `it` の先頭で NUL を含まない同じ形の入力が通ることは見ている                                                 | 6本緑    |
  | `packages/postgres/src/__tests__/event-target-belongs-to-ctx-tenant.postgres.test.ts`（7本。実 DB） | 7本すべてが赤（B の記憶へのイベントが積まれる・status が戻らない）。各 `it` の陽性対照（自分の id を指すイベント）は通る | 7本緑    |

  赤の確認は、修正した src ファイルを `git show HEAD:<path>` の版に置き換え、`pnpm --filter @mnemora/core run build` し直してから `postgres` の歯を走らせ、直した版に戻して同じ歯が緑に戻ることまで見た。

- **検討した代替案**:
  1. **H1 を、抽出の候補ごと落とす**。採らなかった。本文が正しいのに記憶を失う（ADR 0443 が直した形そのもの）。`subjectId` を弾く既存の動き（一覧に無い id）と同じ着地点にした。
  2. **H1 を、Runtime の入口で LLM の応答を検査する**。採らなかった。`extractCandidates` は公開の関数で、`reextract`・deferred の `tick` も通る。1つの関数に置くほうが、通り道を数え漏らさない。
  3. **H3 を、zod（`RecallQuery`・`AttributesSchema`）の側で NUL を弾く**。採らなかった。`ObserveInput` の `attributes` の値も弾くことになり、今は（Fake・インメモリでは）通る入力を新しく断る側に寄る（オーナーの領分）。今回は、Postgres がもともと落とす入力の文面だけを直した。
  4. **M1〜M4 を直す**。上のとおり、オーナーの領分か、24巡目の面に触れる。

- **引き受けた負債**:
  - H1 の弾いた `subjectId` は、一覧を渡していない呼び出しでは `ObserveResult` のどこにも載らない（`rejectedSubjectIds` は一覧を渡したときだけ載る既存の約束）。「黙って戻した」記録が残らない。
  - H2 の `droppedFields` の `index` は常に `0`、`contentHash` は統合先・内省の本文のハッシュである（候補が1件なので）。
  - H3 は読み取りの口だけで、書き込みの口（M4）は生の例外のまま。
  - 探り棒の表は約40口の NUL と、`Date` 5種の範囲で、網羅ではない。見落としうる（ADR 0140 のとおり、列挙は網羅を示さない）。

- **これが覆るとしたら**:
  - オーナーが「LLM が保存できない `subjectId` を返したら、observe は例外で終わるべき（黙って observation の `subjectId` を使わない）」と決めたとき。H1 を戻す。
  - オーナーが `tags`・claim key・本文の孤立サロゲートを断る（M1）と決めたとき。H1・H2 の「落とす」は、「断る」と並べて決め直すことになる。
  - 読み取りの絞りの NUL を zod の入口で弾く（代替案3）と決めたとき。H3 の検査は、その手前で重なるだけで害は無い。
