# ADR 0487: `usage.counter` の印は連結の計測の印であり、段4の予算の判定に使った印とは食い違いうる。今の振る舞いを文書に書く

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定の範囲で、マネージャー mgr-86b4be97 の指示により担い手が書いた。ADR 0483 の材料2を、文書に書いて片付ける。

出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**: 【現物】`recall()` が返す `usage.counter` は、返した digest を連結し目次帯の JSON を足した文字列を `tokenCounter.count()` に1回渡した値の `counter` である（`recall-runtime.ts` 3281〜3283 行付近）。段4の予算の判定は digest ごとに `count()` を呼ぶ（`recall-budget-cut.ts` の `unitTokens`）。テキストによって `counter` を変える `TokenCounter` では、2つの印が食い違いうる。
- **確かめ方**【実測】: 10文字以下は `exact`、それより長ければ `heuristic` を返す counter で、digest 2件（各10文字）・`maxMemoryTokens: 4` の recall を走らせた。予算の判定は `exact` で1件残り、`usage.counter` は `heuristic` だった。歯は `recall-pipeline.test.ts` に足した。
- **決めたこと**【判断】: 振る舞いは変えず、次に「今の振る舞いを書いたもの」として書く: `TokenCounter` の TSDoc、`RecallUsage.counter` の TSDoc、`docs/recall.md` のトークン推定の節、`docs/architecture.md` §5.9。
- **材料（直していない。決めるのはクローンまたはオーナー）**: 印を揃える直し（`usage` に判定側の印を足す、`counter` を `"mixed"` のような値にする、など）は公開の型の変更に当たりうるので、決めていない。CHANGELOG と migration-v1 は、振る舞いが変わらないので触らない。
