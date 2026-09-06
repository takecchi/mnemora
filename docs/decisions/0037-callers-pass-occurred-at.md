# ADR 0037: `observe()` の `occurredAt` を、実際に通す — 「いつの出来事か」を絞れるようにする

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-06

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ」を混ぜない。

---

## 文脈

**口は最初から在った。誰も使っていなかった。**

`ObserveInput` の3つの入力（`utterance` / `event` / `document`）はすべて
`occurredAt?: Date` を持ち、`runtime.observe` は `occurredAt: input.occurredAt ?? null` で
素通しし、`buildNewMemoryFromCandidate` は `occurredAt: params.observation.occurredAt ?? null`
で `Memory.occurredAt` へ写す。

### 数えたこと（**私が実行した**）

| 層 | 経路 | 件数 |
|---|---|---|
| `Memory.occurredAt` を書く本番の箇所 | `buildNewMemoryFromCandidate`（`extraction.ts`） | **1** |
| そこへ入る値の出どころ | `params.observation.occurredAt` のみ | **1** |
| その1箇所を呼ぶ経路 | `observe()` と `reextract()`（**どちらも同じ関数を通る**） | 2 |
| `Observation.occurredAt` を書く本番の箇所 | `observe()` の素通し／`handleMemoryUsage` の `null` 固定（**Memory を作らない**） | 2 |
| **`ObserveInput.occurredAt` に値を渡している呼び出し側** | — | **0** |

**⟹ 入口から出口まで一本道で、その入口に誰も値を入れていなかった。
テストを含めて0件だったので、この経路は一度も通っていなかった。**

### それが何を壊すか（**私が実行して確かめた**）

`recall-runtime.ts` は `effectiveTime = memory.occurredAt ?? memory.recordedAt` で
`occurredAfter` / `occurredBefore` を当てる。

**⟹ `occurredAt` が常に `null` なら、「いつの出来事か」を絞ると読める欄が、
実際には「いつ言われたか」を絞る。**

生の会話ログを後から取り込む（backfill）と `recordedAt` は**取り込んだ今日**になる。
**⟹ 「10日前より後の出来事」を求めたのに、20日前の出来事が返る。
エラーも警告も出ない。** `omitted` にも何も出ない——**落ちていないのだから正直である。
嘘をついているのは欄の名前のほうである。**

---

## 決定

1. **`ObserveInput.occurredAt` を実際に通す経路を、歯とサンプルの両方で成立させる。**
   - `packages/core/src/__tests__/observe-occurred-at.test.ts`（DB 不要）:
     `observe(occurredAt)` → `Memory.occurredAt` → `recall({occurredAfter})` の period フィルタ、
     という一本の経路を検査する。
   - `examples/chat` に `backfill` サブコマンド（`src/backfill.ts`）を足す。
     **同じ2発話・同じ問い合わせを、`occurredAt` を渡す側と渡さない側の2テナントで走らせ、
     答えが変わることを画面に出す。**
2. **🔴 `packages/core` の振る舞いは1行も変えていない。**足したのは歯とサンプルだけである。
   **⟹ 直したのは「呼び出し元が0件」のほうであって、機構ではない。**
3. **⚠ 未来の `occurredAt` を弾かない。**
   [ADR 0036](./0036-clamp-freshness-at-one.md) で `freshness` に上限を置いたのは、
   **未来の時刻を*受け入れる*と決めたから**である。入口で弾くとその決定と食い違う。
4. **サンプルは主測定に触れない。**`src/backfill.ts` は `compare.ts` / `retrieval-quality.ts` /
   `probe-set.ts` / `scenario.ts` / `naive-path.ts` のいずれも import しない
   （`src/scope.ts` が置いた規律と同じ）。

---

## 🔴 これは想起を良くするものではない

**`hit@1` は改善しない。**これは*嘘をつかなくする*変更である。

[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md) が測ったとおり、
`travel` probe の失敗は「質問が指す時間の向きを表す場所が無い」ことであり、
**`recall()` は質問文を解釈しない**（`occurredAfter` は呼び出し側から受け取るだけ）。
そして「来月、京都へ出張します」の中の**「来月」を読む**のは別の話——
発話中の時間表現を抽出する変更であり、**本 ADR の範囲外である。**

### 主測定が動いていないことの実測（**私が実行した**）

- `compare`（擬似 provider・本物の PostgreSQL 17.9 + pgvector 0.8.2）を本 PR の前後で
  1回ずつ走らせ、出力表を `diff` した:

  ```
  $ diff /tmp/c2-before.txt /tmp/c2-after.txt
  （差分なし）
  ```

  **12行すべて（会話2〜642ターン）で `mnemora chars` も `mnemora tokens` も同一。**

- `retrieval` を本 PR の後に1回走らせ、[ADR 0036](./0036-clamp-freshness-at-one.md) の実測と並べた:

  | arm | LLM | 埋め込み | ADR 0036 の測定 | 本 PR 後 |
  |---|---|---|---|---|
  | A | 擬似 | 擬似 | 0.018 / 0.000 / 0.021 | **0.018 / 0.000 / 0.021** |
  | B | 擬似 | 本物 | 0.714 / 1.000 / 0.667 | **0.714 / 1.000 / 0.667** |
  | C | 本物 | 本物 | 0.743 / 1.000 / 0.700 | 0.732 / 1.000 / 0.688 |

  **arm A・B（擬似 LLM ＝ 決定的）は MRR が完全に一致した。**
  **⚠ arm C は本物の LLM を使うため実行ごとに揺れる**（diet の goldRank は
  4 / 5 / 7 / 8 / 9 と動く。今回は 8 だった）ので、**一致も不一致も主張しない。**
  **hit@1 は 4/7、外す3件は exercise / diet / travel で、これまでと同じだった。**

**⟹ 本 PR は `packages/core` の振る舞いを1行も変えていないので、これは当然そうなるべき結果である。
測ったのは「当然」が実際に成り立っていることの確認である。**

---

## 検討して採らなかった案

- **`ingestConversation`（`compare` の取り込み段）や `probe-set` の会話に時刻を付ける。**
  **却下。**測定条件そのものを変えることになり、前後が比較できなくなる
  （[ADR 0022](./0022-fake-provider-compare-does-not-claim-recall-quality.md) の
  「見栄えの良い数字のために測る条件を選び直さない」に触れる）。
  **サンプルは独立したデモとして足し、主測定には指1本触れない。**
- **`occurredAt` を省略したときに `recordedAt` を明示的にコピーする。**却下。
  いまも `effectiveTime` のフォールバックで同じ結果になるうえ、
  **「値が無い」と「値が推定で埋まっている」の区別が消える。**
  `occurred_at` は `docs/memory-model.md` §3 で「可（不明なら NULL）」と定められている。
- **未来の `occurredAt` を入口で弾く。**却下（決定3）。
- **`examples/chat` の既存デモ（`chat`）に混ぜる。**却下。`scope` の先例に倣って
  独立したサブコマンドにした——**1つのデモが1つのことだけを見せるほうが、
  壊れたときにどこが壊れたか分かる。**

## 引き受ける負債・覆えていない範囲

- **発話中の時間表現（「来月」「先月」）は読まない。**別 PR の対象であり、
  費用は実測済み（抽出の input tokens が +33.5%、`compare` 1回が +25%）。
  **さらに「基準日を渡すと抽出プロンプトが日ごとに変わる＝測定が日付依存になる」
  という、費用より重い問題がある。**マネージャーの判断で保留されている。
- **`ObserveInput.occurredAt` が未来でも受け付ける**（決定3）。
  上限は `freshness` 側で ADR 0036 が持つが、**`occurredAt` が
  「まだ起きていない予定」なのか「時計がずれた」のかは区別できない。塞いでいない。**
- **`examples/chat` の主測定（`compare` / `retrieval`）は依然として `occurredAt` を渡さない。**
  意図的である（決定4）。**⟹ 主測定の中で period の絞りが試されることは、いまも無い。**

## これが覆るとしたら

- **発話中の時間表現を抽出するようになったとき。**`Memory.occurredAt` の出どころが
  「呼び出し側が渡した観測時刻」から「LLM が読んだ出来事の時刻」へ変わり、
  **同じ欄の意味が2つになる。**そのときは出どころを区別する必要が出るかもしれない。
- **Phase 2 で `valid_from` / `valid_until` が入ったとき。**
