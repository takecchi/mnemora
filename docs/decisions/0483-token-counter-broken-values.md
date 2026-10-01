# ADR 0483: 穴探し54巡目 — 差し替えた `TokenCounter` が約束を破る値を返すと、recall はトークン予算を黙って外す。今の振る舞いを文書に書き、歯で縛る

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し）の中だけを直し、新しく断る入力や既定値の変更に当たるものは「材料」に回した。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 54巡目は `TokenCounter`（`packages/core/src/interfaces/token-counter.ts`）、既定の `heuristicTokenCounter`、recall の段4 `findBudgetCut`（`recall-budget-cut.ts`）と `usage` の計測（`recall-runtime.ts` 3281 行付近）を見た。recall の footprint（ADR 0467・0470）、outputValidation（別の巡）、local-embedding の `countTokens`（ADR 0445）は数えない。

- **実測した振る舞い**【実測】（Fake の store、3件の digest（各10文字）、`maxMemoryTokens: 4`）:

  | counter の返す値 | 返る件数 | `omitted` | `usage` | `outputValidation` |
  |---|---|---|---|---|
  | 基準 `tokens: 3, counter: "exact"` | 1 | `budget_dropped` | 3, exact | ok |
  | `NaN` | **3（予算が外れる）** | 無し | `estimatedTokens: NaN` | `usage.estimatedTokens`・`usage.share` |
  | `-5` | **3（予算が外れる）** | 無し | `-5` | 同上 |
  | `Infinity` | 0 | `budget_dropped` | `Infinity` | 同上 |
  | `0.5`（予算なしでも） | 3 | 無し | `0.5` | `usage.estimatedTokens` |
  | 例外 | `recall()` が reject（予算なしでも） | — | — | — |
  | `counter` の欄が無い | 1 | `budget_dropped` | `counter: undefined` | `usage.counter` |
  | `counter: "bogus"` | 1 | `budget_dropped` | `counter: "bogus"` | `usage.counter` |
  | `undefined` を返す | `Cannot read properties of undefined (reading 'tokens')` で reject | — | — | — |

  `maxMemoryTokens: 0` は入力の検査（`RecallQuerySchema`、`> 0`）が先に断る。

- **見つけたこと**【現物】: `findBudgetCut` の doc は、`tokenCounter` が負・NaN を返すと二分探索を使わず線形に探すと書いている（ADR 0431）。ただしその線形探索でも `!(prefix[k] > maxTokens)` は `NaN` で真になるので、`NaN` を含む prefix は全部「収まる」。結果は旧実装と同じ（ADR 0431 が縛る）が、**利用者向けの文書（`TokenCounter` の doc、architecture §5.9、recall.md §6）には、この振る舞いが書かれていなかった**。落ちたことを知らせる経路は `outputValidation`（ADR 0098）で、`"off"` では知らされない。

- **決めたこと**【判断】:
  1. `TokenCounter` の doc、`docs/architecture.md` §5.9、`docs/recall.md` のトークン推定の節に、上の表の振る舞いを「今の振る舞いを書いたもの」として足す。実装は変えない。
  2. 歯で今の振る舞いを縛る: `recall-pipeline.test.ts`（約束を破る counter、陽性対照つき）と `heuristic-token-counter.test.ts`（孤立サロゲート・結合文字・ZWJ・CJK の端・100万文字）。わざと契約を破るテストの名前を `setup-recall-output-contract.ts` の一覧に足した。

- **照合して、割れていなかったもの**:
  - 【現物】`maxMemoryTokens` の境界（ちょうど・前後 ±1・1件目だけで超える・0 件・全件）は `recall-budget-cut.test.ts` が旧実装との一致で縛っている（ADR 0431）。
  - 【実測】`heuristicTokenCounter`: 空文字 0、孤立サロゲートは非CJKの1コードポイント（例外なし）、結合文字・ZWJ は1コードポイントずつ、100万文字でも整数。係数は整数比なので丸め差が出ない。

- **材料（直していない。決めるのはクローンまたはオーナー）**:
  - **壊れた値を返す counter で `recall()` を例外にする直し**は、新しく断る入力を増やす。近い前例として、core が embedding provider の戻りの長さと有限性を検査して embed ジョブを失敗にする migration-v1 🔴 項目33 がある。ただし同種とは言い切れない: あれは書き込み経路（ジョブの失敗が再試行・記録に載る）で、recall は読む主経路である。同じ主経路の出力側で、ADR 0098 は「既定を投げにすると、いままで動いていた呼び出しが例外になる」ことを理由に、既定を `"report"` と決めている。この決定と食い違うので、前例とは扱わなかった。
  - `usage.counter` は、digest を連結して目次帯の JSON を足した文字列を1回数えた値の `counter` である。段4の強制は digest ごとに数える。テキストによって `counter` を変える実装では、強制に使った値の `counter` と食い違いうる。名乗りの規則（「推定を実測の顔で返さない」）をどう守らせるかは、公開の型の変更に当たりうるので決めていない。
  - `heuristicTokenCounter` の CJK 範囲は手で書き写した表で、全角記号の U+FFE0〜FFEE、かな拡張の U+1B000 台などを含まない（非CJKの 0.25 で数える）。係数や範囲を変えると既定の見積もりの値が変わる（ADR 0083 の範囲）ので、決めていない。
