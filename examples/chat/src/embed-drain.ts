import type { Ctx, Runtime } from "@mnemora/core";

// ---------------------------------------------------------------------------
// outbox を干上がるまで処理する(PR 本文「実行時の規律」)
//
// 元は `retrieval-quality.ts` の中だけに閉じていたが、`mnemora-path.ts` の
// `ingestConversation`(主測定である `compare` 経路が使う)にも同じ罠が
// あったため、共有モジュールへ切り出した(docs/decisions/0021 参照)。
// ---------------------------------------------------------------------------

/**
 * `runtime.tick` に渡す claim リース長(ADR 0032)。**この harness の呼び出し側として
 * 決めた方針であり、`packages/core` の既定値ではない**(`ClaimOutboxJobsOptions.leaseMs`
 * に既定値は無い)。
 *
 * 根拠: `packages/openai` の `EmbeddingProvider`/`LLMProvider` はどちらも
 * `new OpenAI({ apiKey })` をオプション無しで作っており(`packages/openai/src/
 * embedding-provider.ts`・`llm-provider.ts`)、インストール済みの `openai` SDK
 * (このリポジトリの `node_modules/openai` で確認: v7.10.0)の既定値がそのまま効く——
 * 既定の `timeout` は1リクエストあたり10分、既定の `maxRetries` は2
 * (`node_modules/.pnpm/openai@7.10.0.../openai/client.d.ts` の doc コメントに明記)。
 * つまり1回の embed/extract ジョブは、SDK が自動リトライする分も含めると
 * 最大 (1 + 2) × 10分 = 30分は「正常に処理中」でありうる。リースがこれより短いと、
 * まだ生きているワーカーのジョブを「止まった」と誤判定して奪ってしまう
 * (ADR 0032 の「引き受ける負債」——リース切れの再 claim は at-least-once の重複を
 * 招くため、無用に短くしない)。この harness は単一プロセス・単一ワーカーの
 * バッチ処理で、`tick()` は claim した分を同じ呼び出しの中で必ず complete/fail
 * させてから返る(`runtime.ts` の `tick` 実装)ため、通常運転ではリース満了は
 * そもそも発生しない——満了が意味を持つのは、このプロセス自体がクラッシュして
 * 再実行されたときの回収だけである。
 */
const EMBED_DRAIN_LEASE_MS = 30 * 60 * 1000;

export interface DrainResult {
  /** 呼んだ tick() の回数。 */
  ticks: number;
  totalProcessed: number;
  totalFailed: number;
  /** 1回目の tick() が処理した件数(既定 limit=50 が実際に効いた件数)。 */
  firstTickProcessed: number;
}

/**
 * `tick({kinds:['embed']})` を `processed === 0` になるまで繰り返す。
 *
 * **背景(docs/decisions/0019-real-openai-measurement-cost.md §5、
 * docs/decisions/0021-drain-embed-ticks-in-ingest.md)**: `tick()` の既定 `limit` は
 * 50(`DEFAULT_TICK_LIMIT`、`packages/core/src/runtime.ts`)であり、embed ジョブは
 * `claimBatch` が `ORDER BY available_at ASC` で先着順に claim するため、
 * **記憶が50件を超える量を一度に ingest すると、51件目以降は埋め込まれないまま
 * `pending` に残り、`recall()` の ANN 候補にすらならない**(`omitted` には
 * `not_indexed(reason: "pending")` として現れる——`recall()` はこれを隠さず正直に
 * 出す。ADR 0008)。1回の `tick()` では「まだ残っているかもしれない」ことしか
 * 分からないため、`processed === 0`(=もう claim できるジョブが無い)になるまで
 * 呼び続けて初めて「干上がった」と言える。
 *
 * `examples/chat/src/mnemora-path.ts` の `ingestConversation`(`compare` が使う
 * 主測定の取り込み段)と `examples/chat/src/retrieval-quality.ts` の
 * `runRetrievalQualityArm` の両方がこれを使う——どちらも「まとまった量を一度に
 * ingest してから測る」バッチ的な呼び出し側であり、干上がるまで回す責任は
 * `packages/core`(単発の安全弁である `DEFAULT_TICK_LIMIT` を持つ側)ではなく、
 * こちら側にある(ADR 0021「採らなかった案」参照)。
 */
/**
 * 直近に書いた outbox ジョブの `available_at`（Postgres の `now()`、マイクロ秒精度）を
 * **確実に追い越す**、ミリ秒精度の `Date` を返す（Issue #719）。
 *
 * **背景**: `packages/postgres` の `claimBatch`（`outbox-store.ts`）は
 * `available_at <= opts.now` で claim 可能かを判定する。`available_at` は SQL の
 * `now()` で書かれるためマイクロ秒精度を持つが、`opts.now` は呼び出し側が渡す JS の
 * `Date` であり、**ミリ秒精度——小数点以下は切り捨て（floor）**である。
 * 直近の書き込みの実時刻を T1（マイクロ秒）、この関数を呼ぶ実時刻を T2 とすると、
 * 書き込みの応答を受け取ってから呼ぶ限り T2 > T1 は保証される。しかし **T1 と T2 が
 * 同じ 1ms の枠に収まった場合、`floor(T2)`（=素の `new Date()`）は `T1` 自身より
 * 小さくなりうる**（`T1` の枠内の端数ぶんだけ）——そうなると
 * `available_at(T1) <= opts.now(floor(T2))` が false になり、claim が1件も進まない
 * （`drainEmbedTicks` は `processed === 0` を「もう無い」と解釈して静かに抜ける。
 * 例外は投げない）。
 *
 * ⟹ **`floor(T2) + 1` を使う。** `floor(x) + 1 > x` は任意の実数 x に対して成り立つ
 * 恒等式なので、`floor(T2) + 1 > T2 > T1` が常に成り立つ——同じ ms に収まったかどうか
 * に関係なく、書き込みの応答を受け取った後に呼ぶ限り決定的に安全。
 * 【実測】この関数を経由しない素の `new Date()` は、通常の DB 往復（この器で約1〜3ms）
 * があるため自然にはほぼ再現しない（50回中0回）が、実際の `available_at` の生値と
 * `floor(ms)` した同じ値を直接 `claimBatch` に渡す計装では30/30回とも claim が0件に
 * なった——CI（Issue #719 の実際の赤）はこの器より往復が速い環境だったと考えられる。
 *
 * ⚠ **前提**: アプリ（Node プロセス）と Postgres サーバが同じホストの実時計を共有する
 * こと。ホストを跨いでクロックスキューがある構成では、この保証は成り立たない
 * （このベンチ・harness はどちらもローカル Postgres が前提であり、当てはまらない）。
 *
 * `nowMs` は既定で `Date.now()`——テスト（`__tests__/embed-drain-clock-margin.test.ts`）
 * がこの引数を直接渡して、時刻の読み取りそのものをモックせずに境界条件を検査する。
 */
export function clockPastRecentDbWrites(nowMs: number = Date.now()): Date {
  return new Date(nowMs + 1);
}

export async function drainEmbedTicks(runtime: Runtime, ctx: Ctx): Promise<DrainResult> {
  let ticks = 0;
  let totalProcessed = 0;
  let totalFailed = 0;
  let firstTickProcessed = 0;
  for (;;) {
    const result = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: EMBED_DRAIN_LEASE_MS });
    ticks += 1;
    totalProcessed += result.processed;
    totalFailed += result.failed;
    if (ticks === 1) {
      firstTickProcessed = result.processed;
    }
    if (result.processed === 0) {
      break;
    }
  }
  return { ticks, totalProcessed, totalFailed, firstTickProcessed };
}
