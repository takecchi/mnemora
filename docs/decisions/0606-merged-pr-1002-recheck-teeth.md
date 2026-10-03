# ADR 0606: 10/02 にマージされた #1646・#1649・#1650・#1643・#1636 の確かめ直しで見つかった穴を塞ぐ（空白だけの title・例外の同一性と params・tick の opts の通る側・reachedLimit の境目・labels の語彙と並び）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャー（mgr-d25950ce）が書いた。歯を書くと決めたのはクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0603](./0603-adr-0382-0380-merged-pr-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯【実測】

2026-10-02（UTC）にマージされ、実装を変えた7本（#1667・#1650・#1643・#1649・#1648・#1636・#1646）を、main `8418ae9b` で独立に確かめ直した。約束ごとに足りない側とやりすぎた側の変異を1つずつ入れ、PR の歯と、既存のほかのテストファイルを名指しで走らせた。#1667・#1648 は、PR の後に入った歯（[ADR 0568](./0568-abort-if-superseded-controls-and-duplicate-id-changed.md)・[ADR 0580](./0580-adr-0568-nonexistent-id-and-event-get-controls.md)・[ADR 0574](./0574-adr-0557-superseded-by-controls.md) ほか）が、いまの main ではすり抜けを塞いでいたので、この ADR では歯を足さない。残りの5本で、次の変異がどの歯にも捕まらなかった。

| PR・ADR | 約束 | すり抜けた変異 | 通った理由 |
| --- | --- | --- | --- |
| #1646（[ADR 0517](./0517-blank-title-is-not-prefixed-when-extract-title.md)） | `extractTitle: true` でも、`trim` で空になる title は本文の前置きにしない（U+00A0 なども含む）。実質のある title は前後の空白もそのまま。抽出に渡る本文と全文フォールバックの Memory の本文の両方。保存する payload の `title` は変えない | NBSP・`\v`・`\f`・U+FEFF を空とみなさない／content が空のとき title を trim して返す／前置きのとき content を trim する／`extraction.ts` の2つの呼び出し箇所だけ旧来の組み立てに戻す／保存する payload の `title` を trim する | 歯の「U+00A0（NBSP）」の行の値が、実際には普通の空白 0x20 だった（`od -c` で確かめた）。歯は純関数の単体だけで、呼び出し側が実際にこの関数を通るかを縛っていなかった。content が空の行・空白を含む content・保存した payload を見る歯が無かった |
| #1649（[ADR 0516](./0516-omit-params-trigram-outbox-tenant-settings-stores.md)） | 例外そのものを返す（新しい例外を作らない）。`DrizzleQueryError.params` と pg エラーの `message`・`detail` は変えない | 同じ message・cause の `TypeError` を投げ直す／`params` を `[]` にする／cause の pg エラーの `message`・`detail` を変える | 本物の DB で例外を起こす歯は、message・stack の目印と SQLSTATE しか見ていなかった（同一性を見るのは、drizzle の形の偽の db の2本だけ） |
| #1650（[ADR 0514](./0514-tick-opts-kinds-limit-claimed-by-and-huge-lease-ms.md)） | `kinds` の要素の中身（空文字など）は検査しない。`limit` は 0 以上 2^63 未満の整数を通す（2^62 も通す） | `kinds: [""]` を断る／`limit >= 2 ** 62` を断る | 通る側の対照に `kinds: [""]` も、2^63 の手前の値も無かった |
| #1643（[ADR 0538](./0538-retention-and-purge-parity.md)） | `reachedLimit` は、候補が limit より多いときだけ true | `reachedLimit` を `>=` にする（events は Fake・InMemory・Postgres、recalls・jobs は Fake） | 候補がちょうど limit 件の入力が無かった。recalls・jobs は適合テストに「ちょうど limit 件」の段があるが、Fake は適合テストを通らない |
| #1636（[ADR 0511](./0511-label-upsert-cross-memory-and-purge-update-order-deadlocks.md)） | createMany・supersede は語彙を先に作らない。purge で count が 0 になってもラベルの行は残す。`upsertProposedLabels` はコードポイント順 | 書かれなかった候補の語彙を count 0 で先に作る／purge の後に count 0 のラベルを消す／`.sort()`（UTF-16 順）にする・逆順にする | 書かれなかった候補の語彙・count 0 になる purge を見る歯が無かった。並びの歯は ASCII だけだった |

#1636 では、ほかにも名前順（経路をまたぐ順・purge と scrub の先取りの順）と、ロックを取りすぎる変異（テナントの全ラベル・表ロック・行を書く）がすり抜けた。機能の歯では原理的に見えず、並行性や行が書かれた跡、en_US のロケールを見る歯が要るので、Issue #1718 に残し、この ADR からは外した【判断】。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない（公開の約束を増やすのはオーナーの領分。歯は core・postgres の `__tests__` に置く）。
2. 歯を足す（試験だけ）。
   - **#1646**（`packages/core/src/__tests__/observation-text-blank-title-not-prefixed.test.ts`、新しく `observe-blank-title-runtime-path.test.ts`）
     - NBSP の行の値を本物の U+00A0 に直し、`\v`・`\f`・U+FEFF の行を足し、混在の行にも入れた。
     - content が空で title が `" T "` なら、そのまま返る。前置きのとき、content の前後の空白が残る。
     - `observe()` を core の Fake で実際に通し、空白だけの title（4種）で、偽の LLM に渡った本文と、LLM が失敗したときの全文フォールバックの Memory の本文が content だけであること。保存した payload の `title` が元の文字列のままであること。
     - 範囲外の今の振る舞いを1本で固定する: event の `name` は空白だけでも前置きになりうる（ADR 0517 の負債3）。
   - **#1649**（新しく `packages/postgres/src/__tests__/error-omits-params-keeps-identity.postgres.test.ts`）: Outbox `complete`・Trigram `search`・TenantSettings `setDecayClock` で本物の DB に例外を起こし、`instanceof DrizzleQueryError`・`name`・`params` の中身・cause の pg エラーの `message`・`detail` が残ることを見る。Trigram は `C.UTF-8` の DB で判定が `ok: true` になり、本体まで走ることを確かめた（`--locale=C` では判定が ok にならず、本体を見ずに戻る）。
   - **#1650**（`packages/core/src/__tests__/tick-opts-validation.test.ts`）: 通る側に `kinds: [""]`、`limit: 2 ** 62`・`2 ** 63 - 1024` を足した。
   - **#1643**（Fake: `fake-memory-store-purge-expired-events.test.ts`・`fake-purge-expired-recalls-and-completed-jobs.test.ts`。InMemory・Postgres: 新しく `purge-expired-events-reached-limit-exact.postgres.test.ts`）: 候補がちょうど limit 件なら `reachedLimit` は false、1件多ければ true。events は実消しと `dryRun` の両方。
   - **#1636**（新しく `packages/postgres/src/__tests__/labels-vocabulary-teeth.postgres.test.ts`）: SAVEPOINT で落ちた候補・冪等衝突の候補の語彙が `listLabels` に増えない（createMany・supersede）。purge で count が 0 になったラベルが残る。`upsertProposedLabels` が発行する `INSERT INTO labels` の並びが、`tag-a`・`tag-～`（U+FF5E）・`tag-😀`（U+1F600）の順（UTF-16 順では 😀 が ～ より前になる）で、tags の入力の並びに依らないこと。

## 変異試験【実測】

実装ファイルを `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。実装ファイルは main と同一のまま。Postgres は PostgreSQL 17（`--encoding=UTF8`、`C` と `C.UTF-8` の DB）。

| 変異 | 赤（新しい歯） |
| --- | --- |
| NBSP・`\v`・`\f`・U+FEFF を空とみなさない | 純関数の歯で5本、経路の歯で NBSP の2本 |
| content が空のとき title を trim して返す | 1本 |
| 前置きのとき content を trim する | 1本 |
| 抽出に渡る本文だけ旧来の組み立てに戻す | 4本 |
| 全文フォールバックの本文だけ旧来の組み立てに戻す | 4本 |
| 保存する payload の `title` を trim する | 3本 |
| event の `name` に `trim().length > 0` を課す | 1本 |
| `omittingParams` が同じ message・cause の `TypeError` を投げ直す | 3本 |
| `params` を `[]` にする | 3本 |
| cause の pg エラーの `message` を変え、`detail` を消す | 3本 |
| `kinds: [""]` を断る | 1本 |
| `limit >= 2 ** 62` を断る | 2本 |
| `reachedLimit` を `>=`（Fake の events・recalls・jobs） | それぞれ1本 |
| `reachedLimit` を `>=`（Postgres の実消し・`dryRun`、InMemory） | 1本・1本・2本 |
| createMany・supersede で語彙を先に作る | それぞれ1本 |
| purge の後に count 0 のラベルを消す | 1本 |
| `upsertProposedLabels` を `.sort()` にする・逆順にする | それぞれ3本 |

## 縛っていないもの

- #1636 の名前順（経路をまたぐ順、purge・scrub の先取りの順）、ロックの取りすぎ、`COLLATE "C"` を外す変異、`FOR SHARE` で supersede の歯が3回に1回抜ける件は、Issue #1718 に残した。
- #1643: Fake の `recall_usages` を消さない変異は、Fake の usages を読む公開の口が無く観測できないので、縛っていない（Postgres では外部キーで落ちる）。Fake の保持設定版 `purgeExpiredEventsByRetention` が、今回変異を入れた共通の処理を通るかは確かめていない。
- #1649: cause の連鎖の一部だけに掛ける変異は、いまの入力では連鎖の2段目以降に params が載らず等価なので、縛っていない。
- #1650: `now` が壊れた Date のときの扱い（ADR 0514 が「見ない」と書く）は縛っていない。
- #1646: `title` が文字列でないとき・既定の分岐で空白だけの content を扱うときは、`observe()` から届かないので縛っていない。

## これが覆るとしたら

ADR 0517・0516・0514・0538・0511 の約束が変わるとき。とくに、空白とみなす文字の範囲、例外の同一性、tick の opts の上限、`reachedLimit` の定義、labels の語彙を作る時期と並びの約束。
