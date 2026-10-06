# ADR 0646: 09/29 にマージされた #1385・#1388・#1389・#1392・#1397・#1398・#1399・#1401・#1402・#1404・#1407・#1411・#1424・#1428・#1431・#1434・#1435 の確かめ直しで見つかった穴に歯を足す（tick の中断・consolidate/reflect の signal の配線・分割推論の並び・期限の積・claim key・材料の forget の見直し・反転の一文の既定ほか）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

クローンのマネージャー（mgr-5d638824）の依頼で担い手が書き、引き継いだマネージャー（mgr-0495eb46）が最新に直した。歯を書くと決めたのも、範囲を決めたのも、#1428・#1431 をいまの約束に当てると決めたのもクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手（またはマネージャー）の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0608](./0608-merged-0928-recheck-teeth-a.md)・[ADR 0613](./0613-merged-1001-recheck-teeth-b.md) と同じ）。
この PR は「PR B」で、PR A は ADR 0645（別の PR、同時に出る）である。

## 経緯

2026-09-29（UTC）にマージされた PR のうち、`@mnemora/core`・provider（`@mnemora/openai`・`@mnemora/anthropic`・`@mnemora/local-embedding`）・`@mnemora/testkit`・`examples/chat` に当たる17本を、約束ごとに足りない側とやりすぎ側の変異を入れて確かめ直し、どの歯にも捕まらない変異を拾った【実測】。結果は Issue #1733 に PR ごとにコメントとして残してある（#1385・#1388・#1389・#1392・#1397 は前任の担い手が確かめ済みで、歯が push されていなかったので、歯を書き直して実測し直した。#1435 は別の担当が先に確かめ直した［ADR 0603］歯を前提にして当てた）。#1402・#1407・#1411・#1428・#1431 には、最初の結果の後に追補がある（#1428・#1431 はいまの約束に当て直した結果）。#1411 の追補の歯も push されていなかったので、引き継いだ担当が書き直して実測し直した。

約束の出所は、各 PR 本文（`gh pr view`）・実装の TSDoc とコメント・その PR の ADR である【現物】。後の ADR で約束が変わっていないかは、各 PR の ADR 番号と関数名を `docs/decisions` から `grep` して、参照している後続の ADR の該当箇所を読んだ。すべての後続 ADR を通読したわけではない【判断】。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない。歯は `__tests__` に置く。
2. 歯を足す（試験だけ）。出所と置き場は次のとおり。実測では、穴の変異で赤になり、`cp` で戻して緑に戻ることまで見た。

### #1385（`RecalledMemory.score` の判別 union）

出所: PR 本文の「何が変わるか」3（`computeAffinity` の引数型が変わり、戻り値は変わらない）と、`examples/chat` の `recalled-score.ts` の TSDoc（`affinityMeasured: false` に当たったら握り潰さず投げる）。

- `packages/core/src/__tests__/consolidate.test.ts`: `affinityMeasured: false`（`AffinityUnmeasuredScore` の形）の `computeAffinity` は `-Infinity` で、どんな有限の `minAffinity` でも落ちる。
- `examples/chat/src/__tests__/recalled-score.test.ts`（新規）: `isAffinityMeasured`・`scoreTotalOrNull`・`requireMeasuredTotal`（測っていなければ投げる）・`assertAffinityMeasured`。

### #1389（testkit の BigInt の検査）

出所: PR 本文（`actor`・`meta` の BigInt を、入れ子・配列の要素も、状態を書き換える前に拒む）。置き場: `packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts`。配列の要素が入れ子（オブジェクト・配列）で、その奥に BigInt があっても拒む。

### #1392（連想段の `explain.stages` の記録）

出所: PR 本文（アンカーは在ったが検索結果が0件でも `executed: true` のまま。`detail` は件数の書き写し）。置き場: `packages/core/src/__tests__/recall-explain-stages-association.test.ts`。

- アンカーは在ったが連想の検索結果が0件の run は、`association(executed: true)` のまま。
- 連想の候補が席（`maxCount`）より多いとき、`hits` は見つけた件数、`selected` は席に着いた件数。

### #1397（local-embedding の分割推論）

出所: PR 本文の「変更点」2・3。置き場: `packages/local-embedding/src/__tests__/max-batch-size.test.ts`。

- `prefix` を設定していても、分割した全チャンクの全件に `prefix` が付いて渡る。
- 連結の順序は入力の順序のまま。
- `index` を持たない失敗（素の Error・`unknown_input_limit`）は、2つ目以降のチャンクでも包み直さずそのまま投げる。

### #1398（`AbortSignal` の配線）

出所: PR 本文と ADR 0359 決定5（abort されたらどのジョブも `fail()` しない。consolidate/reflect は内部の `recall()`（`{ seedMemoryId }`・`{ query }` の両形）と LLM 呼び出しの両方に `signal` を通す）。後の ADR 0428・0445 は広がっただけ。置き場: `packages/core/src/__tests__/abort-signal.test.ts`（6件）。

- 既に abort 済みなら、provider を呼ばない種類（対応していない kind）のジョブも `fail()` で焼かずに残す。
- `consolidate({ query })`・`reflect({ query })`・`reflect({ seedMemoryId })` は、クエリの埋め込み待ち中の abort で reject し、`embed` に `signal` が渡る。
- `tick()` の `consolidate`・`reflect` ジョブは、処理中（種の近傍探索の埋め込み待ち）の abort で `tick()` が reject し、ジョブは `fail()` されず claim されたまま残る。

### #1402（outbox の `lastError` から drizzle の params を落とす）

出所: PR 本文（最初の出現で切る。SQL の文は残す）と `omitDrizzleParams` の TSDoc（目印が見つからなければ何もしない）。置き場: `packages/core/src/__tests__/tick-last-error-redacts-params.test.ts`（2件）。

- params の値の中に `\nparams: ` が含まれていても、最初の出現で切り、値の前半が残らない。
- `params: ` が改行の直後に付いていない文面（SQL の中の文字列など）は、落とさず残す。

### #1404（`revision` を固定した読み込み）

出所: PR 本文（`revision` を `env.remotePathTemplate` に埋め込み、根を `<根>/<revision>` に分ける。読み込み失敗のメッセージの「消せば取り直す場所」も同じ根の下を指す）。置き場: `packages/local-embedding/src/__tests__/revision-env-swap.test.ts`（2件）と `load-failure-cache-place.test.ts`（1件）。

- 既定のキャッシュの値が空文字なら、根が無いのと同じに扱う（`''` の下に `<revision>` を作らない）。
- 利用者が変えた template に `{revision}` が複数あっても、すべて置き換える。
- `revision` を渡したときは、消せば取り直す場所も `<根>/<revision>` の下を名指す（`cacheDir` あり・なし）。

### #1407（consolidate/reflect の期限の積）

出所: PR 本文（材料の区間の積。両端とも `null` の材料は制限にならない）。置き場: `packages/core/src/__tests__/consolidate.test.ts`。期限の無い材料が、期限の在る材料より後ろに並んでいても（前でも）、無い側は制限にならない。

### #1411（`event.data`・`document.title` を抽出へ渡す opt-in）

出所: PR 本文の仕様2（未指定・`false` では payload にこのキー自体が増えない）。置き場: `packages/postgres/src/__tests__/observe-event-data-document-title-extract-opt-in.postgres.test.ts`（testkit の InMemory・Postgres の2脚）。`false` を明示しても、payload に `extractData`・`extractTitle` のキーが増えず、プロンプトにも入らない。

追補: 出所は `observationPayloadText` の TSDoc（`title` が空でない文字列のときだけ前置きにする）。置き場: `packages/core/src/__tests__/observation-text-blank-title-not-prefixed.test.ts`。`title` が数・`null`・未定義・真偽値・配列・オブジェクトなら前置きにしない。

### #1428（LLM 待ちの間に forget された材料）

出所: `assertNotForgottenForUpdate` の TSDoc（`tenant_id` の絞り込みも同じ `WHERE` に含める）と、`opts.abortIfForgotten` の契約（forgotten の記憶だけを理由に打ち切る）。置き場: `packages/postgres/src/__tests__/` の新規2ファイル。

- `abort-if-forgotten-tenant-scope.postgres.test.ts`: 別のテナントの forgotten な id を渡しても、`SourceMemoryForgottenError` にならず書ける。
- `abort-if-forgotten-only-forgotten.postgres.test.ts`: `archived` の記憶の id を渡しても、`SourceMemoryForgottenError` にならず書ける（`contested` は `updateStatus` で作れないので `archived` で縛った）。

追補: いまの約束（下の「約束の変わり方」）に6つの変異を当て、すり抜けは無かった。歯は足していない。

### #1431（claim key の一致が2件以上のとき）

出所: いまの約束（下の「約束の変わり方」）。`relationStore` を配線しない呼び出しでは evidence だけを積み、`unresolved_conflict` は一致した全員の id を運ぶ。配線した呼び出しでも、群の書き込みが `contested_group` にならなければ群を名乗らず同じ形に戻る。置き場: `packages/core/src/__tests__/`。

- `claim-key-sequential-arrival.test.ts`（既存の `it` に検査を足した）: 3件目・4件目の `matchMemoryIds` は一致した全員の id である。
- `claim-key-group-write-fallback.test.ts`（新規、1件）: `markContestedGroup` が CAS 競合になると、`unresolved_conflict` になり evidence が積まれ、3件目は `active` のまま。

### #1434（矛盾候補の印の非対称化と一文の追記）

出所: PR 本文の案3（実際に非対称文面が出た回だけ system 文に一文を足す。`runAnswerCase`・`runAnswerBench` の既定は `true`）と、`hasContestedCorrectionWording` を描画の途中の分岐が返す構造で決めること。置き場: `examples/chat/src/__tests__/`。

- `answer-contested-guidance-default.test.ts`（新規、3件。DB・API 不要。偽の Runtime が非対称文面の出る recall を返す）: 引数を省くと一文が足され naive 側は変わらない・`false` を明示すると足されない・`runAnswerBench` も既定で足される。
- `issue-1430-contested-correction.test.ts`: 非対称文面の対と、矛盾関係の無い記憶が同じ recall に混ざっていても `hasContestedCorrectionWording` は `true`。

### #1435（reextract が版を跨いで退けた記憶を見る）

出所: PR 本文（`listBySourceObservationAllVersions` は版も `status` も問わず返す。テナント分離）と ADR 0521 決定1（`listBySourceObservation*` は大文字の UUID でも同じ行を指す）。ADR 0521 自身が、この口は store を直接大文字で呼んだ突き合わせを取っていないと書いていた。置き場: `packages/postgres/src/__tests__/list-by-source-observation-all-versions-id-spelling.postgres.test.ts`（新規、testkit の InMemory と Postgres の2脚）。`observationId` を大文字で渡しても、小文字で渡したときと同じ記憶を返す。

### 歯を足さなかった PR

#1388・#1399・#1401・#1424 は、歯が要るすり抜けが無い、または約束が決まっていない（下の「外したもの」）。

3. ほかの ADR には追記しない。

## 実測【実測】

PostgreSQL 17（`--encoding=UTF8 --locale=C.UTF-8`、自分専用のインスタンス）。対象ファイルを `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して緑に戻ることまで見た。DB が要る試験（#1411・#1428・#1431・#1435）は `DATABASE_URL` を付けて走らせた。`@mnemora/postgres` の適合テストは、`-t` で絞ると名前に目印の無い歯（「クロステナントの Memory は返さない」など）が抜けるので、変異ごとにファイル全体を走らせた。local-embedding の試験は注入した偽の pipeline・`vi.mock` した `@huggingface/transformers` だけで走らせ、モデルは取得していない。

走らせた変異の数と、どの歯にも捕まらなかった数（下の等価を含む。数え方は各コメントの見出しに従う）:

| PR    | 走らせた変異                  | すり抜けた                    | 足した歯                                                             |
| ----- | ----------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| #1385 | 8（前任）                     | 3（1つは等価）                | 2か所（`consolidate.test.ts` 1件・`recalled-score.test.ts` 新規5件） |
| #1388 | 7（前任）                     | 0                             | なし                                                                 |
| #1389 | 8（前任）                     | 1                             | 1件                                                                  |
| #1392 | 7（前任）                     | 3                             | 2件                                                                  |
| #1397 | 10（前任）                    | 4（1つは等価）                | 3件                                                                  |
| #1398 | 24                            | 6（ほかに歯が無かった1）      | 6件                                                                  |
| #1399 | 6                             | 0                             | なし                                                                 |
| #1401 | 5                             | 0                             | なし                                                                 |
| #1402 | 3（ほか2は読んだだけ）＋追補9 | 2                             | 2件                                                                  |
| #1404 | 7                             | 3                             | 3件                                                                  |
| #1407 | 5＋追補2                      | 1                             | 1件                                                                  |
| #1411 | 4＋追補5                      | 3（うち2つは同じ1本で塞ぐ）   | 2か所（1件・2脚と `it.each` 6形）                                    |
| #1424 | 3                             | 1（等価）                     | なし                                                                 |
| #1428 | 6＋追補6（いまの約束）        | 2                             | 2ファイル（各1件）                                                   |
| #1431 | 14＋追補5（いまの約束）       | 2                             | 2件                                                                  |
| #1434 | 7                             | 4（1つは等価、1つは一部のみ） | 4件                                                                  |
| #1435 | 5                             | 1                             | 1件（2脚）                                                           |

#1385・#1388・#1389・#1392・#1397 の前任の変異は、前任のコメントの表のまま引用している（再走したのは、すり抜けた変異だけ）。#1411 の追補の歯は、引き継いだ担当が書き直し、`title` を `String()` で文字列に直す変異で4件（数・真偽値・配列・オブジェクト）が赤、`cp` で戻して `cmp` で同一、22件が緑であることを実測した。

## 外したもの【判断】

等価な変異（走らせて緑で、理由も確かめた、または読んだ）:

- #1385: `toRecalledScore` の判別を `affinityMeasured === true` にする。runtime は常に `defaultScoringStrategy` で真偽値を入れるので、未定義は到達しない（前任）。
- #1397: 分割の境目 `length <= max` を `<` にする。ちょうど max 件のとき、pipeline に届く内容・戻り値は同じ（前任）。
- #1398: 読み込みの後の `signal.throwIfAborted()` を外す。直前の `runAbortable` と、直後の「推論の後」の確認に挟まれた冗長な確認で、観測できる差はマイクロタスクの順序に頼る（abort 済みなのに推論を1回走らせるか）だけ。歯にすると脆い。
- #1402: 埋め込みジョブの「`failed` の書き込み自体の失敗」の message を `describeFailure` を通さずに組み立てる。外側の `describeFailure` が最初の目印以降を落とすので、最終の `lastError` は同じ。
- #1424: `detectClaimKeyContested` の「検出中の Memory の `sourceObservationId` が `null` なら何も除かない」の分岐を外す。`createMemoriesFromCandidates` が observation から作る Memory は常に非 `null` で、store が作った直後の Memory の値を落とさない限り到達しない。
- #1434: 記録順が同じなら非対称にしない分岐を外す。`recordedOrderById` は順位を重複しない整数で振るので、2件の順位は必ず違う。

逆になったので PR 本文の約束には当てなかったもの（既存の歯がいまの約束を縛っている）:

- #1399: PR 本文の「Anthropic の `z.record` は今までどおり送る」は、ADR 0360 の追記（2026-09-30）が逆にした（いまは Anthropic も `z.record` を深さを問わず送る前に落とす）。
- #1401: PR 本文の「`revision` を `main` 以外にすると届かない」は、ADR 0365 が逆にした。

約束が決まっていないので歯を書かなかったもの:

- #1398: 変異「`runAbortable` の遅れた settle を捨てる分岐」は、Promise の二重決着が無視されるので等価。openai・anthropic が実物の SDK で `signal.reason` を返すこと（`abort-reason-real-sdk.test.ts`）には変異を当てていない（localhost の擬似サーバを立てるため）。
- #1402: PR 本文の「塞がらない経路」（openai の拒否の文面・pg の型変換エラーの値）は、塞がないと書いてあるだけで、歯にすると今の振る舞いを約束に格上げする。
- #1424: 同上の `null` の分岐（上の等価）。

走らせていないもの【未確認】: #1399・#1401・#1404 の本物のモデル・実 API の live 歯。#1434 の実 API での測定（n=5・gpt-4o-mini）。#1428 の `examples/chat`・`scripts` の追従（基準値 JSON）。

## 約束の変わり方【判断】

どの約束がどの ADR でどう狭まったか（1件1行）。狭まった2本は、クローンの判断でいまの約束に当てた。

- #1428: PR 本文「forgotten/purged 以外の理由で CAS が破れたら部分成功」→ ADR 0420 で、材料が superseded（ADR 0544 以後は contested も）になった・eligible の全件が active でない・全件が CAS に弾かれたときは打ち切る、に狭まった（1件でも通れば部分成功は残る）。
- #1431: PR 本文「一致が2件以上なら evidence だけを積む」→ ADR 0327 の段階B（実装は ADR 0381）で、`relationStore` を配線しない呼び出しに狭まった（配線した呼び出しは群を書き、群にならなければ evidence に戻る）。配線の有無の両方に当てた。

## 先の確かめ直しと重ならないように選んだもの【判断】

別の担当が先に確かめ直した ADR のどの約束と重ならないように選んだか（1件1行）。

- #1435: ADR 0603 は「退けたかを最新の `superseded` イベントの理由で決める」を縛った。ここでは `listBySourceObservationAllVersions` の `observationId` の綴り（大文字でも同じ記憶を返す）だけに当てた。
- #1431: ADR 0602 は `relationStore` を配線して群を書く経路（解消での関係の削除範囲・段3・`attributes`・合併と人数の境界・対の片割れ）を縛った。ここでは `unresolved_conflict` が運ぶ id と、群の書き込みが弾かれたときに evidence へ戻ることだけに当てた。

## 直しが要りそうなもの（実装は変えていない）【判断】

- #1398: `tick()` の「対応していない kind」の分岐の直前のコメントは「この分岐は provider を呼ばないため abort の対象にしない」と書くが、実際にはループ頭の確認がこの分岐より前にあり、abort 済みならこの分岐へ入らない（ADR 0359 の「どのジョブも `fail()` しない」はこちらと一致する）。コメントの言い回しが紛らわしいだけ。

## 縛っていないもの

- #1428 の新しい歯は `createMemoryWithOutbox` だけに足した。`supersedeWithNewMemories`・`createMemoriesWithOutboxAndEvents` も同じ共通関数を通る。いまの約束の変異のうち superseded の読み直しを外す2つは、core の Fake の歯では捕まらず、testkit・Postgres の歯だけが捕まえる（実装は1か所なので足していない）。
- #1434 の新しい歯は偽の Runtime で、実 API・実モデルは使わない。
- 全テストは走らせていない。名指しのファイルだけである。

## これが覆るとしたら

`abort` を既存の失敗経路に倒さない・どのジョブも `fail()` しない（ADR 0359）、`consolidate`/`reflect` の材料の区間の積（ADR 0368）、`extractData`・`extractTitle` の「`false` では payload にキーを足さない」（ADR 0369）、`abortIfForgotten` が自テナントの forgotten だけを見る（ADR 0375）、一文の追記の既定オン（ADR 0379）、`listBySourceObservationAllVersions` の大文字の UUID の扱い（ADR 0521）が変わるとき。
