# ADR 0613: 10/01 にマージされた #1553・#1554・#1565・#1574・#1575・#1576・#1577・#1578・#1579・#1584・#1586・#1588・#1594・#1597 の確かめ直しで見つかった穴に歯を足す（chat の embed 失敗の画面と終了コード・訂正の候補の綴り・記録器の参照・全イベントの指し先・上限の境目・除外の大文字小文字）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャー（mgr-fc93a777）の依頼で、担い手が書いた。歯を書くと決めたのも、範囲を決めたのもクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手（またはマネージャー）の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0608](./0608-merged-0928-recheck-teeth-a.md)・[ADR 0611](./0611-merged-0928-recheck-teeth-b.md) と同じ）。
この PR は「PR B」で、PR A は ADR 0612（別の PR、同時に出る）である。

## 経緯

マネージャーが、2026-10-01（UTC）にマージされた14本の PR を、約束ごとに足りない側とやりすぎ側の変異を入れて確かめ直し、どの歯にも捕まらない変異を拾った。#1586 は core のテスト用 Fake `runtime-fakes.ts` だけを変えた PR である。変異は、すべて担い手が手元で入れ、既存の歯がすり抜けるか、新しい歯でだけ赤くなるかを実測した【実測】。

約束の出所は、各 PR 本文（`gh pr view`）・実装の TSDoc とコメント・その PR の ADR である【現物】。後の ADR で約束が変わっていないかは、各 PR の ADR 番号を `docs/decisions` から `grep` して、参照している後続の ADR の該当箇所を読んだ。すべての後続 ADR を通読したわけではない【判断】。
結果は Issue #1726 に PR ごとにコメントとして残してある（確かめ直しの記録）。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない。歯は `__tests__` に置く。
2. 歯を足す（試験だけ）。出所と置き場は次のとおり。

### #1553（chat が embed の失敗を言う）

出所: PR 本文の BK-1（`ingestConversation` が drain の結果を返す。`totalFailed > 0` なら標準エラーへ警告し `process.exitCode = 1`。打ち切らず recall の表示まで進む）と `cli.ts` のコメント。分割推論のチャンクの合間の abort（BJ-2）は既存の歯が捕まえた。

- `examples/chat/src/__tests__/ingest-conversation-drain-result.test.ts`（DB 不要）: 偽の Runtime で、`totalFailed` と `totalProcessed` を返すこと。
- `examples/chat/src/__tests__/chat-embed-failure-exit.postgres.test.ts`: 手元の HTTP スタブで埋め込みの3回目だけ 400 にし、子プロセスで `cli.ts chat` を走らせる。1件だけの失敗で警告・「失敗 1 件」・終了コード 1・recall の表示まで進むこと。陽性対照は失敗0件で警告なし・終了コード 0。

### #1554（`applyCorrection`）

出所: PR 本文の「直したもの」1〜3と「断る入力は増えていない」、`applyCorrection` のコメントと `ApplyCorrectionResult` の TSDoc。置き場: `packages/core/src/__tests__/apply-correction-candidate-spelling.test.ts`（Fake の `memoryStore.get` だけを差し替える）。

- 大文字小文字だけ違う候補が2件以上のときは、store が同じ記憶と言っても候補外。
- store が渡された綴りに別の記憶を返すときは候補として扱わず、何も書かない。store が `null` を返すときも同じ。
- 候補外の指名は、`winnerId` がどちらの id でもなくても例外にせず `not_a_candidate`（勝者の検査は候補だと決まってから）。対照: 候補に居る指名なら `RangeError` で、何も書かない。

### #1565（testkit の provider の fake・カセット）

出所: PR 本文 A-1〜A-8 と、各クラスの TSDoc。置き場: `packages/testkit/src/__tests__/provider-fakes-align-edges.test.ts`。

- `SeededEmbeddingProvider`: delegate の `provider` だけが種と違うと構築で落ちる。
- `CassetteRecorder`: 2回目以降の記録で `provider` だけが違うと落ちる。
- 成分が `±Infinity` のベクトルを、`assertCassette`・`RecordedEmbeddingProvider.embed`・`RecordingEmbeddingProvider` の3か所で拒む。
- `RecordingEmbeddingProvider`: 並列に同じテキストを呼んだ2者・記録・delegate の配列が互いに別（返り値の書き換えと、delegate が後から自分の配列を書き換えることが他へ漏れない）。

### #1574（`InMemoryMemoryStore` の `event.memoryId`）

出所: PR 本文（「`NewMemoryEvent` を受ける書き込み口の全部で、書く前に確かめる」「断ったら何も書かない」）と `assertEventTargetOwn` の TSDoc・呼び出し箇所のコメント。置き場: `packages/testkit/src/__tests__/in-memory-event-target-every-event.test.ts`。

- `resolveContestedPair` の2つ目のイベントが別テナントを指しても断る。
- `markContestedGroup`・`resolveContestedGroup` は、先頭でないメンバー（1番目・2番目）のイベントが別テナントを指しても断る。何も書かない。

### #1577（core の `FakeMemoryStore` の `event.memoryId`）

出所: PR 本文と `FakeMemoryStore.assertEventTargetOwn` の TSDoc。置き場: `packages/core/src/__tests__/fake-event-target-every-event.test.ts`。#1574 の3つと同じ入力を Fake に当てる（`markContestedPair` の2つ目は既存の歯が捕まえるので入れていない）。

### #1578（失敗の説明の上限）

出所: PR 本文と `capDescribeJobFailureLength` の TSDoc（上限を超えたら切り、印を付ける）。置き場: `packages/core/src/__tests__/failure-description-cap-boundary.test.ts`。上限ちょうど（4096字）は切らず印も付けない。1字超えたら上限の長さで切り、元の長さを印に載せる。

### #1594（`excludeMemoryIds`）

出所: `excludeMemoryIds` の TSDoc（「大文字小文字は無視して突き合わせる」）。置き場: `packages/core/src/__tests__/correction-candidates-exclude-case.test.ts`（Fake の `getMany` と `vectorStore.search` を差し替えて、返す id を大文字にする）。store が大文字の id を返すときも、小文字で渡した除外が効く。対照の1本つき。

### 歯を足さなかった PR

#1575・#1576・#1579・#1584・#1586・#1588・#1597 は、歯が要るすり抜けが無い、または約束が決まっていない（下の「外したもの」）。

3. ADR 0496 など、ほかの ADR には追記しない。

## 実測【実測】

PostgreSQL 17（`--encoding=UTF8 --locale=C.UTF-8`、自分専用のインスタンス）。対象ファイルを `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめた。postgres の vitest と testkit の vitest は `@mnemora/core` を `core/src` の別名で読むので、core の変異は dist を作り直さなくても載った。#1553 の local-embedding は注入した pipeline で当てた（モデルの取得は要らない）。
「穴」は足りない側、「やりすぎ」は正しい振る舞いまで壊す側。「既存」はこの PR より前から在った歯。

| 約束 | 変異 | 赤になった歯 |
| --- | --- | --- |
| #1553 | 穴: チャンクのループ頭の `throwIfAborted` を外す | 既存1本 |
| #1553 | 穴: `ingestConversation` が drain の結果を返さない | 新しい歯4本（偽の Runtime の2本と、子プロセスの2本） |
| #1553 | 穴: 警告後の `process.exitCode = 1` を外す | 新しい歯1本（子プロセス） |
| #1553 | 穴: 失敗の閾値を `> 0` から `> 1` | 新しい歯1本 |
| #1553 | やりすぎ: 警告のあとに `return`（recall の表示を打ち切る） | 新しい歯1本 |
| #1554 | 穴: 勝者の検査を書き込みの前から外す | 既存2本（testkit・Postgres の両脚） |
| #1554 | 穴: 候補の綴りの照合で `sameSpelling.length === 1` を `>= 1` | 新しい歯1本 |
| #1554 | 穴: `given.id === listed.id` の確認を外す | 新しい歯1本 |
| #1554 | 穴: 勝者の検査を候補の照合の前に置く | 新しい歯1本 |
| #1554 | やりすぎ: 検査の側を `(correctedId, correctedId)` にする | 既存3本 |
| #1554 | 穴: `supersedeWinnerLabel` の `&& !isCorrected` を外す | 既存1本 |
| #1565 | 穴: Seeded の delegate 照合から `provider` を外す | 新しい歯1本 |
| #1565 | 穴: `CassetteRecorder` の空間照合から `provider` を外す | 新しい歯1本 |
| #1565 | 穴: 有限性の検査を `Number.isNaN` に弱める（`assertCassette`・Recorded・Recording の各1） | 新しい歯各2本（`+Infinity`・`-Infinity`） |
| #1565 | 穴: Recording の並列に待つ側への複製を外す、記録するときの複製を外す | 新しい歯1本（どちらでも、この1本だけ） |
| #1565 | 穴: 記録済みを再取得する、重複テキストの dedupe を外す | 既存3本・既存1本 |
| #1565 | 穴: `opts` を delegate に渡さない（Seeded の LLM 2形・embed、Recording の embed・LLM 2形） | 既存各1本 |
| #1565 | 穴: `assertCassette` の `dimensions` 検査・鍵の一致検査を外す | 既存3本・1本 |
| #1565 | 穴: Recorded・Recording・Seeded・Deterministic の参照共有に戻す | 既存各1本 |
| #1565 | 穴: Deterministic の `dimensions` 検査を外す、`0` を通す | 既存11本・2本 |
| #1574 | 穴: `resolveContestedPair` の2つ目の検査を外す | 新しい歯1本 |
| #1574 | 穴: `resolveContestedGroup`・`markContestedGroup` の検査を先頭だけにする | 新しい歯各2本（既存12本は緑のまま） |
| #1574 | 穴: createMemories・updateStatusWithEvent・supersede の対象と `buildCreatedEvent`・`markContestedPair` の2つ目・purge・orphaned の検査を外す | 既存各1〜3本 |
| #1577 | 穴: Fake の `resolveContestedPair` の2つ目・`resolveContestedGroup`・`markContestedGroup` を先頭だけ／外す | 新しい歯1本・各2本（既存は緑のまま） |
| #1577 | 穴: Fake の `toLowerCase` を外す、空文字を通す、updateStatusWithEvent・purge・orphaned・supersede を外す | 既存各1〜3本 |
| #1578 | 穴: 上限の判定を `<` にする、`<= 4097` にする | 新しい歯各1本（既存は緑のまま） |
| #1578 | 穴: 切りを素の `slice` に戻す | 既存4本 |
| #1578 | 穴: `>= 1e21` を `> 1e21`、`Number.isFinite` を外す | 既存2本・2本 |
| #1594 | 穴: 記憶の id 側の `toLowerCase()` を外す | 新しい歯1本（対照の1本は緑のまま） |
| #1594 | 穴: 除外の集合側の `toLowerCase` を外す、配列検査を外して集合の作成を `recall()` の後へ動かす | 既存1本・12本 |
| #1575 | 穴: footprint の NaN 判定・較正の有限フィルタ・傾き・切片の `isFinite`・`Math.min(...)`・観測の最大値、フォールバック digest の NaN 分岐・素の `slice`・長さを変えるやりすぎ側 | 既存各1〜7本 |
| #1576 | 穴: `setOwn` の3か所を `result[key] =` に戻す、`enumerable: false` | 既存各1本（3つ目の `null` を残す書き込みは届かない。下） |
| #1579 | 穴: `readSubjectActivitySeqs`・3つの adapter の `out`・`intersectAttributes` を元に戻す | 既存各1〜4本 |
| #1584 | 穴: message に小文字の id、積む `memoryId` を小文字にしない、Fake の引きの `toLowerCase` | 既存各1〜2本 |
| #1586 | 穴: `assertValidEventRetentionKind` を外す、`rounded === 0` を外す、int4 の上限を `>=` | 既存各1本 |
| #1588 | 穴: Invalid Date の検査を外す・書き込みの後ろへ動かす、`getRecall` の複製・`createRecall` の複製・`createdAt` の複製を外す、InMemory の検査を外す | 既存各1本 |
| #1597 | 穴: `LATIN` の先読みを外す、ASCII だけにする、`languageMismatch` を `null` でも常に入れる | 既存11本・2本・4本 |

## 外したもの【判断】

等価な変異（走らせて緑で、理由も確かめた、または読んだ）:

- #1553: `<=` を `<`（`prefixed.length <= maxBatchSize`）、チェックをチャンクの後ろへ移す。件数が境目ちょうどでも結果が変わらない。
- #1574・#1577: `knownInTenant`（今更新・作成した行を指すイベントを通す抜け道）を外す。【実測】`InMemoryMemoryStore` と Fake の両方で緑。その行は同じ呼び出しの中で既に `memories` に入っているので、引いても同じ結果になる。
- #1576: `keepSchemaNulls` の `null` を残す書き込みを `result[key] = null` に戻す。届くのはスキーマに `__proto__` という名前の必須の `.nullable()` の欄が在るときだけで、その zod スキーマは openai の strict への変換が断る。provider を通る経路では歯を書けなかった。
- #1578: `>= 1e21` を `>= 1e20`。`BigInt(1e20).toString()` と `String(1e20)` が同じ21桁。
- #1579: `typeof value === "number"` を外す。`Number.isFinite` が数でない値に `false` を返す。
- #1584: `InMemoryEventStore.append` の引きの `toLowerCase` を外す。ADR 0521 以後は `InMemoryMemoryStore.get` が id を小文字にそろえて引く。
- #1586: Fake の `setEventRetention` の中の int4 の検査を `> 2 ** 31` にする。ADR 0499 以後は共有の検査が同じ値を断る。
- #1597: 全文フォールバックの本文を検査しない分岐を外す。全文フォールバックの本文は観測そのもの（かな・漢字を含む）なので、検査しても必ず `null`。

約束が決まっていないので歯を書かなかったもの（すり抜けたまま）:

- #1575: `compareWithFullLog` で `fullLogChars` が `Infinity` のときも `undecidable` に含める。ADR 0467 が「材料」として名指しで残している入力である。
- #1597: `contentLatinShare` の丸めを `Math.round` から `Math.floor`。TSDoc は「小数第2位まで」としか言わず、四捨五入か切り捨てかが決まっていない。歯にすると今の `Math.round` を約束に格上げする。
- #1565: `assertRecordableVector` の `Array.isArray` を外す（型付き配列が通る）。TSDoc は「配列を返さなかった」と言うだけで、型付き配列を断る約束かは決まらない。同じ PR で recall は `Float32Array` を受けるようにしており、向きが逆（下の「直しが要りそうなもの」）。
- #1565: `RecordingEmbeddingProvider` の出力件数が入力より多いのを許す。#1565 より前の約束（ADR 0051）で、この PR の対象ではない。

走らせていないもの【未確認】: core の `toPlainVector`（`Float32Array` などの受け入れ）の変異。既存の歯（`recall-query-embedding-typed-array.test.ts` の8本）が型付き配列・次元違い・NaN・BigInt・DataView・オブジェクト・文字列を縛っているのを読んだだけである。

## 後の ADR で逆になった約束【現物】

- #1597 は、`findCorrectionCandidates` の `text` が `undefined` のときの振る舞い（`no_candidates`、埋め込み0回、`omitted` に `candidate_generation` の skip）を TSDoc に書いて歯にした。ADR 0496 が、`text` が文字列でなければ `recall()` の前に `TypeError` で断るようにし、TSDoc を断る振る舞いに戻した。歯だった `correction-candidates-text-undefined.test.ts` も削除されている。**この約束には変異を当てていない。**
- 狭まった・意味が変わった約束は、ほかに見つけていない（見つけた範囲での結果であり、断定ではない）。ADR 0496・0499・0500・0507・0521・0525・0549・0554・0585・0598・0599 は、断る入力を減らす向きに広げた・同じ向きに寄せた・隣を縛っただけと読んだ。

## 直しが要りそうなもの（実装は変えていない）【判断】

- #1586: core の Fake の `setEventRetention` の中の int4 の検査（`days > 2 ** 31 - 1`）は、ADR 0499 以後は共有の `assertValidEventRetentionDays` と重複した死んだ行である。
- #1584: `InMemoryEventStore.append` の引きの `toLowerCase()` は、ADR 0521 以後は結果を変えない余分な1行である。
- #1565: `RecordingEmbeddingProvider` の `assertRecordableVector` は配列でないベクトル（型付き配列）を断るが、同じ PR で recall は `Float32Array` を受けるようにした。どちらを約束にするか判断が要る。

## 縛っていないもの

- 上の「約束が決まっていないので歯を書かなかったもの」の4つ。歯にすると、今の振る舞いを約束に格上げする（将来の直しが歯を書き換えさせる）。
- #1594 の新しい歯は、adapter が大文字の id を返す場合だけを縛る。core の Fake・`@mnemora/postgres` は小文字で返すので、実在の3実装では出ない。
- #1553 の子プロセスの歯は、実 API ではなく手元の HTTP スタブに当てる。スタブは埋め込みの応答だけを返し、LLM の経路は呼ばれたら 400 にする。
- #1565 の `±Infinity` の歯のうち `assertCassette` のものは、JSON が `Infinity` を `null` にする（JSON から読んだカセットでは出ない）ので、オブジェクトを直接渡す入力を縛る。
- 全テストは走らせていない。名指しのファイルだけである。

## これが覆るとしたら

#1574・#1577 の「どのイベントも指し先を書く前に確かめる」（Postgres の H4 と同じ集合）、#1554 の「勝者の検査は候補だと決まってから・書き込みの前」、#1578 の上限の約束、`excludeMemoryIds` の「大文字小文字を無視して突き合わせる」、#1565 の「返すベクトルは記録・delegate とは別の配列」、`chat` の「embed の失敗を標準エラーと終了コード 1 で言い、recall の表示は止めない」が変わるとき。
