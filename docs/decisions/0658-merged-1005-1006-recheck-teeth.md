# ADR 0658: 10/05〜10/06 にマージされた #1736・#1739・#1741・#1744・#1749 の確かめ直しで見つかった穴に歯を足す（Issue #1752）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1752](https://github.com/takecchi/mnemora/issues/1752)（分母はその本文）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【受】は自分で測らずに受け取ったもの、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・CHANGELOG は触らない（[ADR 0621](./0621-merged-0930-1465-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯

各 PR の歯に、直しを外す変異とやりすぎた実装の変異を `cp` で当て、`cmp` で戻した【実測。main `94951a92`】。生き残ったのは次の2つである。

1. **#1741（[ADR 0655](./0655-bullmq-stop-removes-scheduler-only-when-last-worker.md)）**: `stop()` が `queue.getWorkers()` の返り値から「自分以外の Worker が居るか」を読む分岐は、Redis の歯（`tick-driver.stop-last-worker.redis.test.ts`、`test:redis`）だけが縛っていた。Redis の無いジョブで走る単体の歯は、モックの `Queue` に `getWorkers` が無く常に `catch` へ落ちるので、分岐を見ていない【現物】。単体では、「常に消す」「`rawname` の無い偽の1件を『他』と読まない」の変異が生き残った【実測】。
   ⚠ この器には Redis を立てる手段（redis-server・docker・コンパイラ）が無く、Redis の歯そのものには変異を当てていない【受: Redis の歯が CI で緑であること、bullmq 6.3.8 の接続名の形】。
2. **#1744（[ADR 0656](./0656-activity-clock-advancers-list-is-bound-to-recall-callers.md)）**: 一覧の歯は、`runtime.ts` の `recall(`/`runRecall(` の呼び出し元しか見ていない。時計を実際に進めるのは `MemoryStore.createRecall`（`advanceActivityClock`）であり【現物: `TenantSettingsStore` の doc、`recall-runtime.ts` の記録の段】、`recall()` を通らずに `createRecall` を呼ぶ口（たとえば `forget` の中）を足す変異は、core の全テストを素通りした【実測】。

## 決定【判断】

1. **実装は変えない。**
2. `packages/bullmq/src/__tests__/tick-driver.stop-last-worker.test.ts`（新規、Redis 不要）。モックの `getWorkers` の返り値を差し替え、`removeJobScheduler` を呼ぶかどうかで分岐を照合する。照合する形は次の8つ。
   - 自分だけなら消す。
   - 空なら消す。
   - 名前付きの他が居れば消さない。
   - 名前なしの他も「他」と数えて消さない。
   - 自分の名前を前置きに含むだけの他は「他」と数える（末尾一致）。
   - `rawname` の無い偽の1件なら消す。
   - throw なら消す。
   - `getWorkers()` を自分の Worker を閉じる前に読む。
   自分の接続名は、Worker のモックが受けた `opts.name` から組む。
3. `packages/core/src/__tests__/activity-clock-advancers-doc.test.ts` に1本足す。core の非テストのソースで、コメントを除いたコードに `createRecall` の語が出るのが `recall-runtime.ts` だけであること（宣言の `interfaces/memory-store.ts` は除く）を縛る。呼び出しの形ではなく語で見るのは、別名（`const r = deps.memoryStore.createRecall; r.call(...)`）で素通りさせないためである。

## 実測（main `94951a92`）

足した歯は main で緑だった。下の変異で赤になり、`cp` で戻して `cmp` で一致させたあと、`packages/bullmq` の単体の全テスト（120）と `packages/core` の全テストが緑に戻った。

| 変異 | 場所 | 足した歯 | それまでの歯 |
| --- | --- | --- | --- |
| B1: 常に消す（`true \|\| …`） | `tick-driver.ts` `stop()` | 5本赤 | 単体は素通り（Redis の歯は【受】） |
| B2: `rawname` の無い偽の1件を「他」と読む | `hasOtherWorkers` | 1本赤 | 単体は素通り |
| B3: 自分の除外を外す（`workers.length > 0`） | `hasOtherWorkers` | 1本赤 | 単体は素通り（モックに `getWorkers` が無いため） |
| B4: throw を「他が居る」と読む | `hasOtherWorkers` | 1本赤 | 既存の単体2本も赤（モックに `getWorkers` が無く throw するため。狙った歯ではない） |
| B5（やりすぎ）: 末尾一致を部分一致（`includes`）にする | `hasOtherWorkers` | 1本赤 | 単体は素通り |
| B6: 自分の Worker を閉じてから `getWorkers()` を読む | `stop()` | 2本赤 | 既存の単体3本も赤（呼び出しの順） |
| Mb2: `forget` が `createRecall` を `advanceActivityClock: true` で直接呼ぶ | `runtime.ts` | 1本赤 | 素通り（core 全体） |
| Mb3: 同じことを別名＋`.call` で行う | `runtime.ts` | 1本赤 | 素通り |

確かめ直しで当てた、生き残らなかった変異（記録のため）:
- #1744: `sweepArchive` に `recall()` を足す → 一覧の歯が赤。
- #1744: `findCorrectionCandidates` が `recall()` を2回呼ぶ（やりすぎ） → ふるまいの歯5本が赤。
- #1744: `"wall"` のテナントでも時計を進める → ふるまいの歯2本が赤。
- #1736: `tick` の層の行を消す → 層の行の歯が赤。

## 生き残ったが、塞がないもの

- #1736・#1739: 層の値を別の有効な値へ書き換える（`tick` を `未分類` に戻す）変異は生き残る【実測】。[ADR 0633](./0633-layer-of-runtime-methods-lives-in-doc-comment.md) が射程外と明記し、メソッド名と層の表を歯に持つ案を「採らなかった案」に挙げているので、塞がない。
- #1744: 一覧の歯が、別名や入れ子の関数から `recall()` を呼ぶ形を拾えないこと。ADR 0656 の「引き受けた負債」に記録済みなので、塞がない。

## 確かめていないこと

- Redis の歯（`*.redis.test.ts`）への変異試験。この器では Redis を立てられなかった。
- 足した `createRecall` の歯はファイル単位で見ている。`recall-runtime.ts` の中に、`runRecall` 以外から `createRecall` を呼ぶ関数が増えても捕まえない。
