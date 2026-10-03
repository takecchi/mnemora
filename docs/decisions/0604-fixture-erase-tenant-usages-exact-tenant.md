# ADR 0604: testkit の InMemory と core の Fake の `eraseTenant` が `recall_usages` を tenantId の完全一致で消す（あわせて Fake の `tenant_subject_activity` を subject ごとの行で数える）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-04

クローンのマネージャー（mgr-9a36f2f4）が書いた。実装を直すと決めたのも、Fake の数え方を同じ PR で揃えると決めたのも、クローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 経緯

- 【現物】`@mnemora/testkit/fixtures` の `InMemoryMemoryStore` と core のテスト用 `FakeMemoryStore`（`packages/core/src/__tests__/runtime-fakes.ts`）は、`recall_usages` を `${tenantId}:${recallId}:${memoryId}` という文字列の鍵の集合で持つ。どちらの `eraseTenant` も、この鍵を `${ctx.tenantId}:` の前方一致で消していた。
- 【現物】tenantId は不透明な文字列で、`:` を含んでよい。`acme` を消すと、`acme:eu` の `recall_usages` の鍵も `acme:` で始まるので消える。`@mnemora/postgres` は `recall_usages` を `WHERE tenant_id = ${ctx.tenantId}` で消すので、もとから完全一致である。
- 【現物】Fake の `eraseTenant` は `tenant_subject_activity` を、テナントあたり1行として数えていた。testkit の InMemory は [ADR 0426](./0426-in-memory-erase-tenant-postgres-alignment.md) で subject ごとの行に揃えたが、Fake は揃っていなかった。
- 【実測】直す前に歯を書き、赤を見た。
  - InMemory で `acme` を消すと、`deleted` が 1 になり、`acme:eu` の usage の鍵が消えた。
  - Fake でも同じ（`deleted` が 1）。
  - Fake で subject が3つのテナントを消すと、`deleted` が 6 ではなく 4 だった。`limit: 5` の1回では、5 を消して残り1行を次の回に回すはずが、4 を消して終わった。

## 決定【判断】

1. **`recall_usages` は tenantId の完全一致で消す**（InMemory・Fake）。鍵から tenantId を取り出す関数 `tenantOfUsageKey`（後ろから2つめの `:` より前）で比べる。recallId・memoryId は `:` を含まない（どちらも store が `rcl-`・`mem-` に連番を付けて採番し、`recordUsage` はそのテナントに在る recall・記憶の id しか受け付けない）ので、tenantId に `:` があっても切り出しは一意に決まる。
2. **Fake の `tenant_subject_activity` は subject ごとの行で数える**。InMemory（ADR 0426）と同じく、内側の `Map<subjectId, seq>` を `drainMap` で budget の範囲だけ消す。空になったときだけ外側のキーを消す。`dryRun` では何も消さない。
3. **歯**。
   - testkit `in-memory-erase-tenant-postgres-alignment.test.ts` に「acme を消しても、acme:eu の recall_usages は残る」を足す。件数だけでは「usage を数えも消しもしない」実装と見分けられないので、usage の鍵の集合そのものを見る。対照として、`acme:eu` 自身を消せば鍵は消える。
   - core に `fake-erase-tenant-exact-tenant.test.ts` を新しく置き、Fake に対して同じ歯を1本と、`tenant_subject_activity` の歯を2本（subject 3つなら `deleted` が 6、`limit: 5` なら 5 と 1 に分かれる）書く。
4. **CHANGELOG** の未リリースの節（`[1.3.0]`）の Fixed に、testkit の InMemory の行だけを足す。core の Fake は出荷物ではないので載せない（[ADR 0243](./0243-changelog-lists-publish-targets-only.md) の「publish 対象の変更だけを載せる」。Fake の行は一度足したが、クローンの判断で落とした）。

## 変異試験【実測】

直した実装ファイルを `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせて赤を見たら、`cp` で戻して `cmp` で一致を確かめ、緑に戻した。

| 変異                                                                              | 側       | 赤になった歯                                                                          |
| --------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| InMemory の usage の消去を前方一致に戻す                                          | やりすぎ | testkit の完全一致の歯（`acme` の消去で `deleted` が 1）                              |
| InMemory の usage を消さない                                                      | 足りない | 同じ歯の対照（`acme:eu` を消しても鍵が残る。`expected true to be false`）             |
| Fake の usage の消去を前方一致に戻す                                              | やりすぎ | core の完全一致の歯                                                                   |
| Fake の usage を消さない                                                          | 足りない | 同じ歯の対照                                                                          |
| Fake の `tenant_subject_activity` をテナントあたり1行として数える（直す前の実装） | 足りない | core の subject の歯2本（`deleted` が 6 ではなく 4、`limit: 5` の1回が 5 ではなく 4） |

戻したあとは、core の `eraseTenant` に関わるテスト（123本）と testkit 全体（1161本）が緑だった。

## 縛っていないもの

- recallId・memoryId に `:` が入る実装は考えていない。どちらも store が自分で採番する。
- `@mnemora/postgres` は変えていない（もとから完全一致）。

## これが覆るとしたら

tenantId に使える文字から `:` を外すとき（そのときは前方一致でも足りる）。InMemory・Fake の `recall_usages` を、tenantId を別の欄に持つ形に変えるとき（そのときは `tenantOfUsageKey` が要らなくなる）。
