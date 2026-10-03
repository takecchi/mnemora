# ADR 0574: ADR 0557 の歯の穴（やりすぎ・循環の走査・検査の位置）を塞ぐ

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-f9bd8ced の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポート 55941 で。`C.UTF-8`）、【判断】は担い手の判定。

## 文脈【現物】

[ADR 0557](./0557-core-fake-superseded-by-checks.md)（#1668）は、core の `FakeMemoryStore` に `supersededById` の断り（ADR 0503・0515）を入れた。独立した検証で、`runtime-fakes.ts` に次の5つの変異を入れても、`fake-superseded-by-checks.test.ts` などの既存の歯が赤にならなかった（生き残り）。

| 番号 | 変異 | 生き残った理由 |
|---|---|---|
| #3 | group: 群の外の `superseded` を指すのも断る（やりすぎ） | 陽性対照が外の `active`・`archived` だけ |
| #4 | pair: 対の外の `superseded`・`contested` を指すのも断る（やりすぎ） | 同上。ADR 0557 決定3は「外の active・archived・superseded・contested を指すのは断らない」と書く |
| #8 | 循環の helper が、走査を最初のキー1つだけにする | 循環の入力が、先頭のメンバーが輪に入る形だけだった |
| #14 | `updateStatus` の形の検査を、hook・存在確認の後ろへ移す | 存在しない id・hook を見る歯が無かった |
| #15 | pair の循環の検査を、存在確認・CAS の後ろへ移す | 循環の入力が `contested` の対で、CAS を通る形だった |

## 決定【判断】

1. `runtime-fakes.ts` は変えない。5つとも Fake が Postgres と違う挙動をしているのではなく、歯が足りなかった。
2. 歯を足す（2ファイル）。
   - `packages/core/src/__tests__/fake-superseded-by-checks-controls.test.ts`（14 本。Fake だけ。DB 不要）: 陽性対照（pair・group × 外の `superseded`・`contested`）、循環の走査（先頭が群の外を指す・先頭が `active`・尾が輪に入る）、位置（存在しない id・hook を呼ばない・`contested` でない行・存在しない行の循環）。
   - `packages/postgres/src/__tests__/store-superseded-by-checks-controls.postgres.test.ts`（8 本 × 3 実装。DB が要る）: 同じ入力を testkit の InMemory・core の Fake・Postgres に流す（hook は Fake だけなので入れない）。
3. 位置の順は、InMemory・Postgres・Fake で同じ【現物・実測】: 形の検査（`updateStatus*` では `id` を畳んだ直後）→ pair・group の循環 → 存在確認 → CAS。Postgres の `isUuidLike` による not found は、形・循環の検査より後。3実装とも、存在しない id・`contested` でない行で RangeError になることを、新しい Postgres の歯が見張る。
4. ADR 0557・0503・0515・0550・0558 の本文は書き換えない。

## 変異試験【実測】

歯を WIP として commit したあと、`runtime-fakes.ts` を退避（`cp`）して変異を1つずつ入れ、新しい core の歯だけを走らせた。戻したあとは `git status` が空で、14 本緑。

| 変異 | 赤 | 戻して緑 |
|---|---|---|
| #3 group の外の `superseded` も断る | 1（group の外の superseded） | 14 本緑 |
| #4 pair の外の `superseded`・`contested` も断る | 2（pair の外の superseded・contested） | 14 本緑 |
| #8 循環の走査を最初のキーだけにする | 2（先頭が群の外を指す輪・尾が輪に入る形） | 14 本緑 |
| #14 `updateStatus` の形の検査を hook・存在確認の後ろへ | 3 | 14 本緑 |
| #15 pair の循環の検査を存在確認・CAS の後ろへ | 2（`contested` でない対・存在しない対） | 14 本緑 |

「先頭が `active` で後ろ2者が輪になる」group の入力は #8 では緑のまま（先頭のキーが輪の中なので）。位置の歯として残した。

## 走らせたもの【実測】

core の新ファイル 14 本・Postgres の新ファイル 24 本（8 × 3 実装）が緑。既存の `fake-superseded-by-checks`・`store-superseded-by-checks.postgres`・`uppercase-target-id-parity.postgres` も緑。

## 変えなかったこと

- `updateStatusWithEvent` の形の検査の位置を動かす変異は試していない。位置の歯は両方の口に置いたので、噛む見込みは高いが、変異では測っていない【未確認】。
- group の循環の検査を存在確認の後ろへ移す変異も試していない（group の位置の歯は新ファイルにある）【未確認】。
- CHANGELOG の `[1.3.0]` の「【確かめていないこと】core の `FakeMemoryStore` は揃えていない」を、現物（#1668 で揃えた）に直した。ADR 0515・0550・0558 は書き換えていない。

## これが覆るとしたら

ADR 0557 決定3（外の `active`・`archived`・`superseded`・`contested` を指すのは断らない）や、検査の位置が変わるとき。3実装を一緒に直し、この歯も直す。
