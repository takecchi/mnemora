# ADR 0623: 09/27 にマージされた #1176・#1173・#1171・#1162・#1155・#1150・#1145・#1129・#1128・#1122・#1104 の確かめ直しで見つかったすり抜けに歯を足す（schema 名の検査と trigram 閾値・reinforce の起点・setEventRetention の kind の綴り・purgeExpiredEvents の件数と古い順・consolidate の created の actor と note・tick ジョブの actor ほか）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

クローンのマネージャー（mgr-0495eb46）の依頼で担い手が書いた。すり抜けを当て直して塞ぐと決めたのも、約束の内か外かの判断もクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手（またはマネージャー）の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない。`packages/postgres/vitest.config.mts` の `SERIAL_TEST_FILES` に1行足した（#1129 の歯が `pg_stat_activity` を読むため）。
Issue #1724 の済み11本（#1176・#1173・#1171・#1162・#1155・#1150・#1145・#1129・#1128・#1122・#1104）である。#1724 の先の歯は ADR 0614・ADR 0620・ADR 0622 にある。

## 経緯

Issue #1724 の済み11本は、前の担当たち（mgr-4e8c690b・mgr-1bb62c72・mgr-0ee6bed5）がすり抜けを見つけたが、歯が無かった。いまの main に同じ変異を当て直し、約束の内で今もすり抜けるものを塞いだ【実測】。結果は Issue #1724 に PR ごとにコメント（見出しが `# #<n> の歯`・`# #<n> の歯（追補）`）として残してある。

- 変異は、実装側のファイル（core の `runtime.ts`・`tenant-settings-store.ts`・`consolidate.ts`・`reflect.ts`、postgres の `memory-store.ts`・`migrate.ts`・`client.ts` ほか）に1つずつ当てた。
- 変異ごとに退避から戻して `cmp` で一致を確かめ、緑に戻ることを見た。時刻に触れる変異（#1173・#1129）は、赤と緑を3回ずつ走らせた。
- testkit の fixture・core の Fake には変異を当てていない（Issue #1725 で済んでいる）。

約束の出所は、各 PR 本文・実装の TSDoc・ADR である【現物】。後の ADR で約束が変わっていないかは、関数名・文面を `docs/decisions` から `grep` して該当箇所を読んだ。すべての後続 ADR を通読したわけではない【判断】。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない。歯は `__tests__` に置く。
2. 歯を足す（試験だけ）。出所と置き場は次のとおり。実測では、穴の変異で赤になり、戻して緑に戻ることまで見た。

### #1176（schema 名の検査・trigram の閾値）

出所: `schema-namespace.ts` の TSDoc（同梱の呼び出しは、どれも先に検査を通してから呼んでいる）と PR 本文（閾値の値はこれまでどおり効く）。ADR 0596・0611・0622 も約束を変えていない。

- `packages/postgres/src/__tests__/schema-name-guard-bundled-callers.test.ts`（新規、DB 不要）: `runMigrations` の `schema`・`extensionSchema`、`createPostgresClient` の `schema`・`extensionSchema` に不正な名前（`Bad"x`）を渡すと `assertSafeSchemaName` の Error で投げ、偽の Pool に何も発行せず接続も借りない。陽性対照として、安全な名前では `CREATE SCHEMA` まで進む。
- `packages/postgres/src/__tests__/trigram-lexical-store-threshold-boundary.postgres.test.ts`（新規）: `word_similarity('東京タワー','東京ワー')` が 0.375 であることを使い、閾値 0.37 では当たって `coverage` が 1、0.38 では当たらないことを縛る。

### #1173（reinforce の起点）

出所: `MemoryStore.reinforce`・`reinforceMany` の TSDoc（起点は `lastReinforcedAt ?? recordedAt`）と PR 本文（起点は `createdAt` ではなく `recordedAt`）。ADR 0519・`docs/memory-model.md` は約束を広げた側の記述。

- `packages/postgres/src/__tests__/reinforce-origin-pick.postgres.test.ts`（新規、30件）: Postgres と testkit の InMemory を、`reinforce`・`reinforceMany`・`recordUsageAndReinforce` の3つの口に当てる。`lastReinforcedAt` が `recordedAt` より前にある行で、その間の `at` と `recordedAt` ちょうどの `at` が書かれること、`lastReinforcedAt` ちょうど・それより前は書かれないこと。未強化で `recordedAt` が行の作成時刻より未来（2100-01-01）の記憶に、`createdAt` と `recordedAt` の間の `at` を渡しても何も書かれないこと（`recordedAt` + 1ms は書く）。

### #1171（`setEventRetention` の kind の検査）

出所: PR 本文と core の TSDoc（`kind` が `"unlimited"`・`"days"` のどちらでもなければ拒む）。ADR 0479（Fake にも同じ検査）・ADR 0499（日数の上限）は約束を広げただけ。

- `packages/core/src/__tests__/event-retention-kind-guard.test.ts`（新規）: `" days"`・`"days "`・`"unlimited\n"`・`"DAYS"` と、`null`・数値・空のオブジェクト・`['days']`・`false` を、関数に直接渡して拒む。陽性対照で `unlimited`・`days` は通る。
- `packages/postgres/src/__tests__/event-retention-kind-spellings.postgres.test.ts`（新規）: 同じ綴りと文字列でない値を Postgres と testkit の InMemory の `setEventRetention` に流し、例外が出て行が作られない（`unset` のまま）こと、日数を設定済みのテナントでも書き換わらないことを縛る。

### #1162（resolveOrphanedContested の `contestedWithId`）

出所: PR 本文の表の最後の行と「`opts.reason` を渡したときは `note` が加わる」。群版は別の設計で、2者版の約束には触れていない。

- `packages/postgres/src/__tests__/contested-event-counterpart.postgres.test.ts`: 「opts.reason を渡しても、note と一緒に対向の id が入る」を1本（Postgres と testkit の InMemory の2通り）。`markContested`・`resolveContested` の both_active と supersede・`resolveOrphanedContested` の4つを、note 付きで meta 全体の一致で縛る。

### #1155（歯は足していない）

出所: PR 本文3・ADR 0150 の meta の形。#6（`opts.reason` があるとき敗者の `superseded` に `supersededById` を付けない）は、#1162 で足した歯がすでに噛む。supersede を `{ reason: "sup-note" }` で解いたとき、敗者の meta が `contestedWithId` と `supersededById` を含めて全体で一致することを見ている。新しい歯は足していない。

### #1150（consolidate の created の actor と note・tick ジョブの actor）

出所: PR 本文と `ConsolidateOptions.actor`・`reason` の TSDoc（`actor` は省略時 `{type:"system"}`、`reason` は meta の補足）。ADR 0416 は created の組み立てを store が同じトランザクションで呼ぶ形（`buildCreatedEvent`）に移したが、actor と note を載せる約束は変えていない（広がっただけ）。#11 は PR 本文の「`tick()` 経由の自動ジョブは `actor` を渡さないので、変わらない」を出所として約束の内とし、塞いだ（マネージャーの判断）。

- `packages/postgres/src/__tests__/consolidate-created-event-actor-note.postgres.test.ts`（新規、8件）: 実 Postgres と testkit の InMemory を、`supersedeWithNewMemories` あり・なしの4通りで、actor と reason を渡したとき統合先の created と統合元の superseded が同じ actor と `note`（meta は全体一致）を持つこと、どちらも省略したとき actor が `{type:"system"}` で meta に `note` が無いことを縛る。
- `packages/core/src/__tests__/tick-consolidate-reflect-job-event-actor.test.ts`（新規、2件）: core の Fake で consolidate・reflect のジョブを outbox に積み、`tick` で処理させる。統合先の created と統合元の superseded、内省の created の actor が `{ type: "system" }` で、meta に `note` が無い。tick の時計は注入せず（過去の時計だとジョブを取らない）、記憶の `recordedAt` は実時刻にしている（減衰で近傍が閾値を割らないため）。

### #1145（種が withdrawn かの判定）

出所: PR 本文「判定は `status === "forgotten"` または `purgedAt` が在ること。…意図を明示するために両方を見る」。ADR 0454・0541 は約束を広げた（同じ関数を埋め込みジョブにも使う）。

- `packages/core/src/__tests__/withdrawn-seed-purged-at-only.test.ts`（新規、4件）: core の Fake の種の `get` だけを差し替え、`status` は active のまま `purgedAt` だけ立った種を作る（実際の store では作れない状態で、判定の `purgedAt` 側だけを独立に縛る）。consolidate は近傍を集めず・LLM を呼ばず・`nothing_to_consolidate`・イベントが増えない。reflect は土台が種1件だけで近傍にイベントが積まれない。対照2件は、種を差し替えなければ同じ近傍と一緒に統合・内省される。

### #1129（purgeExpiredEvents）

出所: PR 本文・TSDoc（`purged` は実際に削除された行数）・`docs/memory-model.md` §9。ADR 0354（cutoff の計算が `computeEventRetentionCutoff` へ）・ADR 0547（下限の早い return が `isBeforePgTimestamptzMin` へ）で場所が移っただけで、約束は広がった側である。変異は移った先（`purgeExpiredEventsBody`・`computeEventRetentionCutoff`）に当てた。M9 は PR 本文の「どの行を消すか（古い順）は変えていない。…『同時に呼んだとき、どの行を消すか』を変えるので採らなかった」を出所として約束の内とし、塞いだ（マネージャーの判断）。

- `packages/postgres/src/__tests__/purge-expired-events-partial-delete.postgres.test.ts`（新規、5件）: 選んだ10行のうち最も古い4行を、DELETE を発行する直前に別の接続で消し（`Client.prototype.query` を1回だけパッチして決定的に作る）、`purged` が 6、`meta.purgedCount` が 6、期間が残った6行の最古・最新であることを縛る（M1・M2・M4）。行を `at` の新しい順に・主キーも逆に直接 INSERT し、新しい順に返る形で最古・最新を縛る（M5）。紀元前2000年の行は、cutoff が紀元前1000年なら対象になる（通常・dryRun。M8）。保持日数 200万日（cutoff は約紀元前3450年）で、紀元前2000年の行は残り紀元前4000年の行だけ消える（M11）。
- `packages/core/src/__tests__/event-retention-cutoff.test.ts`（新規、8件）: `computeEventRetentionCutoff` が、100万・200万・2400万日では `now − 日数` のまま、2^31−1 と 1000億日では `Date` の下限（−8.64e15）になる（M11）。
- `packages/postgres/src/__tests__/purge-expired-events-which-rows.postgres.test.ts`（新規）: M9 の歯。別の接続 A が最古の3行を `SELECT … FOR UPDATE` で掴んだまま保持し、その間に `purgeExpiredEvents`（limit 3）を起こし、`pg_stat_activity.wait_event_type = 'Lock'` で掃除がロックを待っていることを確かめる。A を ROLLBACK すると、掃除は掴まれていた最古の3行を消し（`purged` 3・`reachedLimit` true・期間は最古3行）、新しい3行が残る。時間待ちで競わせない決定的な形である。`pg_stat_activity` を読むので、`packages/postgres/vitest.config.mts` の `SERIAL_TEST_FILES`（直列の群）に足した。

### #1128（consolidate・reflect の本文の空白）

出所: PR 本文「判定は `trim()` で空になるかだけにした。前後に空白があっても中身のある本文は、削らずにそのまま書く」と `llm-content.ts` の TSDoc。ADR 0502・0528 はこの約束に触れていない。

- `packages/core/src/__tests__/llm-blank-content.test.ts`（2件足した）: LLM が `"  束ねた本文\n"`・`"  気づき\n"` を返したとき、`consolidate` は `consolidated`、`reflect` は `reflected` になり、`llmFailure` が無く、書かれた本文が元の文字列のままである（core の Fake）。

### #1122（LLM の tags の空白）

出所: `llm-tags.ts` の TSDoc「空白でない要素は、前後の空白・並び・重複も含めてそのまま残す」と PR 本文「捨てる以外のことはしない」「LLM の tags だけに当てる。統合元の tags の和集合には当てない」「全部空白だけなら空配列にした」。PR #1354 が reflect のスキーマを広げただけで、約束は広がった側。

- `packages/core/src/__tests__/llm-blank-tags.test.ts`: 3つのビルダー（抽出・統合・内省）を直接呼ぶ。`[" ", " 旅行 ", "\n出張\t", ""]` が `[" 旅行 ", "\n出張\t"]` になる（M3）。LLM が tags を返さなかったときの統合元の和集合（`" "` を含む）が `[" ", "x", "y"]` のまま（統合・内省。M7）。内省で LLM の tags が `["", " "]` なら `[]` になり、統合元の `x`・`y` に倒れない（M10）。

### #1104（reextract の使用報告の検査）

出所: PR 本文の「回帰確認：ほかの種類の抽出は今までどおり」と、検査が使用報告（`kind: "usage"`）だけを対象にするという直し方。後の ADR・PR で約束は変わっていない。

- `packages/core/src/__tests__/reextract-usage-observation.test.ts`（2件足した）: `event`・`document` の Observation を `observe` して `reextract` し、`extraction: "ok"`・記憶1件になる（core の Fake）。

3. ほかの ADR には追記しない。

## 実測【実測】

対象の `__tests__` を名指しで走らせ、変異を1つずつ入れ、戻して `cmp` で一致と緑を見た。「前の担当のすり抜け」は前の担当たちが見つけた数で、当て直しでも今の main で同じくすり抜けることを確かめた。

| PR    | 前の担当のすり抜け               | 塞いだ                                                                                   | 塞がない                         |
| ----- | -------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| #1176 | 4（S1・S3a・S3b・M8）            | 4（S1・S3a・S3b・M8。`runMigrations` の `extensionSchema` の検査を消す変異も同じ歯で赤） | 0                                |
| #1173 | 2（M9・M11）                     | 2                                                                                        | 0                                |
| #1171 | 2（C7・C8）                      | 2                                                                                        | 0                                |
| #1162 | 1（R12）                         | 1（R2・R13 も同じ歯で赤）                                                                | 0                                |
| #1155 | 1（#6）                          | 0（#1162 の歯がすでに噛む）                                                              | 0                                |
| #1150 | 6（#4・#6・#7・#11・#12・#13）   | 6（#11 は追補）                                                                          | 0                                |
| #1145 | 1（M2）                          | 1                                                                                        | 0                                |
| #1129 | 7（M1・M2・M4・M5・M8・M9・M11） | 7（M9 は追補）                                                                           | 0                                |
| #1128 | 2（M4・M9）                      | 1（M4）                                                                                  | 1（M9。約束の外）                |
| #1122 | 3（M3・M7・M10）                 | 3                                                                                        | 0                                |
| #1104 | 1（M3）                          | 1                                                                                        | 0                                |
| 計    | 30                               | 28                                                                                       | 1（ほか #1155 の #6 は塞ぎ済み） |

どの PR も、変異を入れた状態で既存の歯は全部緑で、新しい歯が赤になった。戻して `cmp` で一致、緑に戻ることを見た。

## 塞がなかったもの【判断】

PR ごとに1件1行。

- #1176: M9（別の GUC を設定して文面を似せる）: すり抜けが無い。振る舞いの歯（`trigram-lexical-store.postgres.test.ts` など）が捕まえる。
- #1176: M10（`SET LOCAL … = 0.37` に戻す）: すり抜けが無い（`threshold-param` の「パラメータとして渡す」が赤）。
- #1176: S4（`qualify` が `"` を `""` にエスケープする）: 約束の外。TSDoc の「エスケープしない」は、正しい名前に `"` が入らないので、やりすぎ側の変異で観測できる害が無い。
- #1176: M7（`set_config` を2回発行する）: 元と同じ働き（往復が増えるだけ）。
- #1176: SQL_ASCII の leg の `create()` の拒否: この環境が UTF8 で、その leg は走らせられない（M8 の歯は SQL_ASCII では `create()` が拒むことだけを見る形にしてある）。
- #1173: M1〜M8・M10: 前の作業者が赤になったと確かめている。再実測していない。
- #1173: M2（`reinforceMany` 側だけ元の条件に戻す）: すでに塞がっている（`reinforce-origin-no-rewind` の PR の歯が噛む）。適合テストには `reinforce` の歯しか無い点は、適合テストに足さない決まりなので変えていない。
- #1171: C1〜C6・P1・P2: 前の作業者が赤になったと確かめている。再実測していない。
- #1171: Fake（core の `runtime-fakes.ts`）への変異: 決まりで当てていない。共有の `assertValidEventRetentionKind` の変異は、Fake も同じ関数を呼ぶので core の歯が先に噛む。
- #1162: R9・R10（orphan の `contestedWithId` を外す／生き残った側の id にする）: すでに塞がっている（前の担当の実測で postgres の歯が噛む。当て直していない）。core の `resolve-orphaned-contested.test.ts` だけは噛まないが、core の Fake 経由のみで、Postgres と InMemory の歯が噛んでいるので足していない。
- #1155: #1〜#5・#7〜#13: 前の担当の実測でもともと赤（すり抜けではない）。当て直していない。
- #1150: #1〜#3・#5・#8〜#10: 前の担当の実測でもともと赤（すり抜けではない）。当て直していない。
- #1145: M1・M3〜M12: 前の担当の実測でもともと赤。M4・M5・M10・M11 は PR の歯でなく別の歯が噛むと前の担当が控えている通りで、今の main に穴は無い。M2 の重さは前の担当が「低」としている（実際の状態では `status` だけで同じ結果になる）が、歯は PR が書いた「両方を見る」という意図を縛る。
- #1129: M12（`isBeforePgTimestamptzMin` を `<=`）: purge から見ると元と同じ働き（下限ちょうどは問い合わせても0件）。
- #1129: M3・M6・M7・M10: 前の作業者が赤になったと確かめている。再実測していない。
- #1128: M9（`consolidate` の検査のエラー文面の場所の名前を `"reflect"` に取り違える）: 約束の外。PR 本文にも `llm-content.ts` の TSDoc にも、失敗の文面に場所の名前（`where`）が入るとは書いておらず、`where` は実装にあるだけ（前の担当が「PR の TSDoc」と書いたのは、実際の TSDoc には無い）。
- #1128: M1〜M3・M5〜M8: 前の担当の実測でもともと赤。M3・M5（postgres の歯が緑のまま）は前の担当が「細い」としたがすり抜けに数えられていないので、足していない。
- #1122: M1・M2・M4〜M6・M8・M9・M11: 前の担当の実測でもともと赤。M4・M5・M6（postgres の歯が緑のまま）は「細い」とされたがすり抜けに数えられていないので、足していない。postgres の歯は、変異が core の関数にあり core の歯が直接噛むので足していない。
- #1104: M1・M2・M4・M5: 前の担当の実測でもともと赤。M4・M5（postgres の歯が緑のまま）は「細い」とされたがすり抜けに数えられていないので、足していない。postgres の歯は、M3 の変異が core の `runtime.ts` にあり core の歯が直接噛むので足していない。

## 約束の変わり方【判断】

どの約束がどう変わったか（1件1行）。

- #1176: ADR 0596・0611・0622 も約束を変えていない。`schema-namespace.ts` の TSDoc は今も同じ文面。
- #1173: ADR 0519・`docs/memory-model.md` は約束を広げた側の記述で、狭めたものは見つからなかった。
- #1171: ADR 0479（Fake にも同じ検査）・ADR 0499（日数の上限）は約束を広げただけで、狭めたものは見つからなかった。
- #1162: 群版（別の設計）は2者版の約束に触れていない。約束は変わっていない。
- #1155: ADR 0493・0503・0515 は store 入力の検査、ADR 0381・0450 は群版で、2者版の meta の約束を変えるものは見つからなかった（網羅の主張ではない）。
- #1150: ADR 0416 が created の組み立てを store が同じトランザクションで呼ぶ形（`buildCreatedEvent`）に移したが、actor と note を載せる約束は変えていない（広がっただけ）。
- #1145: ADR 0454・0541 は約束を広げた側で、狭まっていない。
- #1129: ADR 0354・0547 で cutoff の計算・下限の早い return の場所が移っただけで、約束は広がった側。移った先に当てた。
- #1128: ADR 0502・0528 はこの約束に触れていない。
- #1122: PR #1354 が reflect のスキーマを広げただけで、約束は広がった側。
- #1104: 約束を変えた ADR・PR は見つからなかった（ADR 0454 などは約束を変えていない）。

## 縛っていないもの

- #1128 M9: エラー文面の場所の名前（約束の外）。
- #1176 S4: `qualify` の `"` のエスケープ（約束の外）。
- #1176: SQL_ASCII の leg は、この環境が UTF8 なので走らせていない。
- #1145 M2 の歯は、Fake の差し替えでしか作れない状態に対するもの（実際の store では `status` だけで同じ結果になる）。
- #1162 の core 側 `resolve-orphaned-contested.test.ts` は R9・R10 を縛らない（Postgres と InMemory の歯が噛む）。
- testkit の fixture・core の Fake には変異を当てていない（Issue #1725 で済んでいる）。
- 全テストは走らせていない。名指しのファイルだけである。DB の要る試験は、この仕上げの段では走らせていない。
- なお `dedicated-schema.postgres.test.ts` は、他のファイルと並べて走らせると afterAll が30秒で時間切れになることがあった（単独では緑）。変異とは無関係で、直していない。

## これが覆るとしたら

schema 名を検査してから同梱の呼び出しを使うこと、trigram の閾値が渡した値のまま効くこと、reinforce の起点が `lastReinforcedAt ?? recordedAt` であること、`setEventRetention` が `kind` を完全一致で拒むこと、resolve 系の note 付きイベントが対向の id を持つこと、consolidate・reflect の created の actor と note（tick 経由は `system` で note 無し）、種が withdrawn かを `status` と `purgedAt` の両方で見ること、`purgeExpiredEvents` が実際に消えた行から件数・期間を取り古い順に消し同時の呼び出しでも掴まれた行を飛ばさないこと、LLM の本文・tags の空白の扱い、`reextract` が使用報告だけを拒むことが変わるとき。ADR 0354・0547 のように関数の置き場が変わるときは、変異の入れ先を読み替えて当て直す。

## 追記（2026-10-09、[Issue #2048](https://github.com/takecchi/mnemora/issues/2048)）: #1176 の出所に挙げた TSDoc の文面は、今の `schema-namespace.ts` に無い

上の「#1176（schema 名の検査・trigram の閾値）」で、出所を「`schema-namespace.ts` の TSDoc（同梱の呼び出しは、どれも先に検査を通してから呼んでいる）」と書いた。**この文面は、いまの `schema-namespace.ts` に無い。**#1873（2026-10-07、コメントを Why not と公開の約束だけに縮めた PR）で消えた（`git log -S"同梱の呼び出し" -- packages/postgres/src/schema-namespace.ts` は、足した #1176 と消した #1873 の2件を返す。[Issue #2016](https://github.com/takecchi/mnemora/issues/2016)）。

#2023 は、`schema-name-guard-bundled-callers.test.ts` の冒頭のコメントの出所を、この ADR に向け直した。ところが、この ADR が挙げる出所はもう無い。そのため、この ADR から今の出所を辿れるよう、ここに書く。上の本文は書き換えない。

**今の出所**（main `8ca9f585` で確かめた）:

| 呼び出し | 「受け取ったスキーマ名を、使う前に `assertSafeSchemaName` で検査する」の出所 |
|---|---|
| `runMigrations` | `packages/postgres/src/migrate.ts` の `runMigrations` の TSDoc、「`options.schema`」節の1（`schema`（と `extensionSchema`）を、ロック取得より前に `assertSafeSchemaName` で検証する） |
| `registerEmbeddingSpace` | `packages/postgres/src/vector-space.ts` の `registerEmbeddingSpace` の TSDoc（`schema`・`extensionSchema` が `assertSafeSchemaName` を通らなければ、通常の `Error`。検査はロック取得より前） |
| `createPostgresClient` | `packages/postgres/src/client.ts` の `createPostgresClient` の TSDoc、「`config.schema`」節（`schema`・`extensionSchema` を、接続オプションへ入れる前に `assertSafeSchemaName` で検査する）。#1873 で落ちた約束（元は `schema-namespace.ts` の `qualify` の TSDoc にあった「同梱の呼び出しは、どれも先に検査を通してから呼んでいる」）を、`createPostgresClient` の振る舞いの文面として、この追記と同じ PR で書き戻した。出所は、この ADR が #1176 の確かめ直しで歯を足すと決めたこと（上の本文と「これが覆るとしたら」の「schema 名を検査してから同梱の呼び出しを使うこと」）であり、新しい約束ではない |

