# ADR 0684: 09/28 にマージされた D 群7本（#1305・#1306・#1312・#1314・#1323・#1328・#1333）の確かめ直しで見つかった穴に歯を足す（Issue #1827）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1827](https://github.com/takecchi/mnemora/issues/1827)。
これは試験だけの変更で、実装（TSDoc を含む）・`*-conformance.ts`・`__fixtures__/`・core の Fake（`runtime-fakes.ts`）は触らない（変異を一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた）。
D 群の7本は、`src` の差分が TSDoc だけで、公開の約束を書いたうえで歯も足した PR である。TSDoc は公開の約束なので、まず「いまの main のコードが、いまの TSDoc の言うとおりに動くか」を確かめ、そのうえで約束ごとに足りない側とやりすぎた側の変異を当てた。

## 経緯【実測】

結果の表は Issue #1827 のコメントにある。約束が後の採用済み ADR・後の変更で動いていた点は次のとおり。

- 逆になったので当てていない約束: #1305 の「退けた記憶の Observation に `reextract` を呼ぶと、言い換えた事実が `active` で戻る」、#1306 の「保存できない候補の手前の候補が残って `observe` が投げる」「`extract` のジョブは再配達で LLM の出力が変わると冪等にならない」「語の多い 1MB 超の本文は Postgres だけが拒む」（ADR 0347・ADR 0364）、#1323 の「`leaseMs` を省略したときの例外は store が投げ、顔が store で違う」（ADR 0496）。いまの約束は TSDoc の新しい節に書き換わっていて、その多くは A・B・C 群の確かめ直しが当てている。
- 広がっただけなので、いまの約束に当てたもの: ADR 0380（`reextract` が版を跨いで退けた記憶を見る）、ADR 0496（`findCorrectionCandidates` の入力・`resolveContested` の `resolution.kind` を断る）、ADR 0521（fixture も大文字小文字を区別しない）。

## TSDoc とコードの食い違い（直していない）

- #1312 の `VectorStore.searchMany?` の TSDoc と CHANGELOG の1行は、「同じ key のうち前のクエリだけが投げる入力（float4 の範囲を超える有限の値、例 `1e39`）」を例に挙げる。ADR 0424 以降、`PostgresVectorStore` は float4 に収まらない成分のクエリを比較不能として全 0 ベクトルへ差し替えるので、`search()` も `searchMany()` も投げない（`1e39`・`-1e39`・`Number.MAX_VALUE` を実測）。DB が拒むクエリの入力は無く、この例は成り立たない。コードが正しく、TSDoc の例が古い（「投げる入力は減る側にしか変わらない」は、投げる入力が無いので空に成り立つ）。直すかはオーナーの判断として残す。

## 足した歯

| PR    | すり抜けた変異                                                                                                          | 歯                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| #1312 | `searchMany` だけが float4 に収まらない成分の検査を持たない（`search()` は投げず、`searchMany` だけが投げる）            | `packages/postgres/src/__tests__/vector-search-many-float4-out-of-range.postgres.test.ts` |
| #1314 | 活動軸の述語が、床が `NULL` の記憶も沈める形になる（`'either'` へ切り替えた場面に歯が無かった）                         | `packages/postgres/src/__tests__/wall-to-either-switch.postgres.test.ts`                 |
| #1333 | `restoreArchived`・`purge`・`consolidate`・`reflect` の鍵が、並びの先頭の綴りに依存する（位置によらない、の歯が無い） | `packages/postgres/src/__tests__/uppercase-uuid-spelling-position-other-mouths.postgres.test.ts` |

歯は、元の変異を当てると赤になることを確かめてから入れた。

## 塞がなかったもの

- 名指しの歯は緑のままだが、別のファイルが赤にしたもの: 活動軸の「床が `NULL` なら生きている」の述語（#1314。`decay-activity-clock-parity`）、`'either'` の掃引を AND から OR にする変異（#1314。約束の外で、`decay-activity-clock-parity` が赤）、`findCorrectionCandidates` の `limit` の整数検査と下限（#1323。`correction-candidates`）、`resolveContested` の同じ id の例外の種類（#1323。`resolve-contested`）、`consolidate`・`reflect` の対象の status の門（#1306。`consolidate`・`reflect`。再配達の場面では結果が同じで等価）。重ねて歯を足さない。
- 確かめていない: `markContestedGroup`・`resolveContestedGroup` の鍵の位置（#1333 の約束と同じ形だが、この口に混ぜた綴りを渡す歯を書いていない）。

## これが覆るとしたら

`memoryLookupKeyFor` の突き合わせを、位置に依存する規則や、store に在るかどうかを Runtime が決める形へ変えるとき。活動軸の述語が床の無い記憶を沈める形へ変わるとき（ADR 0165 の追記2 の契約が覆る）。
