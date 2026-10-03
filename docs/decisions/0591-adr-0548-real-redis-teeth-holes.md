# ADR 0591: ADR 0548 の実 Redis の歯の穴（頭打ちの件数・失敗したジョブの保持・`lockDuration` の期限）を塞ぐ

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンのマネージャー（mgr-9a36f2f4）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0580](./0580-adr-0568-nonexistent-id-and-event-get-controls.md) などの試験だけの PR と同じ）。

## 経緯【実測】

[ADR 0548](./0548-bullmq-lock-duration-and-remove-on-complete-default.md)（PR #1657）は、実 Redis の歯を手元で走らせていなかった（器に Redis が無かった）。今回、器の中に Redis を立てて確かめ直した。

- Redis: redis-server 8.0.2。Debian の `redis-tools_8.0.2-3+deb13u3` と依存のライブラリを `dpkg -x` で作業ディレクトリへ展開し、自分専用のポートで立てた（root 権限は使っていない）。bullmq 6.3.8。⚠ CI の `bullmq` job は `redis:7` の image で、版が違う。
- 実 Redis 用の3本（`tick-driver.shared-scheduler.redis.test.ts`・`tick-driver.failed.redis.test.ts`・`concurrent-tick.redis.test.ts`）は、#1657 の head で3本とも緑だった。
- ADR 0548 が「確かめていない」とした「template の opts が実際の job に効く」は、実 Redis で確かめられた。`completedJobsToKeep: 3` で完了ジョブが3件以下に収まり、template から `opts` を外すと12件残った。

ADR 0548 の約束を実 Redis の歯に当てたところ、次の4つの変異が緑のまま通った（mock の歯（`tick-driver.option-passthrough.test.ts`）は4つとも捕まえている）。

| # | 約束 | 変異 | 通った理由 |
|---|---|---|---|
| V2 | `completedJobsToKeep` の件数で頭打ちになる | 件数を「渡した値 − 1」にする（消しすぎ） | 頭打ちの歯は「3件以下・1件以上」しか見ていなかった |
| V5 | `removeOnFail` は触らない（失敗したジョブは残る） | template に `removeOnFail: true` を足す | failed の歯は `onTickError` に届くことしか見ていなかった |
| V6 | `lockDuration` を渡すと Worker の lock の期限になる | Worker に渡さない | `lockDuration` を渡す実 Redis の歯が無かった |
| V7 | `lockDuration` を渡さないと BullMQ の既定のまま | 渡さなくても `lockDuration: 1000` を載せる | 同上 |

## 決定【判断】

1. 実装は変えない。
2. 歯を4本足す（試験だけ。どれも `packages/bullmq/src/__tests__/*.redis.test.ts` に置いたので、`test:redis`（`vitest.redis.config.mts` の `include`）を通じて CI の `packages/bullmq（本物の Postgres + 本物の Redis）` job で走る。既定の `test` は `*.redis.test.ts` を外している）。
   - **V2**: `tick-driver.shared-scheduler.redis.test.ts` に「頭打ちの件数は `completedJobsToKeep` ちょうど」。`completedJobsToKeep: 3` で 12 回以上 tick させて止め、完了ジョブが `toBe(3)`。揺れないかを、元のコードで緑を3回、V2 で赤を3回走らせて確かめた（緑は3回とも 3、赤は3回とも 2）。揺れなかったので、落ち着くまで待つ形にはしなかった。
   - **V5**: `tick-driver.failed.redis.test.ts` に「失敗したジョブは Redis に残る」。tick を3回以上失敗させて止め、`getJobCounts("failed")` が `onTickError` に届いた件数以上、かつ3以上であること。`'failed'` は job が failed へ移った後に emit されるので、届いた件数ぶんは残っている。
   - **V6・V7**: `tick-driver.lock-duration.redis.test.ts`（新規、2本）。tick の途中で止め、実行中の job の lock キー（bullmq 6.3.8 では `queue.toKey(jobId) + ":lock"`【現物】`redis-queue-backend.js`）の `PTTL` を、別の ioredis 接続で読む。BullMQ は lock を `lockDuration` で取り、既定では `lockDuration / 2` ごとに延ばすので、`PTTL` は `lockDuration / 2` より大きく `lockDuration` 以下に入る。`lockDuration: 60000` なら `30000 < PTTL ≤ 60000`、渡さなければ `15000 < PTTL ≤ 30000`。bullmq の `Queue` は Redis の接続を公開していないので、`ioredis`（`packages/bullmq` の dependencies にある）で接続を別に張った。

## 変異試験【実測】

`tick-driver.ts` を `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。

| 変異 | 赤 | 戻して |
|---|---|---|
| V2: `count: Math.max(1, completedJobsToKeep - 1)` | 頭打ちの件数の歯（`expected 2 to be 3`。3回とも） | shared-scheduler 5本緑 |
| V5: template に `removeOnFail: true` | 失敗したジョブの保持の歯（`expected 0 to be greater than or equal to 3`） | failed 2本緑 |
| V6: Worker の opts から `lockDuration` を外す | `lockDuration: 60000` の歯（`expected 29968 to be greater than 30000`） | lock-duration 2本緑 |
| V7: `lockDuration: lockDuration ?? 1000` | 渡さない側の歯（`expected 973 to be greater than 15000`） | lock-duration 2本緑 |

最後に戻した状態で、変えた3ファイルを名指しで走らせて9本緑。

## 直さないもの

- 既定の 1000 件で頭打ちになること（足りない側：既定を外して全部残す変異）。実 Redis で見るには 1000 回を超えて tick させる必要があり、歯にしない。mock の歯が捕まえる（`tick-driver.option-passthrough.test.ts`）。
- `lockDuration` を長くして stalled が減ること（ADR 0449 の 45 秒の測定）。この歯が見るのは、期限が Redis に届くことだけ。
- ADR 0548 の負債4（動いている scheduler の template の更新）。

## これが覆るとしたら

bullmq の lock キーの名前、または lock の延長の間隔（`lockRenewTime` の既定 `lockDuration / 2`）が変わったとき（V6・V7 の歯の読み方を直す）。`removeOnFail` に既定を入れると決めたとき（V5 の歯の期待を変える）。
