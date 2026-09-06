# ADR 0039: `period` の判定規則が4箇所に在ることを、境界の歯で固定する

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-06

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## 文脈

**壊れているものを直す ADR ではない。今日は4つとも一致している。**
**危険は「将来どれか1つを直したとき、他が追随しないこと」である。**

### 数えたこと（**私が実行した**。`effectiveTime` / `COALESCE(occurred_at` / `occurredAfter` の全出現を見た）

`period`（`occurredAfter` / `occurredBefore`）の判定は **4箇所**にある:

| # | 場所 | 形 | 境界 |
|---|---|---|---|
| 1 | `packages/core/src/recall-runtime.ts:196-198` | `effectiveTime < scope.occurredAfter` なら `continue` | **含む** |
| 2 | `packages/postgres/src/memory-store.ts:536-538` | `COALESCE(occurred_at, recorded_at) >= $1` | **含む** |
| 3 | `packages/testkit/src/__fixtures__/in-memory-memory-store.ts:364-367` | `effectiveTime >= scope.occurredAfter` | **含む** |
| 4 | `packages/core/src/__tests__/runtime-fakes.ts:392-395` | `effectiveTime >= scope.occurredAfter` | **含む** |

**⚠ 4つ目（`packages/core` のテスト用 fake）は見落とされやすい。**テスト用ではあるが、
**`packages/core` 自身の recall の歯が測っているのはこの実装である。**ここが本番と割れると、
core の歯は「本番とは違うもの」を測ったまま緑になる。

**そして「実効時刻」の定義（`occurredAt ?? recordedAt`）は、もう1箇所ある**——
`packages/core/src/strategies/scoring.ts:82` の `freshness` の起点である。
`memory-store.ts:534` のコメント自身が「`docs/recall.md` §7 の freshness 計算が
`occurred_at ?? recorded_at` を使うのと同じ規約」と両者を結びつけている。
**⟹ 同じ定義が合計5箇所にあり、片方の規約を変えても、もう片方は黙って古いままになる。**

### 1と2/3/4 が食い違うと何が起きるか

**1は「何が返るか」を決め、2/3/4は「`omitted` が何と言うか」を決める。**
⟹ **食い違うと `omitted` が嘘をつく。**この repo で `omitted` が嘘をつくのは芯が破れることである
（[ADR 0011](./0011-no-window-count-in-ann-stage.md) / [0025](./0025-ann-underfill-is-not-reported-in-omitted.md) /
[0027](./0027-split-superseded-forgotten-omission.md) / [0028](./0028-reextract-superseded-cleanup.md) と同じ族）。

### 🔴 既存の歯は、規則を丸ごと反転させても素通りしていた（**私が実行して確かめた**）

`packages/testkit/src/memory-store-conformance.ts` に period の歯が1本あった。中身は
**「外側1件・内側1件を作り、`totalInScope === 1` と `filteredPeriod.count === 1` を見る」**である。

**⟹ 内外を反転させる実装でも、同じ 1 / 1 が出る。**フィクスチャが対称なので、
**どんな変異を撃っても生き残る。**（実際に反転の変異を当てて確かめた。§検査を参照。）

**さらにこの歯は:**

- **境界そのもの（`occurredAt === occurredAfter`）を測っていない**（2020年と2026年、境目は2025年）。
- **`occurredBefore` を一度も測っていない**——にもかかわらず**題は
  「occurredAfter/occurredBefore の外にある Memory を…」と名乗っていた。**
  **⟹ 名乗りが実測より強い。**本 ADR で題を実測に合わせた（`occurredAfter` だけに直した）。
- **`occurredAt` が `null` のとき `recordedAt` に落ちること**を測っていない。

---

## 決定

1. **`memory-store-conformance.ts` に境界の歯を4本足す。**適合テストなので
   **postgres と in-memory の両方**（上の表の2と3）に対して**同じ歯**が走る。
   - `occurredAfter` の境界を含むこと
   - `occurredBefore` の境界を含むこと
   - **⚠ 鳴ってはいけない側**: どちらも渡さなければ period は一切絞らないこと
   - `occurredAt` が `null` のとき `recordedAt` を実効時刻に当てること
2. **🔴 フィクスチャを非対称にする。**「境界1件 / 内側3件 / 外側5件」→ `totalInScope = 4`、
   `filteredPeriod = 5`。**反転すれば 5/4、境界を外せば 3/6、絞らなければ 9/0** と、
   どの壊し方でも別の組になる。**対称な件数では規則の反転が観測できない**（上記）。
3. **`packages/core` に、候補フィルタと `aggregateScope` が同じ境界で一致することを測る歯を足す**
   （`observe-occurred-at.test.ts`）。**適合テストは `recall()` を呼ばないので、表の1には届かない。**
   境界ちょうどと**その1ミリ秒外**を並べ、
   「返った件数」と「`omitted` が落ちたと言う件数」の合計が取り込んだ件数と一致することまで見る。
4. **🔴 判定規則そのものは1行も変えない。**今日は4つとも一致しており、変える理由が無い。

---

## 検査が届いていない範囲（**塞いでいない**）

- **表の4（`packages/core` の `FakeMemoryStore.aggregateScope`）に、適合テストは届かない。**
  `packages/core` は `packages/testkit` を import できない（`packages/core` の実行時依存が
  zod だけ、という規律。`dependency-boundary.test.ts` が機械的に測っている）。
  **決定3の歯は、この fake を*経由して*候補フィルタとの一致を見るので、
  fake と本番 adapter が割れた場合はこの歯が気づく——が、fake だけが正しく本番が割れた場合は
  適合テストの側が気づく。両方が同じ方向へ割れた場合は、どちらも気づかない。**
- **`freshness` の起点（`scoring.ts:82`）と period の実効時刻を、同じ定義だと固定する歯は無い。**
  片方の規約を変えても、もう片方は黙って古いままになる。
- **タイムゾーンの扱いは測っていない。**すべて `Date` / `timestamptz` の UTC 比較であり、
  現状ずれる余地は見つからなかったが、**それを固定する歯は置いていない。**

## 検討して採らなかった案

- **4箇所を1つの純関数にまとめる。** 却下（今回は）。SQL 側（表の2）は
  `COALESCE(occurred_at, recorded_at)` を **WHERE 句で**評価しており、
  TypeScript の関数に寄せると索引が効かなくなる。**「同じ規則」であることは、
  共有ではなく歯で固定するほうがこの構造には合う。**
- **`recall-runtime.ts` の候補フィルタを消して `aggregateScope` に一本化する。** 却下。
  `aggregateScope` は件数だけを返し、候補そのものを返さない。役割が違う。
- **判定規則を境界を含まない側（`>` / `<`）へ揃える。** 却下。**今日4つとも境界を含んでおり、
  変える理由が無い。**どちらが正かは設計の判断であり、**変えるならオーナー/マネージャーの判断が要る。**

## これが覆るとしたら

- **`period` を段1（ANN の `VectorFilter`）へ降ろしたとき**（[ADR 0023](./0023-subject-filter-in-ann-stage.md) が
  「降ろさない」と決め、負債として記録している）。**判定箇所が5つ目に増える。**
- **Phase 2 で `valid_from` / `valid_until` が入ったとき。**「実効時刻」の定義そのものが変わる。
