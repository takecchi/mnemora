# ADR 0698: purge の約束の範囲・`recalls` と完了済みの `outbox` の保持期間・`tick` の `limit` とリース・言語の事後検査の `rule` の名前を、オーナーの回答どおりに文書へ落とす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-09

**決めたのはオーナーである**（まとめ問い c9335e43、2026-10-08T23:06Z。回答は「全部推奨で」）。この ADR と文書の文面は、クローンのマネージャー（自動化された担い手）が書いた。**文面の置き場所と言い回しは担い手の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【判断】は担い手の判断。

**⚠ この ADR の番号は仮である。** マージの直前に `node scripts/adr-renumber.mjs` が確定する（[ADR 0179](./0179-adr-number-assigned-at-merge.md)）。

## 文脈

まとめ問い c9335e43 は、次の6つの問いをオーナーに出した（問いの番号は c9335e43 のもの。文面はオーナーに出したとおり）。

| 問 | 問い | 推奨 |
|---|---|---|
| 1 | `recalls` と完了済みの `outbox` に、既定の保持期間を持たせるか | 持たない（呼び出し側が `olderThan` を渡す。運用文書に1節足す）。入れるなら既定の挙動が変わる |
| 2 | purge の約束に `recalls.query`（検索文）を含めるか | 含めない。「残る」と明記する。含めるなら保存済みのデータを書き換える |
| 3 | purge の後も、監査イベントに claimKey（主語と述語）が残る件 | 残すと約束し直して文書に書く。消すなら過去の監査行を書き換えることになり、戻せない |
| 4 | purge と同時に走る recall が、消す前の要約を目次帯に書く窓を、約束に含めるか | 含めない（窓は文書に書く）。含めるなら recall に行ロックが入る破壊的変更 |
| 7 | `tick` の `limit` の既定 50 と `leaseMs`（超えると二重に処理される）・リースを延ばす口 | 今のまま、注意を文書に書く |
| 13 | 言語の事後検査の `rule` の名前（[ADR 0554](./0554-language-mismatch-false-positive-measured-by-replay-and-boundary-cases.md)） | 基準は変えず、TSDoc を実際の運用に合わせる |

【現物】問いの元になった、決まっていなかった箇所:

- 問1・問2: [ADR 0404](./0404-purge-expired-recalls-and-completed-outbox-jobs.md) の「オーナーに聞く事柄」の1と3。`docs/memory-model.md` §9 の、ADR 0404 の追記（「保持期間の既定値・…・`recalls.query` を約束の範囲に入れるか・…は、決まっていない」）。`MemoryStore.purgeExpiredRecalls` の doc（「どこまでを消すと約束するかは決めていない」）。
- 問3: [ADR 0375](./0375-purge-scope-widened.md) の 2026-09-30 の追記「claim key の検出が積む監査イベントの `meta.note` に、claimKey の写しが残る」（「どちらを採るか、あるいは残すと約束し直すかは、オーナーの判断に回した」）。
- 問4: [ADR 0421](./0421-concurrent-write-and-audit-event-holes.md) の R4（負債）と、ADR 0375 の 2026-09-30 の追記「purge と同時に走る recall は、この約束の範囲外のままである」。窓は ADR の中にしか書かれておらず、`Runtime.purge`・`MemoryStore.purgeMemory` の doc にも `docs/memory-model.md` にも無かった。
- 問7: `TickOptions.leaseMs` の doc は「`limit`（既定 50）件を一括して claim」「各ジョブの前にリースを延ばす口も `OutboxStore` には無い」まで書いていた。`TickOptions.limit` の doc には既定の数も、リースの注意への参照も無かった。
- 問13: `LanguageMismatch.rule` の doc は「規則を変えたときに、過去の印と区別できるようにする」と書いていた。[ADR 0490](./0490-language-mismatch-latin-letters-only.md) は数え方の修正を規則の変更とせず、`rule` を変えなかった。ADR 0554 の「`rule` 名の解釈は要確認」の材料が、この食い違いを挙げていた。

## 決めたこと（オーナー）

1. **`recalls` と完了済みの `outbox` に、既定の保持期間を持たせない。**呼び出し側が `olderThan` を渡す（今の振る舞いのまま）。
2. **`recalls.query` は purge の約束に含めない。残る。**
3. **purge の後も、claim key の検出が積んだ監査イベント（`memory_events.meta.note` の JSON）の `claimKey`（主語と述語）は残る。そう約束する。**監査ログの行は書き換えない。
4. **purge と同時に走る recall の目次帯の窓は、約束に含めない。窓があることは文書に書く。**
5. **`tick` の `limit` の既定 50・`leaseMs`・リースを延ばす口が無いことは、今のまま。注意を文書に書く。**
6. **言語の事後検査の判定の基準は変えない。`rule` の名前も変えない。TSDoc を実際の運用（ADR 0490）に合わせる。**

どれも実行時の振る舞いを変えない。今の振る舞いを約束にするか、文書に書くだけである。

## 文書のどこに落としたか【判断】

| 決定 | 書いた場所 |
|---|---|
| 1 | `docs/memory-model.md` §9「保持方針」に節「`recalls` と完了済みの `outbox` の保持期間——既定は持たない。呼び出し側が `olderThan` を渡す」を足した（運用の手順: 呼ぶ口・`reachedLimit` での呼び直し・`dryRun`・消した記録が残らないこと・消した `recallId` への `recordUsage`）。`MemoryStore.purgeExpiredRecalls`・`OutboxStore.purgeCompletedJobs` の doc から、その節を指した |
| 2 | `MemoryStore.purgeMemory` の doc（残るものの一覧）に約束として書いた。`MemoryStore.purgeExpiredRecalls` の doc の「決めていない」を、「この口では行ごと消えるが、purge の約束には含めない」に直した |
| 3 | `MemoryStore.purgeMemory` の doc の、残るものの一覧に足した |
| 4 | `Runtime.purge`・`MemoryStore.purgeMemory` の doc に窓を書いた |
| 5 | `TickOptions.limit` の doc に既定 50 と注意を書き、`TickOptions.leaseMs` の doc を指した（`leaseMs` の doc は既に `limit` を指している）。`limit` の doc の「既定 50」が実装の定数とずれたら赤くなる試験を、`leaseMs` の doc の既存の試験の隣に足した |
| 6 | `LanguageMismatch.rule` の doc を「判定の基準を変えたときに名前を変える。数え方の修正だけなら変えない」に直した。ADR 0554 に追記した |

`docs/memory-model.md` §9 の「1つのテナントを消去した後に」の表と ADR 0404 の追記は書き換えず、その後ろに「決まった」とする追記を足した。ADR 0375・0404・0421・0554 の末尾にも追記し、この ADR を指した。

## 検討した代替案（問いに並べた、推奨でない側）

1. **既定の保持期間を持たせる。**採らなかった（オーナー）。既定の挙動が変わり、何もしていない利用者の `recalls`・`outbox` が消え始める。
2. **`recalls.query` を purge の約束に含める。**採らなかった（オーナー）。`recalls.query` は `memoryId` で特定できず（ADR 0375 決定4）、含めるなら保存済みのデータを書き換えることになる。
3. **監査イベントの claimKey を purge で消す。**採らなかった（オーナー）。過去の監査行を書き換えることになり、戻せない。`meta.note` に写さないようにする案（ADR 0375 の追記の (1)）は、検出の根拠を後から読めなくなる。
4. **同時に走る recall の窓を約束に含める。**採らなかった（オーナー）。recall に行ロックが入る破壊的変更になる（ADR 0421 の R4 の3案）。
5. **`limit` の既定を変える・リースを延ばす口を足す。**採らなかった（オーナー）。
6. **判定の基準を変えて `rule` を改名する。**採らなかった（オーナー）。

## 引き受けた負債

- **ADR 0404 の「オーナーに聞く事柄」の2（`failed` の `outbox` 行の扱い）と4（消すときに監査行を積むか）は、この ADR でも決まっていない。**c9335e43 の問いに入っていなかった。
- **何もしなければ `recalls` と完了済みの `outbox` は増え続ける。**消すのは運用側の責務で、mnemora は口だけを持つ。
- **purge と同時に走る recall の記録には、purge 前の digest が残りうる。**【現物】`MemoryStore.scrubPurged` を持つ adapter では、`already_purged` の記憶にもう一度 `Runtime.purge` をかけると、その時点で記録済みの `recalls` の目次帯の digest が伏せられる（`scrubPurged` の doc の契約）。窓で残った分もこれで伏せられるはずだが、**歯では確かめていない**。後始末の手段として約束にもしていない。
- **`recalls.query` には、`consolidate`・`reflect` が種の digest を `text` にして撃った recall の分として、purge した記憶の digest が残りうる。**消す手段は `purgeExpiredRecalls` で行ごと消すことだけである。

## これが覆るとしたら

- 法的な要求などで purge の射程を広げる必要が出たとき（問2・3・4）。そのときは保存済みのデータ・監査行の書き換えや、recall の並行制御の変更を伴う。
- 運用で `recalls`・`outbox` の増え方が問題になり、既定の保持期間が要ると判断されたとき（問1）。
- `limit` 件の処理がリースを超える二重処理の費用が実運用で問題になったとき（問7）。
- 判定の基準そのものを変えるとき（問13）。そのときは doc のとおり `rule` を改名する。

## 確かめたこと

- 【現物】`DEFAULT_TICK_LIMIT` は `packages/core/src/runtime.ts` で 50。
- 【現物】claim key の検出が `meta.note` に JSON で `claimKey` を書くのは `packages/core/src/runtime.ts` の `detectClaimKeyContested` 付近の3か所（JSON の `kind` が `claim_key_conflict`・`claim_key_conflict_group`・`claim_key_conflict_unresolved`）。
- 足した試験（`limit` の doc の「既定 N」と定数の一致、`leaseMs` への参照）は、`packages/core/src/__tests__/tick-batch-lease-expiry.test.ts` だけを流して緑。
- purge の後に `meta.note` の claimKey が残ることは、この ADR でも走らせて確かめていない（ADR 0375 の追記と同じく、`purgeMemory` が `memory_events` を書き換えないことのコードからの読み）。
