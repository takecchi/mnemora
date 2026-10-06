# ADR 0660: 10/02〜10/04 にマージされた PR の確かめ直しで見つかった穴に歯を足す（Issue #1759）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1759](https://github.com/takecchi/mnemora/issues/1759)（分母はその本文、群ごとの結果はそのコメント）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【受】は自分で測らずに受け取ったもの、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0658](./0658-merged-1005-1006-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯

10/02〜10/04（UTC）にマージされ、テスト以外の `src` に振る舞いの変更がある PR のうち、確かめ直しの記録が無かった27本に、足りない側とやりすぎた側の変異を当てた。変異は `cp` で退避・戻し、`cmp` で確かめた。

- A 群（core）と C 群（構成値）は、担い手が main `566855ed` で測った。
- B 群（testkit の fixture と postgres）は、担い手の作業者が同じ main で測った。担い手はそのうち2つの変異を自分でも当て直した（下の表の †）。

足した歯は、どれも main `46f45cca` で緑だった。A 群の2つの穴は、`46f45cca` でも変異で赤になることを当て直した【実測】。

## 決定【判断】

1. **実装は変えない。**適合テストにも足さない（公開の約束を増やすのはオーナーの領分）。
2. 次の歯を足す。

| PR・ADR | 穴（すり抜けた変異） | 足した歯 | 変異での赤 |
| --- | --- | --- | --- |
| #1611（[ADR 0502](./0502-observe-rejects-whitespace-only-input.md) 決めたこと3「値は trim しない」） | 空白だけを断る検査が、通した値を trim して返す（`.transform(trim)`）。core 全体も、PR の Postgres の歯（`.trim()` してから比べる）も素通り | `core/.../observe-blank-check-does-not-trim.test.ts`（新規） | 7本 |
| #1601（[ADR 0494](./0494-fuzz-relations-and-argument-mutation.md)） | `relationMaxCount` で切った群のメンバーを、段2の `over_limit` の数えから外さない。core 全体・既定の fuzz（20 シード）・Postgres の fuzz を素通り。relations profile を 2000 シード回すと、7シードで I10-upper が出た | `core/.../recall-relation-fuzz-regressions.test.ts` に seed 545 の最小化した操作列（8操作）を1本 | 1本 |
| #1593（ADR 0486） | fixture が Map・Set・クラスのインスタンスまで辿る（structuredClone に任せない） | `testkit/.../in-memory-payload-nonplain-adr0486.test.ts` | 2本 |
| #1599（ADR 0488） | `link` の kind の検査を、両端の検査の後ろへ動かす | `core/.../fake-relation-link-kind-before-endpoints.test.ts`、`postgres/.../relation-link-kind-before-endpoints.postgres.test.ts` | 3本・3本 |
| #1603（ADR 0493） | Fake の `setDefaultHalfLifeRecalls`・`getTaxonomyMode` から ctx の検査を外す（「全公開メソッド」のうち代表しか見ていなかった） | `core/.../fake-ctx-check-every-method.test.ts`（Fake の各クラスの全メソッド。ctx を取らない補助は名指しで除く） | 2本 |
| #1609（ADR 0500） | `RecordingLLMProvider` の並列の待ち側（`complete`・`completeStructured`）の複製を外す | `testkit/.../recording-llm-parallel-waiters-isolation.test.ts` | 2本 †（`complete` 側を当て直した） |
| #1615（ADR 0521） | InMemory の `VectorStore.upsert` が大文字の id を小文字にしない（同じ行を上書きせず2本目が積まれる）／`rawGet` が tenantId を大文字小文字無視で比べる | `postgres/.../vector-upsert-uppercase-id-single-row.postgres.test.ts` †、`postgres/.../tenant-id-case-sensitive-isolation.postgres.test.ts` | 2本・1本 |
| #1621（ADR 0503 決定5） | 群版で、群の外の `archived`・`superseded` を指す `supersededById` を断る（`forgotten` だけでなく） | `postgres/.../store-superseded-by-group-outside-controls.postgres.test.ts` | 4本 |
| #1625（ADR 0505） | observation の `attributes` の NUL の検査が、文字どおりの `\u0000` の文字列も断る | `postgres/.../store-write-nul-lookalike-controls.postgres.test.ts` | 1本 |
| #1634（ADR 0512） | digest が既にトゥームストーンの帯のエントリで、`truncated` を落とさない | `testkit/.../in-memory-scrub-purged-index-band-truncated.test.ts` | 1本 |
| #1639（ADR 0513） | 同じ token 列の語を、分母で1つにまとめない | `postgres/.../lexical-same-phrase-words-dedupe.postgres.test.ts` | 1本 |

† は担い手が当て直したもの。

## 歯にしなかったもの

- **#1601 の W3b**（`score_not_comparable` の数えから外さない）: 2000 シード × 長さ 120 でも違反が出ず、届く操作列を見つけられなかった【実測】。
- **#1615 の例外の message の綴り**: ADR 0521 は「Postgres の `memoryNotFound` も小文字にそろえた id を載せる」と書くが、作業者の実測では `updateStatus`・`setEmbeddingStatus`・`reinforce` は渡された綴りのまま載せる（`purgeMemory` は小文字）【受】。fixture の側だけを縛ると、fixture と Postgres の割れを固めるので、歯にしない。どちらに揃えるかは #1759 に残す。
- **#1603 の InMemory の `decayFloorAt: null`**: fixture は通し、Postgres は NOT NULL 違反で断る。同じ理由で歯にしない。
- **#1639 の `foo-bar`**: Postgres は `foo_bar` と `foo-bar` を別の tsquery にし、fixture は1つにまとめる【受】。歯は、Postgres も1つにまとめる形（`foo_bar foo__bar`）に限った。割れは #1759 に残す。
- **#1634 の Postgres の副問い合わせの `purged_at` 条件**: 外側の EXISTS が守っており、等価に近い変異。

## 確かめていないこと

- B 群の変異の多くは作業者の実測であり、担い手が当て直したのは †の2つだけである。
- 変異を入れていない口が、各 PR に残っている（#1759 のコメントに PR ごとの「探した範囲」がある）。

## 追記（Issue #1759）: 歯にしなかったもののその後

- #1615 の message の綴りと、#1603 の `decayFloorAt: null` は、クローン miku の判断（根拠はオーナー回答 374f6f88 の問2・問25）で fixture を Postgres に揃えた（ADR 0521・ADR 0493 の末尾の追記）。
- #1601 の W3b は、届く操作列が見つからなかったことを #1759 に書いて閉じる。歯は足さない。
- #1639 の `foo-bar` は、割れが数え方ではなく照合（Postgres はハイフンの合成語を1語として扱い、`foo-bar` は `foo bar` に当たらない）だったので、判断を仰いでいる。
