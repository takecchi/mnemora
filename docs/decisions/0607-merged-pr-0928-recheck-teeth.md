# ADR 0607: 09/28 にマージされた #1337・#1324・#1327・#1379 の確かめ直しで見つかった穴を塞ぐ（null を許す枝の見分け・forget が store へ渡す id・normalizeUuidCase の範囲・綴りだけが違う tenant・イベントの孤立サロゲートの境目）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャー（mgr-955ee40f）が書いた。歯を書くと決めたのはクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0606](./0606-merged-pr-1002-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯【実測】

2026-09-28 から 29 にかけてマージされた #1337・#1324・#1327・#1379 を、main `9f783201` で確かめ直した。約束ごとに足りない側とやりすぎた側の変異を入れて確かめ直したところ、次の変異がどの歯にも捕まらなかった、という指示をクローンから受けた（出自はクローンの判断で、オーナーの判断ではない）。この PR の担い手は、新しい歯を足す前の既存の歯だけに全部の変異を当て直してはいない（確かめたのは、`admitsNull` を常に `true` にする変異が既存の `structured-nullable-roundtrip.test.ts` で緑のままだったことだけ）。「すり抜けた」は指示の文言どおりで、この PR の【実測】は新しい歯が赤くなることである。

| PR | 約束 | すり抜けた変異・欠けていた入力 |
| --- | --- | --- |
| #1337（`packages/openai/src/llm-provider.ts` の `admitsNull`・`resolveRef`） | `completeStructured` の戻りで、元のスキーマが `null` を許す位置の `null` は残す | `#/$defs/...` の `$ref` を辿らなくする／`const: null` の枝を見なくする／`enum` に `null` を含む枝を見なくする。既存の歯は `type` に `"null"` を含む形（`z.string().nullable()` の直書き）だけで、`$ref` の先・`type` を持たない `const`・`enum` の形が無かった |
| #1324（`packages/core/src/runtime.ts` の `memoryLookupKeyFor`） | 突き合わせだけ小文字にする。store へ渡す id は変えない | `forget` が `getMany` へ小文字にした id を渡す。既存の歯は `forget` の結果（状態・イベント）だけを見ており、`getMany` が受け取った引数を見ていなかった（Fake の `getMany` は大文字を受けるので、小文字にしても結果が同じ） |
| #1327・#1324（`packages/postgres/src/mapping.ts` の `normalizeUuidCase`） | uuid の形の id だけ小文字にし、形の合わない id はそのまま返す | 何でも小文字にする。`uuid` の形の判定の `$` を外す。形の合わない id を渡す単体の歯が無く、DB 越しの歯は uuid の形の id しか渡していなかった |
| #1327 | 大文字と小文字だけが違う2つの tenant は別の tenant で、互いに見えない | `tenant_id` の比較を `lower()` どうしにする（Postgres）／`toLowerCase()` どうしにする（InMemory）。綴りだけが違う tenant の歯が testkit にも postgres にも無かった |
| #1379（`packages/testkit/src/__fixtures__/memory-event-check.ts` の `hasNulOrLoneSurrogate`） | `reason`・`actor.id` の NUL・孤立サロゲートを断る。ほかの制御文字（SOH）は通す | 末尾の孤立した上位サロゲートを見逃す／孤立した下位サロゲートの上端 U+DFFF を見逃す／SOH まで断る。testkit 側にこの関数を縛る歯が無く、Postgres の `event-meta-roundtrip.postgres.test.ts` は途中のサロゲート・NUL を見ていた |

## 決定【判断】

1. 実装は変えない。適合テストにも足さない（公開の約束を増やすのはオーナーの領分。歯は core・openai・postgres・testkit の `__tests__` に置く）。「testkit の適合テストにも足す」という依頼の文言は、適合テストそのもの（`*-conformance.ts`）ではなく、testkit の `__tests__` で InMemory 実装に当てる歯と読んだ【判断】。
2. 歯を足す（試験だけ。新しいファイルだけ）。
   - **#1337**（`packages/openai/src/__tests__/structured-null-schema-branches.test.ts`）: `#/$defs/...` の先が nullable の必須の欄・`type` を外した `const: null`（`z.literal(null).meta({ type: undefined })`）・`z.literal(["x", null])` の `enum` の欄で `null` が残る。対照として、先が nullable でない欄・`enum` に `null` が無い欄の `null` は `ZodError`、省略可の欄の `null` は省略になる。`const` は `z.literal(null)` がもともと `type: "null"` を持つので、`type` を外した形でないと変異が見えない。
   - **#1324**（`packages/core/src/__tests__/forget-store-id-passthrough.test.ts`）: Fake の `getMany` を `vi.spyOn` で記録し、`forget` が渡す id が、大文字にした実在の id と綴りの混ざった存在しない id のまま（配列1本・1件指定の両方）。結果の `memoryId` も渡された綴りのまま。
   - **#1327・#1324**（`packages/postgres/src/__tests__/mapping-normalize-uuid-case.test.ts`、DB に繋がない純関数の歯）: 大文字・混在の uuid は小文字になる。小文字はそのまま。形の合わない10通り（`Not-A-UUID`・1字足りない・1字多い・16進でない字・前後の空白・前に1字付く・空文字など、大文字を含むもの）は小文字にせずそのまま返る。
   - **#1327**（`packages/testkit/src/__tests__/in-memory-tenant-case-distinct.test.ts` と `packages/postgres/src/__tests__/tenant-case-distinct.postgres.test.ts`）: `"Tenant-A"` と `"tenant-a"` にそれぞれ記憶を作り、`get`・`getMany`・`getObservation`・`aggregateScope`・`listLabels`・`eraseTenant` が綴りの違う側を見ず・消さない。自分の綴りの側は見える対照つき。
   - **#1379**（`packages/testkit/src/__tests__/in-memory-event-lone-surrogate-boundaries.test.ts`）: `meta.reason`・`meta.note`・`actor.id` のそれぞれで、`"abc\uD800"`・`"abc\uDBFF"`・`"a\uD800b"`・`"abc\uDC00"`・`"\uDFFF"`・`"a\uDFFFb"`・逆順の対・NUL を断り、SOH（`\u0001`）・U+D7FF・U+E000・正しいサロゲートペア（下端・上端・末尾）を通す。`InMemoryEventStore.append` でも、断るときは何も書かず、SOH は書く。サロゲートはソースに `\u` の表記で書いた（`od -c` と `grep -P` で、生のサロゲート・生の SOH のバイトが無いことを確かめた）。

## 変異試験【実測】

実装ファイルを `cp` で退避し（`/tmp/mgr-955ee40f-bak/`）、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。Postgres は PostgreSQL 17（`--encoding=UTF8 --locale=C.UTF-8`、自分専用のポート）。

| 約束 | 変異（側） | 結果 |
| --- | --- | --- |
| #1337 | `resolveRef` が `$defs` を辿らず `undefined` を返す（足りない） | 赤 1本（`$defs` の先が nullable） |
| #1337 | `admitsNull` の `const: null` の判定を `false` にする（足りない） | 赤 1本（`const: null` の必須の欄） |
| #1337 | `admitsNull` の `enum` に `null` を含む判定を `false` にする（足りない） | 赤 1本（`enum` の必須の欄） |
| #1337 | `enum` があれば・`const` があれば `null` を許すとみなす（やりすぎ） | 緑のまま（同値の変異。残した `null` は、元のスキーマが許さなければ `req.schema` の検査で落ちるので、結果が変わらない） |
| #1337 | `admitsNull` が常に `true`（やりすぎ） | 緑のまま（同じ理由。新しい歯と既存の `structured-nullable-roundtrip.test.ts` の両方で確かめた） |
| #1324 | `forget` が `getMany` へ `toLowerCase()` した id を渡す（足りない） | 赤 2本 |
| #1324 | `forget` が `getMany` へ `toUpperCase()` した id を渡す（やりすぎ） | 赤 1本（綴りの混ざった id の歯） |
| #1327・#1324 | `normalizeUuidCase` が何でも小文字にする（やりすぎ） | 赤 9本（形の合わない9通り） |
| #1327・#1324 | `normalizeUuidCase` が何も小文字にしない（足りない） | 赤 2本（大文字・混在の uuid） |
| #1327・#1324 | `UUID_PATTERN` の `$` を外す（やりすぎ） | 赤 2本（1字多い・末尾の空白） |
| #1327 | InMemory: `get` の tenant 比較を `toLowerCase()` どうしにする | 赤 1本 |
| #1327 | InMemory: `getMany`・`getObservation`・`listLabels`・`aggregateScope`・`eraseTenant`（`drainMap`）のそれぞれを同じく `toLowerCase()` どうしにする | それぞれ赤 1本 |
| #1327 | InMemory: 小文字でない tenant の `get` を null にする（やりすぎ） | 赤 1本（自分の綴りの対照） |
| #1327 | Postgres: `get`・`getMany`・`getObservation`・`listLabels`・`aggregateScope`（`WHERE` の全箇所）・`eraseTenant`（`drainById` の2箇所）の `tenant_id` 比較を `lower()` どうしにする | それぞれ赤 1本 |
| #1327 | Postgres: 小文字でない tenant の `get` を空にする（やりすぎ。`tenant_id = lower(tenant_id)` を足す） | 赤 1本 |
| #1379 | 末尾の孤立した上位サロゲートを見逃す（足りない） | 赤 7本（3つの欄×2通り＋`append`） |
| #1379 | 孤立した下位サロゲートの上端を 0xDFFE にする（足りない） | 赤 7本（3つの欄×2通り＋`append`） |
| #1379 | SOH まで断る（`code <= 1`。やりすぎ） | 赤 7本（3つの欄×2通り＋`append`） |
| #1379 | 孤立した下位サロゲートの上端を 0xE000 にする（やりすぎ） | 赤 3本（U+E000 の3つの欄） |
| #1379 | 上位サロゲートの下端を 0xD7FF にする（やりすぎ） | 赤 3本（U+D7FF の3つの欄） |

どの変異も、戻したあとは同じ歯が緑に戻り、実装ファイルは main と同一（`cmp`）。

## 縛っていないもの

- #1327 の `survivor.id` の綴り（例外の文面にだけ現れる）は、約束の外なので縛らない【判断】。
- #1337: `enum`・`const` を広く読む変異と `admitsNull` を常に `true` にする変異は、結果が変わらない（同値）ので縛れない。`null` を許さない欄に `null` を残しても、`req.schema` が落とす。
- #1324: `forget` 以外（`restoreArchived`・`purge`・`consolidate`・`reflect`・`markContested`・`resolveContested`）が `getMany` へ渡す id は、この PR では縛っていない（`memoryLookupKeyFor` を使う口のうち `forget` だけを見た）。
- #1327: 綴りだけが違う tenant の検査は、記憶・observation・ラベル・`aggregateScope`・`eraseTenant` の口に絞った。イベント・ベクトル・outbox・tenant 設定・関係・lexical の各 store が tenant を大文字小文字を区別して比べるかは、確かめていない。
- #1379: Postgres 側の `event-meta-roundtrip.postgres.test.ts` には足していない。`Runtime` の口を通して `reason`・`actor.id` が届くところは見ていない（検査関数と `InMemoryEventStore.append` だけを見た）。
- `normalizeUuidCase` の `UUID_PATTERN` の `^` を外す変異は、入れていない。

## これが覆るとしたら

ADR 0607 が縛った約束（`$defs`・`const`・`enum` の `null` の扱い、store へ渡す id を変えないこと、`normalizeUuidCase` が uuid の形だけを小文字にすること、tenant を大文字小文字で区別すること、`\uDFFF` までを孤立サロゲートとし SOH を通すこと）が変わるとき。とくに、tenant を大文字小文字を区別せずに扱うと決めるなら、決めるのはオーナーである。
