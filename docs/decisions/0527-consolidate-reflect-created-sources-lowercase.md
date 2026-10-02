# ADR 0527: 穴探し — `consolidate`・`reflect` が積む `created` イベントの `meta.sources` を、渡された綴りではなく store の行の id（小文字）で書く

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・前例のある同種の穴は直す。オーナーの領分の6つは材料に回す）と、この直しを「ADR 0521 の延長として、これから書く行の綴りを揃えるだけで、書いた行を遡って書き換えない」ので線の内側とする判断は、依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポートで。`C.UTF-8`）、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 要点

- **材料**: PR #1617 の [ADR 0524](./0524-uppercase-and-after-delete-llm-paths.md)（mgr-2c9f30d0）が見つけた形【現物】。`consolidate`・`reflect` に大文字の `memoryIds` を渡すと、Postgres の `created` イベントの `meta.sources` に、呼び出し側の大文字の綴りがそのまま残る。#1617 は未マージで、その文書・歯は直していない。
- **直した**: core の `Runtime`（`packages/core/src/runtime.ts`）の2か所。`consolidate` の `created`・`reflect` の `created` の `meta.sources` を、渡された `eligibleIds` ではなく、store が返した記憶の id（`eligibleMemories.map((m) => m.id)`）から組む。**3実装に同じに効く**（store 側は変えていない）。
- **遡らない**: すでに書かれた行は書き換えない。**既存の行を書き換える migration・バックフィルは作っていない**。
- ADR 0521（[0521](./0521-fixtures-accept-uppercase-target-id-like-postgres.md)）が testkit の InMemory・core の Fake を Postgres に揃えたので、大文字の `memoryIds` は3実装とも `consolidate`・`reflect` が最後まで進む。0521 の前は Fake・InMemory が不在扱いにしていたため、この割れは Postgres にだけ見えていた。

## 3実装の突き合わせ（直す前と直した後）

【実測】同じ4件の記憶に、`consolidate({ memoryIds: [a, b] })`・`reflect({ memoryIds: [a, b] })`・`reflect({ seedMemoryId: a })` を、小文字／大文字で渡した。使い捨ての試験（コミットしていない）で、`created` の `meta`・作られた記憶の `provenance`・元の記憶の `supersededById`・`superseded` イベントの `memoryId`/`meta`・返り値を、3実装（Postgres・InMemory・Fake）で比べた。直す前は ADR 0521 を取り込んだ状態。

| 欄 | Postgres | InMemory | Fake |
|---|---|---|---|
| `created` の `meta.sources`（直す前）、大文字で渡す | **大文字のまま** | **大文字のまま** | **大文字のまま** |
| `created` の `meta.sources`（直した後）、大文字で渡す | 小文字 | 小文字 | 小文字 |
| `created` のイベントの `memoryId`（新しい記憶） | 小文字（前後とも） | 同じ | 同じ |
| 作られた記憶の `provenance.sources` | 小文字（前後とも。store が返した行の id） | 同じ | 同じ |
| 元の記憶の `supersededById`（`consolidate`） | 新しい記憶の id（前後とも） | 同じ | 同じ |
| `superseded` イベントの `memoryId`・`meta.supersededById` | 小文字（前後とも） | 同じ | 同じ |
| 返り値の `sources[].memoryId`・`basis[].memoryId` | 渡した綴りのまま（前後とも。ADR 0521 の材料2） | 同じ | 同じ |

- **前後で変わったのは `created` の `meta.sources` だけ**（`reflect({ seedMemoryId })` では種の綴りの1件）。他の欄は、直す前から小文字の正規形だった。
- **返り値の `memoryId` の echo は変えていない**: 渡した綴りのまま返る振る舞いは、ADR 0521 の材料2（公開の振る舞いの変更になる）。この ADR の範囲外。
- **`meta.sources` と同じ形で大文字が残る欄が、consolidate・reflect の経路にほかにあるか**【実測】: 上の欄をすべて見て、ほかには無かった。【現物】`runtime.ts` で `eligibleIds` から作って events に書く箇所は、この2つの `buildCreatedEvent` の `meta.sources` だけ（`abortIfForgotten`・`abortIfSuperseded` の `eligibleIds` は store の検査に渡す引数で、行には書かれない）。

## 決定

1. **`created` の `meta.sources` を、store が返した記憶の id で書く**【判断。約束（ADR 0521: Postgres は大文字の id を同じ行として受け、積む値は小文字の正規形）に、書く値を戻す】。`eligibleMemories` は `eligibleIds` と同じ順序・同じ件数なので、小文字で渡したときの値・並びは変わらない。
2. **Runtime の入口で揃える**【判断】。store 側で揃える必要は無かった: `created` イベントを組むのは Runtime（`buildCreatedEvent`）で、store は渡された `meta` をそのまま書くだけ（3実装とも）。Runtime で組む値を直せば、store を渡し替えても同じに効く。
3. **遡らない**。直す前に書かれた行の `meta.sources` は、大文字の綴りのまま残る。書き換える migration・バックフィルは作らない（依頼主の決め）。
4. 新しく断る入力は無い。公開 API・既定値・conformance suite は変えていない（ADR 0434 決定5）。

## 0521 の材料「Runtime が同じ記憶の2つの綴りを別の記憶として扱う」との関わり【実測】

`consolidate`・`reflect` の `memoryIds` に、同じ記憶の小文字と大文字を混ぜた `[a, A, b]` を渡すと、**2つ目の綴り `A` は `not_found`（`reflect` の `basis` も `not_found`）で、`sources` には `a`・`b` の1回ずつしか入らない**。3実装とも同じで、直す前から同じ。つまり、この直しで重複の判定は変わらない。重複判定は `memoryLookupKeyFor` が渡された綴りで突き合わせる Runtime の形で、**0521 の材料1のままにした（直していない）**。この ADR の歯の1本が、その今の振る舞いを縛っている（材料1を直すときに、意図して書き換える）。

## 歯（個別のテストファイル。conformance suite には足していない）

| ファイル | 内容 | 直す前に当てた赤 |
|---|---|---|
| `packages/core/src/__tests__/fake-sources-lowercase.test.ts`（4本） | Fake で、`consolidate`・`reflect`（`memoryIds`・`seedMemoryId`）の `meta.sources` が小文字、小文字で渡したときは変わらない（やりすぎの対照）、綴り違いの重複は `not_found` で `sources` に1回 | 2本が赤 |
| `packages/postgres/src/__tests__/consolidate-reflect-sources-lowercase.postgres.test.ts`（3本。実 Postgres） | Postgres・InMemory・Fake の3実装で、大文字・小文字の `created` の `meta.sources`・`provenance.sources`・`superseded` イベントの `memoryId` が小文字で同じ（`reflect({ seedMemoryId })` は近傍の取れ方が実装の ANN で違うので、種の1件が含まれ、すべて小文字であることだけを見る） | 3本が赤 |
| fuzz の不変条件 I15（`recall-invariant-fuzz-harness.ts`） | `consolidate` が積む `created` の `meta.sources` が小文字（下の変異試験） | `argupper` が赤 |

## fuzz と変異試験

- **fuzz の `argupper` の `consolidate` で拾えた**。harness の `consolidate` の操作に、積まれた `created` の `meta.sources` が小文字であることを見る不変条件 I15 を足した（操作の列は変えていない）。
- **変異: 直しを外す**（`runtime.ts` の `consolidate` の `meta.sources` を `eligibleIds` に戻す）【実測】:
  - core の Fake の fuzz: **`argupper` だけが赤**（`I15-sources-lowercase`、seed 2・6・9・12・13・17 ほか。大文字の `MEM-3` など）。`default`・`wide`・`fields`・`relations`・`argdead` は緑。
  - Postgres の fuzz: **`argupper` の leg だけが赤**（seed 2・6・9 ほか。大文字の uuid）。`default`・`fields`・`relations`・`argdead`・差分は緑。
  - 固定の歯: core の `fake-sources-lowercase` が 2 本、postgres の `consolidate-reflect-sources-lowercase` が 3 本、赤。戻した後は緑。
- **既存の profile の同じ seed の操作列が変わっていないこと**【実測】: 直前の harness（`6b80f6bd`）と、この枝の `genOps` の出力を、6 つの profile × seed 1〜500 × 長さ 60／120（6000 通り）で `JSON.stringify` が一致することを、使い捨ての試験で一度示した（この ADR は `genOps` を変えていない）。

## 実行時間【実測】

| ファイル | 足した分 |
|---|---|
| `recall-invariant-fuzz.postgres.test.ts` | I15 の追加による差は誤差の範囲（ファイル全体 131 秒。ADR 0521 の測定は 110 秒だが、`default`・`wide` が 23〜25 秒で、実行ごとのばらつき。I15 は `consolidate` の操作ごとに `eventStore.list` を1回呼ぶだけ） |
| `consolidate-reflect-sources-lowercase.postgres.test.ts` | 3本で約 10 秒（実 Postgres。記憶の再作成が支配的） |
| `fake-sources-lowercase.test.ts` | 4本、テスト本体は数十ミリ秒 |

## 探した形

- 操作 × 変形: `consolidate { memoryIds }`・`reflect { memoryIds }`・`reflect { seedMemoryId }` × 小文字／大文字 × 3実装。欄は `created` の `meta.sources`・イベントの `memoryId`・`provenance.sources`・`supersededById`・`superseded` イベントの `memoryId`/`meta`・返り値。
- 端の形: 同じ記憶を綴り違いで2回（`consolidate`・`reflect`）。
- fuzz の形: ADR 0494 の `argupper` の `consolidate`（半分の確率で id を大文字にする）。

## 検討した代替案

1. **store 側（`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の `buildCreatedEvent`）で `meta.sources` を小文字にそろえる**。採らなかった。`meta` は store が解釈しない値（ADR 0469 の注）で、3実装と外部の adapter それぞれに入れることになる。Runtime で正しい値を作るほうが1か所で足りる。
2. **`meta.sources` の綴りは変えず、文書に書く**。採らなかった。他の口（`forget`・`purge`・`markContested` ほか）が積む `meta`・`memoryId` は、大文字で渡しても小文字の正規形で、`meta.sources` だけが割れていた（ADR 0524）。
3. **既存の行も小文字に書き換える migration**。作らない（依頼主の決め。遡ってのデータの書き換えはオーナーの領分）。

## 引き受けた負債

| # | 負債 | 緊急度 |
|---|---|---|
| 1 | 直す前に書かれた `created` の `meta.sources` に、大文字の綴りが残る行がありうる。読む側が `meta.sources` を id として引くときは、大文字小文字を区別しないで突き合わせる必要がある（Postgres の uuid は区別しない） | 低。【未確認】実際に大文字の行が在るかは、本番のデータでは見ていない |
| 2 | 返り値の `memoryId` の echo・綴り違いの重複の扱いは、ADR 0521 の材料1・2のまま | 低 |

## これが覆るとしたら

オーナーが、`meta.sources` を呼び出し側の綴りのまま残す約束にすると決めたとき（`created` の `meta` を呼び出しの記録として扱う場合）。既存の行も揃えると決めたとき（migration は別の判断）。

## 測っていないこと

- `tick` 経由（outbox の `consolidate`・`reflect` のジョブ）で `meta.sources` が組まれる経路（同じ `buildCreatedEvent` を通る【現物】が、実行は確かめていない）。
- 実 API（LLM）。
