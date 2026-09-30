/**
 * プロセス内の「書き込み累計」カウンタを、テストファイルごとに 0 へ戻す
 * （Issue #1276 / ADR 0397）。`vitest.config.mts` の両方の project の `setupFiles` に置く。
 *
 * ## なぜ要るか
 *
 * `memories-statistics.ts` の `memoriesWriteCounts` と `embedding-statistics.ts` の
 * `upsertCountsByTable` は、プロセスローカルな累計で、閾値（初期 1,000、幾何的に増える）に
 * 達したところで `ANALYZE` を撃つ。並列 project が `isolate: false` で走ると、同じ worker の
 * 全ファイルで同じモジュールが共有され、累計が**ファイルをまたいで繋がる**——`ANALYZE` を撃つ
 * 時点が、どのファイルがどの順で同じ worker に来たかで変わり、別のファイルの途中で統計が
 * 変わりうる（`isolate: true` ではファイルごとにモジュールが新しくなるので、累計は毎回 0 から
 * 始まっていた）。setupFiles はファイルごとに実行される（`isolate: false` でも）ので、ここで
 * 戻せば、どちらの設定でも「各ファイルは累計 0 から始まる」に揃う。
 *
 * 呼ぶのは既存のテスト専用の口（`*ForTesting`。公開 API の入口 `index.ts` からは出していない）。
 */
import { resetEmbeddingUpsertCountersForTesting } from "../embedding-statistics.js";
import { resetMemoriesWriteCounterForTesting } from "../memories-statistics.js";

resetMemoriesWriteCounterForTesting();
resetEmbeddingUpsertCountersForTesting();
