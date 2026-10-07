# ADR 0697: core の Fake に `scrubPurged` を足し、InMemory・Postgres と同じ振る舞いを3者照合の歯で縛る（ADR 0538 の決定2と「`scrubPurged` の扱い」を覆す）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-08

**これはクローンの判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1918](https://github.com/takecchi/mnemora/issues/1918) の締めのコメント（<https://github.com/takecchi/mnemora/issues/1918#issuecomment-6043226144>）の報告。測ったのは作業者。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22、PostgreSQL 17 + pgvector を自分専用のポート 55432 で）、【判断】はクローンの判断（担い手が下書きした。オーナーの判断ではない）。

**⚠ この ADR の番号は仮である。** マージの直前に `node scripts/adr-renumber.mjs` が確定する（[ADR 0179](./0179-adr-number-assigned-at-merge.md)）。

- **文脈**: [ADR 0538](./0538-retention-and-purge-parity.md) は、`scrubPurged` を Fake に実装しないまま、その不在を `fake-retention-purge-parity.test.ts` の1本（`toBeUndefined()`）で縛った（決定2と「`scrubPurged` の扱い」【判断】）。【現物】その結果、(1) Fake の上では `Runtime.purge` の `already_purged` のかけ直しで残骸が消えることを試せず、(2) 「`scrubPurged` の無い adapter では `Runtime.purge` が後始末を飛ばす」経路の証人が Fake の不在という暗黙のものだけだった。

## 何を決めたか【判断】

1. **core の Fake（`FakeMemoryStore`）に `scrubPurged` を実装する。** InMemory の実装を手本に、Fake の内部表現（`backing.memoryLabels`・`backing.labels`・`backing.recalls`）に写した。契約は `MemoryStore.scrubPurged?` の TSDoc、ADR 0437 決定3、ADR 0512 のとおり（対象は `forgotten` かつ `purgedAt` 非 null の行だけ、べき等、`proposedCount` は外した本数だけ減らし床は0、registered は触らない、`updatedAt` は残骸のある行だけ動かす、目次帯の digest を伏せて `truncated` を落とす、監査イベントは積まない、`ctx` の検査は他の口と同じ）。
2. **ADR 0538 の決定2（Fake に `scrubPurged` が無いことを縛る1本）を、3者照合の歯で置き換える。** `fake-retention-purge-parity.test.ts` の `toBeUndefined()` の1本を消し、保持と掃除の3者照合（Fake・InMemory・Postgres が同じ入力・同じ `EXPECTED`）に `scrubPurged` の段を足した。`EXPECTED` は Postgres で測った値で、InMemory と Fake の側が同じ値を縛る。
3. **「`scrubPurged` の無い adapter では `Runtime.purge` が後始末を飛ばす」経路は、名指しの1本で残す。** `purge.test.ts` の既存の1本（Fake に `scrubPurged` が無いことに暗黙に頼っていた）を、Fake から `scrubPurged` を明示的に外した store で、残骸が残ったまま `already_purged` の形が変わらず（`residueCleanup` も付かず）例外にもならないことを縛る形に書き換えた。
4. **Runtime 経由の1本を足した。** Fake の上で `runtime.purge` の `already_purged` をかけ直すと、tags・attributes・claim key・目次帯の digest の残骸が実際に消える（`purge.test.ts`）。

## ADR 0538 の何がどう覆ったか

- **覆ったもの**: 決定2「Fake に `scrubPurged` が無いことを縛る」と、「`scrubPurged` の扱い【判断】」の結論（「この ADR では新しい歯を足さなかった」・Fake は不在で2者だけ）。0538 の代替案1（残骸を実装ごとに直接作って3者で比べる）は、そのときは採らなかったが、この ADR で採る。
- **0538 が挙げた覆る条件とは別の理由で覆す。** 0538 の「これが覆るとしたら」は「`createMemory` が `purgedAt` を受けるようになったとき」だった。**その条件は満たしていない**【実測】（`createMemory` は今も `purgedAt` を受けない）。覆す理由は別で、#1918 の締めのコメントの報告である: **Fake の上では `already_purged` の後始末を試せない。残骸の行は、実装ごとの内部の口（Fake は内部の行と label を直に書き換える、InMemory は内部の Map、Postgres は SQL）で作れば、3者で比べられる。** 0538 は「公開口では残骸の行を作れない」ことを、比べない理由にした。この ADR は同じ事実を、「公開口で作れないなら内部の口で作る」という作り方の問題として扱う（既にある `scrub-purged-residue-gaps.postgres.test.ts` と `supportsScrubPurged` の歯が InMemory と Postgres でやっていることを、Fake にも揃えた）。
- **覆していないもの**: 0538 の他の決定（保持と掃除の口の3者照合・`events_purged` の `meta` の直し）。0538 の本文は書き換えない。

## 測り方【実測】

3者に同じ入力を流し、結果と後の状態を平らなデータにして比べた。`EXPECTED` に足したのは6項目（既存の21項目と合わせて27項目）。

- 行: 残骸（tags・attributes・claimKey）の有る purge 済み（2本。ラベルを共有）・残骸の無い purge 済み・渡されなかった purge 済み・未 purge の forgotten・`purgedAt` が立っているだけの active・別テナントの purge 済み・registered なラベルを持つ purge 済み・`proposedCount` を0に書き換えた purge 済み。存在しない id（形式は正しい）・形式不正な id・空配列。
- 見たもの: 各行の `status`・`content`・`digest`・`tags`・`attributes`・`claimKey`・`purgedAt`、`updatedAt` が動いたか、`proposedCount`（外した本数だけ減る・registered は動かない・床は0）、監査イベントの本数、2回目と空配列でなにも変わらないこと、NUL を含む `tenantId` が `MalformedIdentifierError` になること。目次帯は、渡された purge 済みの行のエントリだけが `[purged]` 側へ伏せ（`truncated` は落ちる）、渡されなかった行・未 purge の行・生きている行・別テナントの帯と、`recalls.query`・`explain` は動かないこと、2回目で変わらないこと。
- 残骸を作る口: Fake は `liveRowForTest` と `backing.labels`、InMemory は内部の `memories`・`labels` の Map、Postgres は SQL の `UPDATE`。`updatedAt` の「動いた」は時計の分解能に埋もれないよう、呼ぶ前に 5ms 待って測った。
- 結果: Postgres で測った `EXPECTED` に、InMemory と実 Postgres（`retention-purge-parity.postgres.test.ts`、2件）も、Fake（`fake-retention-purge-parity.test.ts`、1件）も一致した。**実装前の Fake は `TypeError: mem.scrubPurged is not a function` で赤く、`purge.test.ts` の Runtime 経由の1本は残骸が消えず赤かった**。

## 変異試験【実測】

Fake の `scrubPurged` を1つずつ曲げ、`fake-retention-purge-parity.test.ts` と `purge.test.ts` を走らせた（戻したあとは `cmp` で差分が無いことを確認）。**22 件すべて赤**。足りない側とやりすぎた側の両方を入れた。うち3件（`ctx` を検査しない・残骸の無い行の `updatedAt` を動かす・渡されていない id まで掃除する）は、3者照合の歯のどの項目が割れたかも読んだ。

| 変異                                           | 結果                                                           |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `purgedAt` を見ない                            | 赤（3者照合）                                                  |
| `status` を見ない                              | 赤（3者照合）                                                  |
| テナントを見ない                               | 赤（3者照合）                                                  |
| `proposedCount` を減らさない                   | 赤（3者照合）                                                  |
| `proposedCount` を二重に減らす                 | 赤（3者照合）                                                  |
| registered も減らす                            | 赤（3者照合）                                                  |
| `proposedCount` の床を外す                     | 赤（3者照合）                                                  |
| 残骸の無い行も `updatedAt` を動かす            | 赤（3者照合。`clean` の `updatedAt` が動く）                   |
| 目次帯を伏せない                               | 赤（3者照合と Runtime 経由の1本）                              |
| 目次帯の `truncated` を落とさない              | 赤（3者照合と Runtime 経由の1本）                              |
| label の紐付けを外さない（2回目で二重に減る）  | 赤（3者照合）                                                  |
| tags / attributes / claimKey を消さない（3本） | 赤（3者照合と Runtime 経由の1本）                              |
| `ctx` を検査しない                             | 赤（3者照合。`MalformedIdentifierError` が `resolved` になる） |
| 存在しない id で例外                           | 赤（3者照合）                                                  |
| 監査イベントを積む                             | 赤（3者照合と、`purge.test.ts` のイベント本数の既存の歯）      |
| やりすぎ: `content`・`digest` まで書き換える   | 赤（3者照合）                                                  |
| やりすぎ: 目次帯の他のエントリまで伏せる       | 赤（3者照合）                                                  |
| やりすぎ: 渡されていない id の行まで掃除する   | 赤（3者照合。`notPassed` の残骸が消える）                      |
| やりすぎ: `purgedAt` を書き換える              | 赤（3者照合）                                                  |
| やりすぎ: 他テナントの目次帯も伏せる           | 赤（3者照合）                                                  |

3者照合の歯は1本の `it` なので、「赤」だけでは割れた項目が分からない。上の3件のほかは、割れた項目を個別には読んでいない。

## 検討した代替案

1. **0538 のまま、Fake に実装しない。** 採らなかった。Fake の上で `already_purged` の後始末を試せず、「無い adapter では飛ばす」経路の証人が暗黙のままになる。
2. **Fake だけの単独の歯を新しいファイルに足す。** 採らなかった。実装ごとにずれうる点（`updatedAt`・`proposedCount` の床・目次帯の `truncated`）は、同じ `EXPECTED` で3者を縛るほうが、Postgres を基準に Fake が追随できる。既にある保持と掃除の3者照合のペアがそのまま使えた。
3. **`createMemory` が `purgedAt` を受けるようにして、公開口で残骸を作る。** 採らなかった。公開 API の変更で、この ADR の射程の外（オーナーの領分）。

## 引き受けた負債

- 残骸を作る口（`markPurgedAt`・`setProposedCount`）は実装ごとの内部表現に依存する。InMemory の `memories`・`labels`・`labelKey` や Fake の `backing.labels` の名前・キーの形を変えると、歯が落ちる（既にある `scrub-purged-residue-gaps.postgres.test.ts` も InMemory の内部に同じ形で依存している）。
- `scenario` の本体は、Fake 側と Postgres 側の2ファイルに同じ文面で複製されている（0538 から変わらない）。片方だけ直すと、同じ `EXPECTED` を縛る両側が割れる。
- Fake の `scrubPurged` は InMemory の実装の写しである。契約が変わったとき、3か所を揃える必要がある（3者照合の歯が割れて気づく）。

## オーナーの領分の材料

なし（公開 API・既定値・決定を覆す材料は見つからなかった。`scrubPurged` は任意メソッドのまま）。

## これが覆るとしたら

- `scrubPurged` が必須になる、または契約が変わるとき（TSDoc と3者の実装・`EXPECTED` を一緒に直す）。
- Fake を test 用から外し、公開の実装にするとき（0538 と同じ）。

## 測っていないこと

- Postgres のラベルの行ロックの順序（並行）。`label-lock-order-*.postgres.test.ts` が縛る面で、Fake は単一スレッドなので対象外。
- `recalls` の目次帯に同じ `memoryId` が複数回ある場合・帯が空・帯の無い記録の細部。InMemory の `in-memory-scrub-purged-index-band*.test.ts` と Postgres の `repurge-legacy-index-band.postgres.test.ts` が縛る面で、3者照合には足していない。
- 孤立サロゲートを含む `tenantId`（NUL の1つだけを3者で見た）。
- 大量の id（Postgres のパラメータ数の上限）。
- Postgres の SQL_ASCII 脚（手元の Postgres は UTF8 + `C.UTF-8` の1つだけで測った）。
