# ADR 0592: マージ済みの PR（#1696〜#1699）を確かめ直して見つかった歯の穴を、試験だけで塞ぐ

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-587fc473 の指示による）が書いた。決めたのはクローンとマネージャーで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。ただし下の「#1699 の `createdAt`」の1点は、オーナー側の判断として伝えられたものを書き写している。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手またはクローンの判定、【未確認】は確かめていないこと。

## 背景【実測】

マージ済みの PR（#1696・#1697・#1698・#1699。ADR 0583〜0588 の系）の変異試験を外から当て直したところ、**既存の歯がどれも赤にしなかった変異**が見つかった。本 ADR は、実装を1行も変えず、試験だけでそれを塞ぐ。

## 何を足したか【現物】

| 印     | 元                                                                            | 足した歯（ファイル: it）                                                                                                                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1     | #1697 / [ADR 0585](./0585-digest-band-max-entry-chars-nan.md)                 | `packages/core/src/__tests__/digest-band.test.ts`: `maxEntryChars: +Infinity は上限なし——digest を切らず、truncated も立てない`                                                                                                                                                                               |
| T2     | 同                                                                            | 同ファイル: `maxEntryChars: NaN は band の2件目以降でも効く——全件の digest が空になり truncated: true`                                                                                                                                                                                                        |
| T3     | 同（M11）                                                                     | 同ファイル: `もとの digest が空文字の候補も、NaN は負数（-5）と同じ結果になる（truncated: true）`                                                                                                                                                                                                             |
| T4     | #1696 / [ADR 0584](./0584-adr-0574-teeth-holes-controls.md) 約束 D            | `packages/postgres/src/__tests__/store-superseded-by-checks-controls.postgres.test.ts`: `位置（P12 の pair・group の陽性対照）: 壊れた id でも形が正しければ、RangeError ではなく memory not found の Error`（既存の3実装の脚に乗る。pair の1件目・2件目、group の先頭・末尾）                                |
| T5     | 同                                                                            | `packages/core/src/__tests__/fake-superseded-by-checks-controls.test.ts`: `updateStatus: 形が正しい存在しない id は、RangeError ではなく memory not found の Error`（DB なし）                                                                                                                                |
| T6     | #1699 / [ADR 0587](./0587-adr-0577-time-stub-mixed-resend-updatedat.md) の隣  | 3実装の脚。core の Fake: `fake-supersede-mixed-resend-updated-at.test.ts`、testkit の InMemory: `in-memory-supersede-updated-at.test.ts`、Postgres: 新ファイル `store-supersede-created-at.postgres.test.ts`。いずれも `置き換えで updatedAt は…進むが、createdAt は作ったときのまま（後から書き換わらない）` |
| T7a〜c | #1698 / [ADR 0586](./0586-omit-params-cause-chain-and-preread-stack-teeth.md) | `packages/postgres/src/__tests__/omit-params.test.ts`: 循環する `cause` でも止まる／凍結された例外は投げずにそのまま返す（cause の段も続けて書き換える）／冪等                                                                                                                                                |
| T8a・b | #1698 の core 側                                                              | 新ファイル `packages/core/src/__tests__/failure-description-omit-params-teeth.test.ts`: 循環する `cause`（自己参照も）でも止まる／凍結された例外は投げずにそのまま返す                                                                                                                                        |

- **循環の歯は `node:vm` の `timeout` で打ち切る**【判断】。歯止め（`seen`）を外すと無限ループになり、同期のループは vitest の時間切れでは止まらない（テストランナーごと固まる）。`vm.runInNewContext("omitParamsFromError(a)", …, { timeout: 2000 })` なら、同期のループでも約2秒で `ERR_SCRIPT_EXECUTION_TIMEOUT` になり、赤として観測できる【実測: 変異を入れた回は 2007ms・2012ms で落ちた】。
- T3 の期待は、負数（-5）の現物の挙動に合わせた。空文字でも `0 > -5` が真になり `truncated: true` が立つ。NaN も同じにそろえる【実測】。

## #1699 の `createdAt` は、オーナー側の判断で不変条件として縛る【判断】

`supersedeWithNewMemories` が置き換えた古い記憶の `createdAt` が変わらないことには、明文の約束が無い。**オーナー側が「作成時刻が後から書き換わらないのは当然の不変条件として縛ってよい」と判断した**ので、T6 で3実装（core の Fake・testkit の InMemory・Postgres）を縛った。`updatedAt` が進む（壁時計。[ADR 0566](./0566-fake-outbox-opts-now-controls.md) A の約束）ことは陽性対照として同じ歯に置いてある。

## 足さなかったもの【判断】

- **CAS で弾かれた行の `updatedAt`**: 約束が無く、判断待ち。歯にすると、決まっていない仕様を固めてしまう。
- **#1700 の `externalId`**: 既存の歯で捕まる（変異を入れると既存の歯が赤になる）ので、足さない。
- core 側の `omitParamsFromError` の冪等: 既存の歯（`standalone-functions-omit-params.test.ts`）があるので足さない。

## 実測: 変異 → 赤 → 戻す（cmp）→ 緑【実測】

各変異は、対象ファイルを `/tmp/mgr-587fc473-teeth-bak/` に `cp` で退避し、Edit で入れ、`cp` で戻して `cmp` で一致を確かめた。名指しの1ファイルだけを走らせた。

| 印          | 変異                                                                                                | 赤（落ちた it）                                                                     | 戻した後                                                         |
| ----------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| T1          | `digest-band.ts` の NaN 判定に `\|\| maxEntryChars === Infinity`                                    | `+Infinity は上限なし…` のみ                                                        | 28 本緑                                                          |
| T2          | NaN の処理を `&& band.length === 0` で1件目だけに                                                   | `NaN は band の2件目以降でも効く…` のみ                                             | 28 本緑                                                          |
| T3          | 空文字の digest で NaN のときは `truncated` を立てない                                              | `もとの digest が空文字の候補も、NaN は負数…` のみ                                  | 28 本緑                                                          |
| T4（pair）  | `memory-store.ts` の pair の `!isUuidLike` の throw を `RangeError` に                              | Postgres 脚の `位置（P12 の pair・group の陽性対照）…` のみ（他の脚と他の it は緑） | 54 本緑                                                          |
| T4（group） | 同 group 側                                                                                         | 同上                                                                                | 54 本緑                                                          |
| T5          | `runtime-fakes.ts` の `updateStatus` の not found を `RangeError` に                                | `updateStatus: 形が正しい存在しない id は…` のみ                                    | 24 本緑                                                          |
| T6          | 3実装で `updatedAt` と一緒に `createdAt` も `new Date()`（Postgres は SQL に `created_at = now()`） | 3ファイルとも、`…createdAt は作ったときのまま…` のみ。**赤3回**                     | **緑3回**（別々のコマンド。core 3本・testkit 2本・postgres 1本） |
| T7a         | `omit-params.ts` の `!seen.has(current)` を外す                                                     | `cause が循環していても止まり…`（2007ms でタイムアウト）                            | 8 本緑                                                           |
| T7b         | `catch` で再 throw                                                                                  | 凍結された例外の2本                                                                 | 8 本緑                                                           |
| T7c         | 印済みの検査を `false &&` で外す                                                                    | `冪等: 2回掛けても1回と同じ…`                                                       | 8 本緑                                                           |
| T8a         | `failure-description.ts` の `!seen.has(current)`（`omitParamsFromError` の側）を外す                | 循環の2本（約2秒でタイムアウト）                                                    | 4 本緑                                                           |
| T8b         | `catch` で再 throw                                                                                  | 凍結された例外の2本                                                                 | 4 本緑                                                           |

T6 は時刻を比べる歯なので、赤を3回、戻した後の緑を3回、それぞれ別のコマンドで走らせた。Postgres の脚は、`now()` を偽の時計で動かせないので、古い記憶の `created_at` を2020年へ直接書き換えてから置き換える（置き換えが `now()` を書けば、必ず違う値になる）。

## 直さないもの【判断】

- 実装（`digest-band.ts`・`memory-store.ts`・`runtime-fakes.ts`・`in-memory-memory-store.ts`・`omit-params.ts`・`failure-description.ts`）は1行も変えない。
- 他の元 PR の、まだ当て直していない変異は洗っていない【未確認】。
- #1700 を ADR 0583〜0588 のどれに結びつけるかは、確かめていない【未確認】。

## CHANGELOG と migration【判断】

変えない。試験と ADR だけで、出荷物ではない。

## これが覆るとしたら

CAS で弾かれた行の `updatedAt` に約束が決まったとき（別の ADR で縛る）。`createdAt` の不変条件を、オーナーが約束として文書へ書いたときは、本 ADR の「判断」ではなく文書の側が根拠になる。
