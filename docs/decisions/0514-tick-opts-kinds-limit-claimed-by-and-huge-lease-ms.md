# ADR 0514: `Runtime.tick` の `opts.kinds`・`limit`・`claimedBy` と、保存できない巨大な `leaseMs` を、claim の前に名指しで断る（ADR 0496「引き受けた負債」の5と1）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。オーナーが v1.X.0 で破壊的変更を許したので、「型の外の入力を新しく例外で断る」直しはクローンが決めてよい。公開 API（export）は足していない。新しい例外クラスも作っていない（`TypeError`・`RangeError`）。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元の Postgres 17（UTF8・`C.UTF-8`、ポート 55440）で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: [ADR 0496](./0496-core-entry-rejections-adr-0446-0445-0472-0474-0485.md) は `tick` の `opts` と `opts.leaseMs`（有限の数）だけを入口で断り、次を「引き受けた負債」に残した。負債5「`opts.kinds`・`limit`・`claimedBy` など、`leaseMs` 以外の欄の型の外の値は、今までどおり検査しない」、負債1「巨大な有限の `leaseMs`（例 `1e20`）は、store が落ちる」。どちらも「同じ作法で足す」と決めれば直せる、と書いてあった。

## 着手前に現物を読んで、直す前の振る舞いを測った（3者に同じ入力を流した）

【実測】`tick` に型の外の値を渡したときの、直す前の顔。Fake は core の `FakeOutboxStore`、InMemory は testkit、PG は `PostgresOutboxStore`。「通る」は、例外にならず tick が返ること。

| 入力 | Fake | InMemory | PG |
| --- | --- | --- | --- |
| `kinds: "extract"`（裸の文字列） | 通る（`includes` が部分文字列の照合になる） | 通る（同じ） | `DrizzleQueryError`（22P02） |
| `kinds: null`・`[1]`・`["extract", null]` | 通る | 通る | 通る（`ANY(NULL)` は0件、`1` は文字列として照合） |
| `kinds: {}`・`5` | `TypeError`（`opts.kinds.includes is not a function`） | 同じ | `DrizzleQueryError`（`5`） / 通る（`{}`） |
| `limit: "5"`・`null` | `Error`（`"5"`）/ 通る（`null`） | 同じ | 通る（Postgres が `"5"` を数に直す） |
| `limit: NaN`・`Infinity`・`-1`・`1.5`・`2^63` | 名前の無い `Error`（`claimBatch: limit must …`） | 同じ | `DrizzleQueryError`（22P02・2201W・22003） |
| `claimedBy: 5`・`null`・`{}` | 通る | `TypeError`（`includes is not a function`）/ 通る | 通る（text 列に入る） |
| `claimedBy` に NUL | 名前の無い `Error` | 同じ | `DrizzleQueryError`（22021） |
| `leaseMs: 1e20`・`-1e20` | 名前の無い `Error`（`now - leaseMs must be a valid Date`） | 同じ | `DrizzleQueryError`（22007） |
| `leaseMs: 3e14`（`Date` としては有効、紀元前4714年より前） | **通る**（何も claim しない） | **通る** | `DrizzleQueryError`（22008） |

【判断】読み取ると、(a) 同じ入力で store ごとに顔が違う、(b) **例外にならず黙って別の結果になる入力がある**（裸の文字列の `kinds`、`claimedBy: 5`、`limit: "5"`）、(c) `leaseMs` の範囲は、Fake・InMemory が `Date` の範囲だけを見て、Postgres の下限（`timestamptz`）を見ないので、`3e14` が Postgres だけで落ちる、の3点。ADR 0496 は `leaseMs` について「3者で顔が違う」を Runtime の入口で揃えた。同じ作法を残りに足す。

## 決めたこと

`tick` の入口で、`claimBatch` を呼ぶ前に、次を断る。`undefined` は省略と同じ（今までどおり）。**メッセージは入力値を含めない**（ADR 0496 の既存の2つと同じ書き方）。

1. **`opts.kinds`** が配列でない（裸の文字列・`null`・object・数）、または文字列でない要素を含む: `TypeError`（`Runtime.tick: opts.kinds must be an array of strings`）。**空配列は断らない**（`TickOptions.kinds` の TSDoc が「何も claim しない」と書いている）。
2. **`opts.limit`** が、0 以上 2^63 未満の整数でない（文字列・`null`・`NaN`・`±Infinity`・負・小数・2^63 以上）: `RangeError`（`Runtime.tick: opts.limit must be an integer from 0 up to (not including) 2^63`）。**`limit: 0` は断らない**【判断】: TSDoc が「`0` なら何も claim しない」と書いており、3者とも実際に何も claim せず例外にもしない【実測】（陽性対照で 3 者を確認）。断ると、TSDoc の約束と、0 を渡して「今回は claim しない」を表している呼び出しを壊す。上限の 2^63 は、Postgres の `LIMIT` の `bigint` と、Fake・InMemory が既に使っている境界（`claimBatch: limit must fit in a Postgres bigint`）に揃えた。
3. **`opts.claimedBy`** が文字列でない（`null`・数・object）: `TypeError`（`Runtime.tick: opts.claimedBy must be a string`）。NUL（U+0000）を含む: `RangeError`（`Runtime.tick: opts.claimedBy must not contain NUL characters (U+0000)`。[ADR 0493](./0493-fake-and-inmemory-input-checks-aligned-to-postgres.md) が store の側で断っていたものを、Runtime の入口でも断る）。**空文字は断らない**（TSDoc が「省略と同じにはならず、そのまま渡る」と書いている）。
4. **`opts.leaseMs`** が有限の数でも、`now - leaseMs`（`now` は `RuntimeConfig.clock` の今）が、`Date` の範囲外、または Postgres の `timestamptz` の下限（4714-11-24 BC、`-210866803200000` ms）より前になるとき: `RangeError`（`Runtime.tick: opts.leaseMs is out of range (now - leaseMs must be a timestamp every store can hold)`）。下限は【実測】で確かめた（`'4714-11-24T00:00:00.000+00:00 BC'::timestamptz` は通り、1ミリ秒前は `timestamp out of range`）。**下限ちょうどは通す**。**0 以下の `leaseMs` は断らない**【判断】: `TickOptions.leaseMs` の TSDoc が「今の振る舞い」として書いている（ADR 0496 決定3と同じ。変えない）。負で大きい値（例 `-1e14`）も、`now - leaseMs` が保存できる範囲なら通る。`now` 自体が壊れた `Date` を返す時計は、ここでは見ず、今までどおり store が断る。
5. **例外の型の選び方**【判断】: 既存の検査（`opts` が object でない → `TypeError`、`leaseMs` が有限の数でない → `RangeError`）に揃えた。欄の型が違えば `TypeError`（`kinds`・`claimedBy`）、型は合っているが値が許す範囲の外なら `RangeError`（`limit`・`leaseMs`・NUL）。ただし `limit` は、数でない値も含めて `RangeError` にした（`leaseMs` が「有限の数でない」を `RangeError` にしているのと同じ。`Number.isInteger` 1つで落とせる）。
6. 3者で同じ種類・同じメッセージになる。Runtime の入口で断るので、store の実装には手を入れていない（Fake・InMemory・Postgres の `claimBatch` の検査はそのまま。直接 `claimBatch` を呼ぶ人の顔は変わらない）。`TickOptions` の `kinds`・`limit`・`claimedBy`・`leaseMs` の TSDoc に追記した。

## 採らなかった案

1. **`limit: 0` も断る**。決定2のとおり採らない（TSDoc の約束を壊す）。
2. **`leaseMs` を「正の数」に絞る**。ADR 0496 が採らなかった案のまま採らない（0 以下は TSDoc が「今の振る舞い」として書いている）。この ADR は「保存できない値」だけを断る。
3. **裸の文字列の `kinds` を `[文字列]` に包んで通す**。ADR 0496 の `excludeMemoryIds` と同じ理由で採らない（呼び出し側の取り違えを黙って直さない）。
4. **store の `claimBatch` の側に検査を足す（Postgres に `limit`・`leaseMs` の検査を足す）**。採らない。Runtime の入口 1 か所で、3者が揃う。store を直接呼ぶ人（自前の `OutboxStore` の利用者）の顔までは、この ADR では動かさない。
5. **`leaseMs` の下限を Date の範囲（`-8.64e15`）で打ち切る**。採らない。それだと `3e14` が Fake・InMemory だけで通り、Postgres で落ちる食い違いが残る（上の表）。

## 引き受けた負債（材料）

| # | 負債 | 覆る条件 |
| --- | --- | --- |
| 1 | `leaseMs` が 0 以下の `tick` は、今までどおり通る（重複 claim を許す） | オーナーが「正の数に絞る」と決めたとき（ADR 0496 の負債1の残り） |
| 2 | `leaseMs` の下限は Postgres の `timestamptz` の値を core に書いた定数（`MIN_STORABLE_TIMESTAMP_MS`）で持つ。Postgres 以外の store が、これより狭い範囲しか持てないなら、その store は自前で断る | 別の store の実装が、この下限と食い違うと分かったとき |
| 3 | `kinds` の要素の中身（空文字・未知の種類・NUL）は検査しない。未知の種類は `unsupported` として `fail` に落ちる（ADR 0082）。NUL を含む `kinds` の要素の Postgres の顔は測っていない | 同じ作法で足すと決めたとき |
| 4 | `tick` が呼ぶ `claimBatch` を、`OutboxStore` を直接呼ぶ人の側は、3者で顔が違うまま（Fake・InMemory は名前の無い `Error`、Postgres は `DrizzleQueryError`） | オーナーが store の `claimBatch` の約束に断り方を足すと決めたとき（conformance suite に約束を足すのはオーナーの領分、ADR 0434 決定5） |
| 5 | `limit` が 2^63 未満でも、実用上は巨大（例 `2^62`）な値は通す。Postgres は受け付け、件数の上限としては実害がない | — |

## これが覆るとしたら何が起きたときか

オーナーが「`tick` の `opts` は、型の外の値を断らない」と線を引き直したとき、または `limit: 0` を断ると決めたとき（決定2の1行）。

## 測ったこと

- 【実測】歯 2 ファイル: `packages/core/src/__tests__/tick-opts-validation.test.ts`（core の Fake、28件）、`packages/postgres/src/__tests__/tick-opts-validation.postgres.test.ts`（testkit の InMemory と実 Postgres、各28件で計56件）。断る入力 21 件と、断らない入力（陽性対照）7 件の同じ表（`EXPECTED`・`ACCEPTED`）を、3者に流す。直す前は、Fake 21 件が赤・7 件が緑、InMemory と Postgres の側は 42 件が赤・14 件が緑。直して全部緑。種類（`constructor`）とメッセージを `toBe` で縛り、`cause` が無いこと、`claimBatch` が呼ばれないこと、落ちた tick のあとの正しい tick がジョブを取れることを見る。
- 【実測】変異（Fake の歯を、`runtime.ts` の検査を1つずつ外して走らせた。足りない実装・やりすぎの実装）: `kinds` の検査・要素検査・`limit` の上限・小数・負・`claimedBy` の型・NUL・`leaseMs` の下限・`Date` の範囲・下限の境界（`<` を `<=` に）はどれも赤になった。やりすぎ（`limit: 0`・`leaseMs` が 0 以下・`claimedBy` の空文字・`kinds` の空配列も断る）も赤になった。最初の一覧で `limit` の `typeof` 検査を外す変異だけが緑のまま残った（`Number.isInteger` が数でない値を落とすので、同値の変異）。検査から外して、`Number.isInteger` 1つにした。変異は退避した版を `cp` で戻した。
- 【実測】関連する既存の歯は緑のまま: core の `tick-*`・`fake-tick-*`・`runtime-tick-*` 8 ファイル（59件）、`tick-lease-ms-validation.test.ts`、postgres の `runtime-entry-exception-kinds.postgres.test.ts`・`readme-unbound-promises`・`tick-batch-exceeds-lease-parity`・`tick-last-error-cause`。全テストは走らせていない。
- 【未確認】SQL_ASCII の脚（検査は DB に触れる前に落ちるので、encoding に依らない作りだが、走らせていない）。`@mnemora/bullmq`・`examples/` のテスト（`tick` を呼ぶ側が、上の入力を渡していないことは grep で見たが、走らせていない）。NUL を含む `kinds` の要素。別の `OutboxStore` 実装（自前）の `claimBatch` の顔。
