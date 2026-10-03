# ADR 0588: ADR 0578 の歯の穴（生き残り4本と「たまたま捕まった」2本）を、対照の歯で塞ぐ

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（担い手。マネージャー mgr-4ba236a4 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 背景【実測】

[ADR 0578](./0578-core-fake-returns-copies-for-remaining-writers.md)（PR #1690）を書いた側が、マージ後に外から変異を当て直した。結果は、**生き残った変異が4本**と、**捕まってはいたが「たまたま」だったものが2本**。本 ADR は、`runtime-fakes.ts` を1行も変えず、歯だけで塞ぐ。

| 印  | 変異（`runtime-fakes.ts`）                                                                    | 前の状態                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `fakeSnapshot`（`get` が通る）が `undefined` の欄を `null` に揃える                           | `recall-pipeline.test.ts` の2本（subjectId・occurredAt の undefined）が赤にならない。この変異を入れたまま `recall-runtime.ts` の `?? null` を外しても緑だった |
| S2  | 入力の `claimKey: null` を `{}` にする（`fakeSnapshot(input.claimKey ?? null)` の `null` 側） | 0578 の歯は赤にならない                                                                                                                                       |
| S3  | `reinforce` の `at` の写しを秒に丸める                                                        | 0578 の歯の時刻が `.000` で赤にならない                                                                                                                       |
| S4  | `createObservationWithOutbox` の再送（`created:false`）が別の id の写しを返す                 | 0578 の歯は赤にならない（`fake-idempotent-create.test.ts` などは赤）                                                                                          |
| F1  | `reinforce` の返り値を `Object.freeze` する                                                   | 「たまたま」: `scribble` が凍結した値への書き込みで投げて落ちただけで、凍結そのものは見ていなかった                                                           |
| F2  | `reinforce` の返り値を JSON 往復にする                                                        | 「たまたま」: 返り値の歯は緑のまま、別の対照だけが赤                                                                                                          |

## 決定【判断】

- **S1**: `recall-pipeline.test.ts` の2本で、`liveRowForTest` で `undefined` を書いた後に `stores.memoryStore.get(ctx, id)` の `subjectId` / `occurredAt` が `toBeUndefined()` であることを足し、前提を明示した。Fake が undefined を null に揃えると、recall は `?? null` を通らずに緑になる（歯が空振りする）ので、その前提を歯の側で縛る。
- **S2**: 新しいテストファイル `fake-null-claimkey-stays-null.test.ts` に、`claimKey: null` で作った行が `createMemory`・`createMemoryWithOutbox`（新規・再送）の返り値・`liveRowForTest`・`get` のすべてで `null` のままであることを置いた。**ファイルの途中の describe に足さず新しいファイルにした理由**: `fake-returns-copies-for-writers.test.ts` で claimKey の入力を扱う describe は最後の1つ（「入力の claimKey も、保存するときに写される」）だけで、そこは開いている PR #1695 が末尾に足している。途中に claimKey 入力の居場所は無く、無理に別の describe に混ぜるより新ファイルのほうが行がぶつからず、意味も揃う。
- **S3**: `fake-returns-copies-for-writers.test.ts` の「状態を書く口」に、`.123` の ms を持つ `at` が `lastReinforcedAt` にそのまま入り、渡した `at` を後から書き換えても変わらない歯を足した。
- **S4**: 同ファイルの Observation 側（`createObservationWithOutbox` の歯）に、再送の `observation.id` が最初の id と同じ、を足した。Memory 側（`createMemoryWithOutbox`）の歯と揃う。
- **F1・F2**: 同ファイルの「状態を書く口」の対照に、`reinforce` の返り値（書いた場合・no-op の両方）が凍結されておらず（`tags`・`attributes`・`claimKey`・`provenance` も）、Date は Date のまま、を直接見る歯を1本足した。

## 実測【実測】

各変異は、対象ファイルを `/tmp/mgr-4ba236a4-wt6-orig/` に `cp` で退避し、Edit で入れ、`cp` で戻した。戻した後は同じ歯が緑に戻ることを確かめ、`git status --porcelain` で `runtime-fakes.ts` と `recall-runtime.ts` が変わっていないことを見た。

| 印  | 変異を入れたとき                                                                                                                                                       | 戻したとき     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| S2  | `fake-null-claimkey-stays-null.test.ts` の2本（`createMemory`・`createMemoryWithOutbox`）が赤。0578 の歯（`fake-returns-copies-for-writers.test.ts`、47 本）は緑のまま | 3 本緑         |
| S3  | 新しい歯が赤                                                                                                                                                           | 緑（下の回数） |
| S4  | `createObservationWithOutbox: observation（新規・既存の両方）と jobs を…` が赤                                                                                         | 緑             |
| F1  | 新しい対照が赤（ほかに `reinforce: 書いた返り値…`・`reinforceMany: …` の既存の歯。no-op 側だけの凍結でも対照は赤）                                                     | 緑             |
| F2  | 新しい対照が赤（ほかに S3 の歯と `setEmbeddingStatus・reinforce が書いたことは…`）                                                                                     | 緑             |

**S1 の組み合わせ**（`recall-pipeline.test.ts` の 2 本を名指しで走らせた）:

|       | 変異                                                | 結果                                                                     |
| ----- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| (i)   | S1 の変異だけ（`recall-runtime.ts` は無変異）       | 2 本とも赤（`expected null to be undefined`。前提の assertion で落ちる） |
| (ii)  | S1 の変異 + `recall-runtime.ts` の `?? null` を外す | 2 本とも赤（同じ assertion）                                             |
| (iii) | `?? null` を外すだけ（Fake は無変異）               | 2 本とも赤（`expected undefined not to be undefined`。従来どおり）       |
| (iv)  | 全部戻す                                            | `recall-pipeline.test.ts` 全体で緑（139 本）                             |

S1 は (ii) で、**前提の assertion が先に赤にする**ため、`?? null` が外れていることには届かない。ただ (i) で赤になる点が、以前すり抜けていた「Fake が揃えたまま緑」を塞いでいる。

**S3 の繰り返し**（時刻の歯なので、毎回別の起動で1回ずつ走らせた）: 変異を入れて 5 回走らせ、**5 回とも赤**。戻して 5 回走らせ、**5 回とも緑**（`fake-returns-copies-for-writers.test.ts` 48 本）。

**最後に**: `fake-returns-copies-for-writers.test.ts`・`fake-null-claimkey-stays-null.test.ts`・`fake-isolates-caller-mutation.test.ts`・`recall-pipeline.test.ts` を走らせ 214 本緑。

## 直さないもの【判断】

- `runtime-fakes.ts` と `recall-runtime.ts` は変えない（歯だけで塞ぐ）。
- `fake-returns-copies-for-writers.test.ts` の最後の describe とその後ろ（PR #1695 が足している）には手を入れない。
- S2 の新しいファイルの `findActiveByClaimKey` の1本（null の行が検索に出ない）は、今回の変異では赤にならない。claimKey が null の行の扱いを縛る補足で、変異で確かめた歯ではない【未確認】。
- 他の口の「たまたま捕まった」変異の洗い直し（`reinforce` 以外の凍結・JSON 往復）はしていない【未確認】。

## CHANGELOG と migration【判断】

変えない。テスト専用で出荷物ではない。

## これが覆るとしたら

#768 のコメント2の方針が変わり、Fake を適合テストに通すようになったとき（本 ADR の歯は適合テストに吸収される）。
