# ADR 0049: `reinforce` の単調性を擬似物にも揃える——新しい決定ではなく、ADR 0048 の追随

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## これは新しい決定ではない

ADR 0048（#52）は `PostgresMemoryStore.reinforce` に「減衰の起点を巻き戻さない」
（狭義の `<`。`last_reinforced_at IS NULL OR last_reinforced_at < ${at}` を `WHERE` 句に
入れ、同じ `at` は no-op、古い `at` は例外にしない）という意味論を*決めた*。ADR 0048 自身が
「引き受けた負債」として明記していたとおり、`InMemoryMemoryStore`（`packages/testkit`）は
このとき直されておらず、無条件に `memory.lastReinforcedAt = at` を代入し続けていた。

**本 ADR は、その意味論を擬似物（`InMemoryMemoryStore`・`FakeMemoryStore`）へ揃えるだけであり、
`reinforce` の振る舞いそのものについて新しい判断は一切下していない。**

## まず数えた: 時刻・順序・単調性に関わる箇所は、3実装のあいだでどれだけ割れているか

**出所: 私が実行した。** `packages/postgres/src/*.ts`・`packages/testkit/src/__fixtures__/*.ts`・
`packages/core/src/__tests__/runtime-fakes.ts` を対象に、時刻を書く・順序を決める・
単調であるべき値を持つ箇所（`updatedAt`/`recordedAt`/`at`/`availableAt`/`claimedAt`/
`completedAt`/`failedAt`/`createdAt`/ソート順・`now()` の使い方）をすべて洗い出し、
3実装それぞれの振る舞いを突き合わせた。

| # | 箇所 | Postgres | InMemory / Fake | 割れているか |
|---|---|---|---|---|
| 1 | `MemoryStore.reinforce` の `lastReinforcedAt`/`decayFloorAt` | 狭義の `<`（ADR 0048） | **無条件代入（巻き戻る）** | **割れている**（本 ADR で塞ぐ） |
| 2 | `EventStore.list` の `at` 同値のタイブレーク | 規定されない（`ORDER BY` のみ） | 安定ソート（挿入順） | 割れていない前提で揃えてある（ADR 0042 で「規定しない」と明記済み） |
| 3 | `EventStore.list` の `since`/`until` 境界 | 両端含む | 両端含む | 割れていない |
| 4 | `OutboxStore.claimBatch` の `available_at`/リース境界 | ADR 0032 の意味論 | 同じ意味論（ADR 0032 で明示的に揃えた） | 割れていない |
| 5 | `OutboxStore.claimBatch` の `available_at` 同値のタイブレーク | 規定されない（`ORDER BY` のみ） | 安定ソート（挿入順） | 到達する壊れ方を特定できていない（下記） |
| 6 | `OutboxStore.complete`/`fail` の `completed_at`/`failed_at` | 無条件に `now()` で上書き（べき等な終端更新、既存の判定） | 同じ | 割れていない |
| 7 | `VectorStore.upsert` の `created_at`（last-writer-wins） | 無条件上書き | 無条件上書き | 割れていない（ADR 0048 の台帳で既に「実害を特定できない」と判定済み） |
| 8 | `VectorStore.search` の距離昇順ソート・同値のタイブレーク | 規定されない（`ORDER BY` のみ） | 安定ソート | 到達する壊れ方を特定できていない（下記） |
| 9 | `updateStatus`/`updateStatusWithEvent` の `updated_at` | 無条件に `now()` | 無条件に `new Date()` | 割れていない（CAS は status のみで判定、時刻に依存しない） |
| 10 | `aggregateScope` の期間境界（`occurredAfter`/`occurredBefore`） | 両端含む | 両端含む | 割れていない（ADR 0039 で決定済み） |
| 11 | `createObservation`/`createMemory` の `recordedAt` 既定値・`created_at`/`updated_at` | `?? new Date()` / `now()` | 同じ既定 | 割れていない |

**結果: 実際に割れているのは #1（`reinforce`）の1箇所だけだった。**

### 順位から外したもの

- **#2・#4・#6・#7・#9・#10・#11**: 割れていない（別実装が同じ意味論を持つ）ため、
  順位そのものが発生しない。
- **#5（`claimBatch` の同値タイブレーク）・#8（`VectorStore.search` の同値タイブレーク）**:
  **到達する壊れ方を特定できていない。** どちらも Postgres の `ORDER BY` が同値行の順序を
  保証しないため（ADR 0042 が `EventStore.list` について明記したのと同じ理由）、
  擬似物の安定ソート（挿入順）と一致するとは限らない。しかし
  `claimBatch` は同一トランザクション内で複数ジョブを作ると `now()` がトランザクション
  開始時刻に固定されて `available_at` が同値になりうる（`createMemoryWithOutbox` の
  ループ）という到達しうる筋は見えたが、**実際に選ばれるジョブ集合が Postgres と擬似物で
  食い違うかは実測していない。** `VectorStore.search` も同様に、同一クエリベクトルに対して
  複数の memory が同じ距離を持つ場合にしか観測されず、その分布を作って検証していない。
  ⟹ どちらも順位から外し、**測っていないので「割れている」とは書かない。**

**⚠ マネージャーの見立て（`reinforce` の1箇所）と、実際に数えた結果（同じく1箇所、
ただし追加で「到達する壊れ方を特定できていない」候補が2件見つかった）は一致した。**

## `decayFloorAt` の非対称の有無（実測）

**出所: 私が `packages/core/src/strategies/decay.ts` の `floorAt` を読んで確認した
（推測ではない）。**

```
floorAt(params) = base + hours * MS_PER_HOUR   // strength > threshold の場合
floorAt(params) = base                          // strength <= threshold の場合
base = lastReinforcedAt ?? recordedAt
```

`reinforce` は同一呼び出しの中で `strength`/`halfLifeHours`/`recordedAt` を変更しない
（`docs/decisions/0041-reinforce-does-not-change-strength.md`）ため、`hours`
（`strength`/`halfLifeHours`/`threshold` だけで決まる定数）は1回の `reinforce` 呼び出しの
前後で変わらない。**⟹ `floorAt` は `lastReinforcedAt` に対して傾き1のアフィン変換であり、
`lastReinforcedAt` を単調に保てば `decayFloorAt` も自動的に単調に保たれる。** 両者に別々の
非対称は無い。

## 決定

`InMemoryMemoryStore.reinforce`（`packages/testkit`）と `FakeMemoryStore.reinforce`
（`packages/core/src/__tests__/runtime-fakes.ts`）を、`PostgresMemoryStore.reinforce`
（ADR 0048）と同じ意味論にする:

- `lastReinforcedAt` が `null`、または現在の `lastReinforcedAt < at` のときだけ、
  `lastReinforcedAt`/`decayFloorAt`/`updatedAt` をまとめて更新する（狭義の `<`。
  同じ `at` は no-op）。
- 古い `at` は例外にしない。no-op のまま、現在の（更新されなかった）行を返す
  （ADR 0048 と同じ理由——`runtime.observe` の使用報告ループの次の一手が無い）。

## 歯を2箇所に置いた

1. **`packages/testkit/src/memory-store-conformance.ts`**（Postgres と in-memory の
   両方に走る）に2本追加した——巻き戻らないこと、同じ `at` が狭義の `<` の境界で
   no-op であること。
2. **`packages/core/src/__tests__/fake-reinforce-monotonicity.test.ts` を新設した。**
   `FakeMemoryStore` は適合スイート（`describeMemoryStoreConformance`）の対象外である
   ——対象は `InMemory*` であり、`packages/core` 専用の `Fake*` には適合テストが届かない
   （ADR 0047 の「これが覆るとしたら」・PR #36/#45/#53 で実際に起きた形と同じ）。
   `InMemoryMemoryStore` だけを直しても、`FakeMemoryStore` 側の巻き戻りは
   どこからも測れないままになる。実際に、この歯を置く前に `FakeMemoryStore.reinforce`
   のガードを丸ごと外す変異を撃つと、`packages/core` の既存テストは1本も赤くならなかった
   （後述）。

## 歯の作法

- **前提（操作が効いていること）を同じ歯の中で先に固定した。** 4本すべての変異撃ちで
  「対象の操作（`reinforce` のガード）を丸ごと削除する」変異を撃ち、新設した歯が
  実際に赤くなることを確認した（下記）。
- **フィクスチャの初期値を既定値と一致させない。** 境界の歯は、`lastReinforcedAt` が
  `null`（既定値）のままでは「同じ `at`」の意味を持てないため、先に1回 `reinforce`
  して具体的な値を作ってから境界を検査する。
- **返り値だけでなく `store.get()` で読み直しても同じかを見る。**
- **境界（同じ `at` は no-op）の歯は `updatedAt` で判定する。** `lastReinforcedAt`/
  `decayFloorAt` は「同じ値を書き直す」実装と「書かない」実装を区別できない
  （ADR 0048 の Mu2 と同じ理由）。
- **⚠ `first`/`again` の比較はプリミティブへ即座に写し取ってから行う。** in-memory
  実装は Map に入れた行オブジェクトへの参照をそのまま返すため、`first.updatedAt`
  を2回目の呼び出しのあとまで保持すると「別の読み取り」ではなく「同じオブジェクトの
  自己一致」になり、歯が常に緑になる。実際にこの取り違えで変異が生き残ることを
  確認した上で、`number` に写し取る書き方に直した（後述）。

## 変異（実装ごとに分けて記録）

**基準線**（本 PR 着手前、`main` = `6b8a12a` を手元で実測）: `set -o pipefail` を打って
`typecheck && lint && format:check && test && build` を実行、`EXIT=0`。
`root` 7 / `core` 284 / `testkit` 117 / `openai` 18 passed・2 skipped。`DATABASE_URL`
未設定のため DB テストは実行していない。

### 段0（木に載ったか）と `dist` の注意

`packages/testkit/package.json` は `main: "./dist/index.js"` で `exports` を持たない。
`@mnemora/testkit` を import する側（`packages/postgres` のテスト）は `dist` を読むため、
`packages/testkit/src/` への変更は再ビルドなしには届かない。**手元で撃った変異が対象に
できたのは、相対 import で `src` を直接読む
`packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts` と、
`packages/core` のテストだけである。** `git diff --numstat` で変異が実際に木に載ったことを
毎回確認した。

### `InMemoryMemoryStore.reinforce`（`packages/testkit`、対象は上記の in-memory 適合テスト）

| # | 変異 | 段1 | 段2（走った歯） | 段3・段4 | 結果 |
|---|---|---|---|---|---|
| M1 | ガード（`if` ブロック）を丸ごと削除（＝直す前の姿） | SKIP なし | 119件（基準線どおり） | 私のアサーション由来（`TypeError` 0件） | **死亡**（2件赤: 巻き戻りの歯・境界の歯の両方） |
| M2 | `>=` を `>` に変える（Postgres の `<` → `<=` に相当する境界シフト） | SKIP なし | 119件 | 私のアサーション由来 | **死亡**（境界の歯**だけ**が赤——巻き戻りの歯は緑のまま。段3が求める「固有に捕まえる」を満たす） |
| M-del | `reinforce` の本体を「何もしない」に丸ごと差し替える（対象の操作の削除） | SKIP なし | 119件 | 私のアサーション由来 | **死亡**（4件赤: 既存の2本＋新設の2本すべて。作法1の確認） |

### `FakeMemoryStore.reinforce`（`packages/core`、対象は `fake-reinforce-monotonicity.test.ts`）

| # | 変異 | 段1 | 段2（走った歯） | 段3・段4 | 結果 |
|---|---|---|---|---|---|
| M3 | ガードを丸ごと削除 | SKIP なし | 288件（基準線どおり） | 私のアサーション由来 | **死亡**（2件赤） |
| M4 | `>=` を `>` に変える | SKIP なし | 288件 | 私のアサーション由来 | **死亡**（境界の歯**だけ**が赤） |
| M-del | 本体を「何もしない」に丸ごと差し替える | SKIP なし | 288件 | 私のアサーション由来 | **死亡**（4件赤: 新設3本＋`runtime.test.ts` の既存1本） |

**生存した変異は無い。** 途中で1件、境界の歯そのものの欠陥（`first`/`again` の比較が
同一オブジェクト参照どうしの自己一致になっていて、ガードを丸ごと外す変異でも
緑のままになっていた）を発見し、プリミティブへ即座に写し取る書き方に直してから
上記の結果を得た——この経緯は歯の作法として本文にも明記した。

### `PostgresMemoryStore.reinforce`（撃てない）

この器に PostgreSQL も Docker も `DATABASE_URL` も無い。**撃っていない。** ADR 0048 が
Postgres 側で既に同種の変異（`<` → `>`・`<` → `<=`・条件行の削除・返り値の差し替え）を
実測済みであり、本 ADR は Postgres 側のコードを一切変更していないため、その結果は
そのまま有効なはずである——**ただし、これは予測であり実測ではない。**

## 採らなかった案

| 案 | 採らない理由 |
|---|---|
| `InMemoryMemoryStore`/`FakeMemoryStore` のどちらか一方だけを直す | ADR 0047・PR #53 と同じ理由——2つの擬似物のうち1つだけを揃えると、新しい非対称を作る |
| 適合スイート側の歯だけを置き、`FakeMemoryStore` 側は据え置く | `FakeMemoryStore` は適合スイートの対象外なので、それでは何も測れないまま直したことになる（本文参照） |
| 境界の歯を `lastReinforcedAt`/`decayFloorAt` の値一致だけで済ませる | ADR 0048 の Mu2 がすでに示したとおり、`<=` の実装と `<` の実装は同じ `at` を渡すと同じ値になり区別できない |

## 引き受けた負債

- **`OutboxStore.claimBatch`・`VectorStore.search` の同値タイブレークは、擬似物と
  Postgres で一致する保証が無いままである。** 到達する壊れ方を特定できておらず、
  本 ADR では踏み込んでいない（上記「順位から外したもの」参照）。
- **契約の本文（`MemoryStore.reinforce` の interface doc）は本 PR でも更新していない。**
  ADR 0048 が引き受けた負債と同じであり、範囲を広げていない。

## これが覆るとしたら

- ADR 0048 の「これが覆るとしたら」と同じ——`strength`/`half_life_hours`/`recordedAt`
  を作成後に書き換える経路が入るとき、または「強化」が起点を前へ動かすことも許すと
  決まるとき。
- `OutboxStore.claimBatch`・`VectorStore.search` の同値タイブレークについて、
  実際に到達する壊れ方が実測されたとき——そのときは順位を付け直す必要がある。
