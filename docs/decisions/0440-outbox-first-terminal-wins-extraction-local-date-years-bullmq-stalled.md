# ADR 0440: 抽出の現地の暦日を年の範囲によらず組み直す・outbox の終端を先勝ちにする・BullMQ の stalled を README に書く

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。直し方はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  穴探しの16巡目で見つかった3件を、1本の PR にまとめた。

  **(1) 抽出の現地の暦日が、年によって落ちる。** `buildExtractionPrompt`（`packages/core/src/extraction.ts`）は、`extractionContext.timeZone` と `occurredAt` がそろうと、`Intl.DateTimeFormat("en-CA", …).format(occurredAt)` の文字列を `Date.parse(\`${localDate}T00:00:00Z\`)`に渡して`relativeDates` を作っていた。
  - 【実測】（node v22.23.3）`en-CA` は年を4桁に0詰めしない: `"999-06-01"`・`"10000-01-01"`・`"275760-09-12"`。紀元前は符号が落ち、天文学年 0 が `"1"`、-100 が `"101"`、-1 が `"2"`。`formatToParts` の `era` は、`era` を要求しないと出ない。`era: "short"` を足すと `"AD"`/`"BC"` が出る（`relatedYear` は出ない）。1582-10-10 は `"1582-10-10"` のまま（暦の切り替えは無い、proleptic Gregorian）。
  - 【実測】その文字列は `Date.parse` で NaN になり、`toISOString()` が `RangeError: Invalid time value` を投げる。結果、`observe` に `extractionContext: { timeZone }` と、年が 1000 未満か 10000 以上（JST で年が変わる `9999-12-31T20:00Z` を含む）の `occurredAt` を渡すと、LLM を呼ばずに `extraction: "llm_failed_whole_observation"`・`failure: { kind: null, message: "Invalid time value" }` で全文フォールバックになる。sync でも deferred でも、InMemory でも Postgres でも同じ（16巡目の実測）。
  - 【実測】出力側にも別の癖があった。`relativeDates` は `.toISOString().slice(0, 10)` で、10000年以上では `"+010000-01"` のように切れる。**1000〜9999 年でも、現地の暦日が 9999-12-31 のとき「明日」「明後日」は `"+010000-01"` になっていた**（直す前の出力を採って確かめた）。

  **(2) outbox の終端が、同種の再呼び出しで上書きされる。** `PostgresOutboxStore.complete` の `UPDATE` は `failed_at IS NULL` だけ、`fail` は `completed_at IS NULL` だけを見ていた。testkit の fixture も同じ形だった。
  - 【実測】同じリース（同じ `attempts`）で `complete` を2回呼ぶと `completed_at` が2回目の `at` に、`fail` を2回呼ぶと `failed_at`・`last_error` が2回目の値に上書きされる（両 adapter。`purgeCompletedJobs` の `olderThan` の境界も後ろにずれる）。古い worker の `complete`/`fail` は `OutboxLeaseConflictError`、B が `complete` した後の B の `fail` は無言の no-op、終端後の `claimBatch` は0件——これらは両 adapter で一致していた。
  - 【現物】interface の doc は「同じ claim への再呼び出しは冪等」とだけ書き、値が1回目か2回目かを決めていなかった。complete と fail の混在は [Issue #826](https://github.com/takecchi/mnemora/issues/826) で先勝ちと決まっていたが、同種は対象外だった。testkit の既存テスト（`in-memory-outbox-terminal-exclusive.test.ts`）は、fail → fail の `lastError` を「後勝ち（既存契約）」として縛っていた。

  **(3) BullMQ の lock の期限切れ（stalled）が、どこにも書かれていない。**
  - 【現物】BullMQ 6.3.8 の `dist/cjs/classes/worker.js`: 既定 `lockDuration: 30000`・`stalledInterval: 30000`・`maxStalledCount: 1`、lock は `lockDuration / 2` の間隔で延長される。`processJob` は processor が終わったあとに `handleCompleted`（`moveToCompleted`）を `retryIfFailed` で包み、lock を失っていると `Missing lock` で失敗する。読むと、lock の期限切れで stalled checker がジョブを wait に戻し、別の Worker が2本目の tick を走らせうる。outbox の `claimBatch` の CAS が効くのでジョブの二重処理は起きず、driver も二重に数えない。遅れて終わった1本目は processor の中で `onTickResult` を呼んだあとに `moveToCompleted` が失敗し、`worker.on("error")` 経由で `onTickError` に届きうる（2回）。
  - `packages/bullmq` の README・tick-driver の doc・[ADR 0325](./0325-bullmq-tick-driver.md) に stalled / `lockDuration` の記述は無い。**Redis が無い環境のため、走らせていない。**

- **決めたこと**:

  1. **現地の暦日を `formatToParts` で取り、`setUTCFullYear` で組み直す。**
     - `era: "short"` を足して `formatToParts` し、`year`・`month`・`day` と `era` を取る。`era` が `"BC"` なら天文学年は `1 - year`（1 BC が 0、101 BC が -100）。`Date.UTC` は年 0〜99 を 1900 年代に読み替えるので使わず、`new Date(0)` に `setUTCFullYear(year, month - 1, day)` して日を足す。
     - **プロンプトに出す日付の文字列は、`Date#toISOString` の日付部分と同じ書き方にした**: 0〜9999 年は4桁に0詰め（`"0999-06-01"`）、範囲外は符号付き6桁（`"+010000-01-01"`・`"-000100-06-01"`）。`occurredAt` が同じ JSON の中で `toISOString()` の形（`"+010000-06-15T00:00:00.000Z"`）で出ているので、それと同じ書き方に揃えた。【判断】
     - `observedLocalDate` と `relativeDates` の全部で同じ書き方を使う。`relativeDates` が `Date` の範囲（±8.64e15 ms）を出る日付（`+275760-09-13` の翌日など）は、落ちずにその日付だけ `null` にする。現地の暦日そのものが範囲を出る（`-271821-04-20T00:00Z` を UTC-8 で見ると 4/19）ときは、`observedLocalDate` は文字列のまま、`relativeDates` の各値が `null`。
     - **1000〜9999 年と `timeZone` なしは、プロンプトの content を1バイトも変えない。** 直す前の出力（1969 年、2026 年、1000 年、タイムゾーン違い、`timeZone` なし）を固定値として縛り、1000〜9999 年を4つのタイムゾーン × 約240年 × 3つの月日で掃引して旧実装の書き方（`Intl` の文字列 + `Date.parse` + `toISOString().slice(0, 10)`）と突き合わせた。**例外は、現地の暦日が 9999-12-31 のときの「明日」「明後日」**（直す前は `"+010000-01"` と切れていたもの。`"+010000-01-01"`・`"+010000-01-02"` になる）。1バイトも変えない対象に入れなかった。【判断】切れた文字列を残す理由が無い。
  2. **outbox の終端は先勝ちにする。** 同じ `attempts` で2回目の `complete`/`fail` が来ても、1回目の `completed_at`・`failed_at`・`last_error` を保つ。
     - `@mnemora/postgres`: `complete`・`fail` の `UPDATE` の `WHERE` を、どちらも `completed_at IS NULL AND failed_at IS NULL` にした（以前は片方ずつ）。`@mnemora/testkit/fixtures`: どちらも、`completedAt`・`failedAt` のどちらかが付いていれば何も書かずに返る。
     - **例外は新しく投げない。戻り値の形も変えない**（`Promise<void>`）。`attempts` 不一致は `OutboxLeaseConflictError`、行が無い・UUID の形でない id は no-op、`attempts` が一致するのに 0 行だった場合は無言の no-op（`raiseIfLeaseConflict` の (c)）のまま。
     - interface（`OutboxStore`）の doc と、両実装の doc に「先勝ち」と書いた。`packages/testkit/src/*-conformance.ts` には手を入れていない（公開面なので、テストは testkit と postgres の `__tests__` に置いた）。
     - 既存の testkit のテスト2件（complete → complete、fail → fail）は、値を縛っていなかった／後勝ちを縛っていたので、先勝ちへ書き換えた。
  3. **BullMQ の stalled を README に1節足す。** `packages/bullmq/README.md` に「lock の期限切れ（stalled）で、1回の tick に `onTickResult` と `onTickError` の両方が届きうる」を足し、`onTickError` の TSDoc にも同じ趣旨を短く足した。内容: stalled で `onTickResult` の後に `onTickError` が届きうること、データは壊れないこと（outbox の CAS）、`lockDuration` の意味（既定 30000 ms・この driver からは設定できない）。**その節に「【未実測】BullMQ 6.3.8 のソースを読んだだけで、Redis で走らせていない」と明記した。**
  4. **`lockDuration` を通す口は足さなかった。** 公開 API（`CreateBullmqTickDriverOptions`）の追加になり、追加するかはオーナーが決めることなので、足していない（台帳に残す）。
  5. **再配達の件（[ADR 0394](./0394-activity-clock-writes-use-memorys-own-subject.md) の負債(1)）には触れていない。**

- **検討した代替案**:

  1. **`en-CA` の文字列を0詰めして `Date.parse` に渡す。** 採らなかった。紀元前は符号が落ちていて、`"101-06-01"` が 101 AD なのか 101 BC（天文学年 -100）なのか文字列から分からない。`era` で決める必要がある。
  2. **`Temporal` を使う。** 採らなかった。node 22 の標準に無く、`@mnemora/core` は実行時依存を zod だけにしている。
  3. **プロンプトの日付を `"0999-06-01"` ではなく `Intl` のままの `"999-06-01"`、紀元前は `"101 BC"` のように出す。** 採らなかった。同じ JSON の `occurredAt` と書き方が揃わず、LLM が「天文学年」と「紀元前の年」を取り違えうる。ISO 8601 の拡張年の形に揃えた（拡張年の読み方を LLM が正しく解するかは測っていない）。
  4. **範囲を出る日付で例外を投げる／全文フォールバックへ戻す。** 採らなかった。落ちる入力を減らす方向の直しなので、その日付だけ `null` にした。
  5. **同種の再呼び出しは後勝ちのまま、ドキュメントだけ直す。** 採らなかった。`purgeCompletedJobs` の境界が呼び出しのたびに後ろへずれる、`last_error` が最初の原因でなく最後の値になる、のは先勝ち（[Issue #826](https://github.com/takecchi/mnemora/issues/826) の complete と fail の混在）と食い違う。
  6. **2回目を例外にする（冪等でなく衝突とする）。** 採らなかった。戻り値・例外を変えない、という指示による。公開の契約（「同じ claim への再呼び出しは冪等」）を変える。
  7. **`lockDuration` を `CreateBullmqTickDriverOptions` に足す。** 採らなかった（決定4）。
  8. **README でなく driver の側で `onTickResult` の後の `onTickError` を束ねる。** 採らなかった。Redis が無く実走できない現状では、挙動の確認なしに driver の振る舞いを変えられない。

- **引き受けた負債**:

  - **stalled の記述は未実測**（ソースの読みのみ）。実際に `onTickError` が2回届くか、`onTickResult` の後に届くか、別の Worker が2本目を走らせるかは、Redis で走らせていない。
  - **ISO 8601 の拡張年（`+010000-01-01`）・紀元前の書き方を LLM が正しく読むか**は測っていない（実 API を使っていない）。落ちずに抽出へ進むことと、プロンプトの文字列の形までを確かめた。
  - **`Date` の範囲の端では、`relativeDates` の一部が `null` になる。** `null` のとき、LLM には「この日は計算できない」としか見えない。
  - 先勝ちにしたことで、同じ claim の2回目の `fail` の `error` は捨てられる。`last_error` は最初の失敗の原因を指す。2回目の失敗の原因を残す口は無い。
  - `fail` の戻り値は、2回目が捨てられたかを知らせない（`void` のまま）。
  - 再配達の件（ADR 0394 の負債(1)）は残っている。

- **これが覆るとしたら**:

  - オーナーが、同種の再呼び出しを後勝ち・例外にしたいと決めたとき（interface の doc・両実装・歯の書き換えになる。`purgeCompletedJobs` の境界の扱いが変わる）。
  - オーナーが `lockDuration`（や `stalledInterval`）を `CreateBullmqTickDriverOptions` に通すと決めたとき。公開 API の追加になる。
  - Redis で stalled を実走させ、README の読みが外れていたとき（README の節と TSDoc を実測に合わせて直す）。
  - 紀元前・拡張年を LLM が誤読すると分かったとき（プロンプトの書き方を改める。たとえば文章で「紀元前101年」と添える）。

- **測ったこと**（【実測】2026-10-01、node v22.23.3、手元の Postgres 17 UTF8 `C.UTF-8`。歯を先に走らせて赤を見てから直した）:

  - 決定1: `packages/core/src/__tests__/extraction-local-date.test.ts`（19本）。**直す前**: 11本が赤（組み直し・端・0999年・JST の10000年の元日・+010000年・紀元前を sync/deferred の偽の LLM が呼ばれる経路で8本、ほか3本）、8本が緑（`Intl` の癖を固定した3本、固定値5本と掃引。固定値と掃引は旧実装でも緑＝「変わらない」の前提が成り立つ）。**直した後**: 19本とも緑。既存の `extraction-context.test.ts`・`extraction.test.ts` も緑。**変異**（`cp` で退避・復元）: 紀元前の `1 - year` を外す 5本赤、4桁0詰めの範囲を 1000〜9999 に狭める 3本赤、日付に +1 日ずらす 16本赤。戻すと19本緑。
  - 決定2: `packages/postgres/src/__tests__/outbox-first-terminal-wins.postgres.test.ts`（8本）・`packages/testkit/src/__tests__/in-memory-outbox-first-terminal-wins.test.ts`（8本）。**直す前**: どちらも3本が赤（complete→complete、fail→fail、`purgeCompletedJobs` の境界）、5本が緑（complete→fail、fail→complete、終端後の `claimBatch` 0件、例外、最初の終端）。**直した後**: どちらも8本緑。既存の `outbox-complete-fail-terminal-exclusive.postgres.test.ts`・`outbox-fail-nul-last-error.postgres.test.ts`・conformance の outbox の it・`in-memory-outbox-terminal-exclusive.test.ts` も緑。**変異**: Postgres の `WHERE` を片方ずつに戻す 3本赤、fixture の同種の検査を外す 3本赤。戻すと8本緑。
  - 公開 API の snapshot に差分は出ない（追加した型・関数は無い）。
  - **測っていないこと**: stalled（Redis が無い）、LLM の拡張年の読み方、本物の2接続からの並行 `fail`+`fail` の勝者（歯は、`failed_at` と `last_error` が同じ呼び出しのものであることだけを見る）、`Runtime.tick` を通した終端の再呼び出し。
