#!/usr/bin/env node
/**
 * Issue #730 のための実測ベンチ（テストではなくスクリプト。CI には乗らない。
 * `pnpm --filter @mnemora/postgres run bench:same-ms-usage`）。
 *
 * ## 何を測るか
 *
 * [Issue #730](https://github.com/takecchi/mnemora/issues/730): `PostgresMemoryStore.reinforce`
 * の WHERE 句は `last_reinforced_at IS NULL OR last_reinforced_at < at`（ADR 0048「起点を
 * 巻き戻さない」）。**等しい `at` での2回目の強化は、例外にならず黙って何もしない。**
 * `at` は `runtime.ts` の `handleMemoryUsage` が `clock.now()`（= `new Date()`、ミリ秒分解能）
 * から取る。Issue 本文は「実運用で踏むのは同じミリ秒に2回報告が来た場合だけ」と書いているが、
 * その頻度も、踏んだときに活動時計（`decay_clock = 'activity'`）側でどれだけ `activity_seq`
 * を取り逃がすかも、実測していなかった。本スクリプトはそれを実測する。
 *
 * **挙動・公開 API・既定値は一切変えない。** `PostgresMemoryStore.reinforce` の1点だけ、
 * 呼ばれた引数と返り値を記録するために `reinforce` メソッドをインスタンス単位で
 * 差し替える（`installReinforceSpy`）——プロトタイプもクラス定義も触らない。
 *
 * ## セクション
 *
 * 1. **時計の分解能**（DB 不要）: `Date.now()` を密なループで呼び、連続する呼び出しが
 *    同じ値を返る割合と、値が変わる刻み。`performance.now()` の最小刻みも併せて測る。
 * 2. **同じ Memory への reinforce の `at` が一致する頻度**（本物の Postgres が必要）:
 *    a. 同じ recall を2回報告（`recordUsage` の `ON CONFLICT DO NOTHING` で2回目が
 *       弾かれ、`reinforce` 自体が呼ばれないはず、を確認する——Issue #730 の対象とは
 *       別の安全弁である。**recallId が異なる2回の報告は、この安全弁の対象外**——
 *       それが (c)/(d) で測る本題）。
 *    b. 1回の報告で `usedMemoryIds` に同じ id が重複。
 *    c. 逐次: recall → 報告 → 直後に別の recall → 同じ Memory を報告。「LLM 呼び出しが
 *       無い最悪条件」と「LLM 相当の遅延を挟む現実の条件」の2通り。
 *    d. 並行: 同じテナントで N 本（既定 2/8/32）の recall→報告を `Promise.all` で同時に
 *       投げる。
 *    e. `restoreArchived` と使用報告が同じミリ秒に重なる形。
 *    f. （追加）強制的な逆順コミットの実演: 古い `at` を持つ書き込みを、新しい `at` の
 *       書き込みが確実に先にコミットしたあとに実行する——「自然な頻度」ではなく、
 *       「そのとき何が起きるか」を機械的に確かめるための決定的な再現。
 * 3. **害の見積もり**（活動時計テナント）: 一致・逆順が起きたときに、`decay_base_seq`/
 *    `decay_floor_seq` へ実際に書かれた値が、どちらの呼び出しの `nowSeq` だったか
 *    （＝取り逃がした seq の差）を、`reinforce` の返り値そのものではなく**最終状態を
 *    1回読み直して**判定する（並行実行では個々の呼び出しの返り値は「その呼び出しが
 *    見たコミット時点」のスナップショットに過ぎず、全呼び出しが終わったあとの
 *    最終状態とは限らないため）。
 *
 * ## 実行方法
 *
 * `DATABASE_URL` が本物の Postgres + pgvector を指している状態で:
 *
 * ```
 * pnpm --filter @mnemora/postgres run bench:same-ms-usage
 * ```
 *
 * 試行回数は環境変数で調整できる（既定値は下の `DEFAULT_TRIALS` 参照）。
 * 全体で数十秒〜数分かかる（同時実行数32の並行シナリオが最も重い）。
 *
 * ## 実測した結果（参考。既定の試行回数での1回の実行——【実測】2026-09-25、
 * ローカルの initdb 起動の Postgres 17 + pgvector、Node v22.23.3、CPU 48コア。
 * **この節は「どこかの正本の写し」ではなく、測った記録そのものである**——実行するたびに
 * 具体的な数は変わりうる。数の桁・傾向を掴むための参考であり、閾値として使わない）
 *
 * - **時計の分解能**: 密なループで `Date.now()` を300万回呼ぶと、連続する呼び出しの
 *   **99.99%が直前と同じ値を返した**（`sameAsPreviousRate`）。刻みはおよそ1msごと
 *   （235ms の間に224回変化）。`performance.now()` はサブマイクロ秒の分解能を持つ。
 * - **2a/2b（recordUsage の重複排除）**: 200試行とも、2回目は常に空——`reinforce` 自体が
 *   呼ばれない。Issue #730 の対象はここではなく、recallId が異なる2回の報告である。
 * - **2c（逐次、recall を挟む）**: wall / 活動時計のどちらも、LLM 呼び出しなしの
 *   最悪条件（300試行）・300ms のLLM相当の遅延あり（50試行）のいずれでも、
 *   **`at` の一致は1件も観測されなかった**——2回の DB 往復（recall・report）が
 *   自然に生む遅延だけで、ミリ秒境界を跨ぐのに十分だった。
 * - **2d（並行 N 本、活動時計）**: `at` の一致は N が増えるほど増える
 *   （N=2: 30試行中7ペア、N=8: 30試行中43/840ペア、N=32: 30試行中1027/14880ペア）——
 *   **並行だと実際に起こる。** ただし、一致した組・`at` が逆順だった組のどちらも、
 *   実際に活動時計の `nowSeq` を取り逃がした例は**1件も観測されなかった**
 *   （`lostSeqDeltasAtTie`/`lostSeqDeltasReverseOrder` はどのシナリオでも空）。
 * - **2e（restoreArchived との重なり）**: 100試行中2ペアで `at` が一致したが、
 *   ここでも seq の取り逃がしは観測されなかった。
 * - **2f（強制的な逆順コミット）**: `at` の順序と `nowSeq` の順序を意図的に逆にすると
 *   （古い `at`・大きい `nowSeq` を、新しい `at`・小さい `nowSeq` の後に書き込む）、
 *   **50試行すべてで確実に no-op になり、`nowSeq` の差（この実演では 400）がそのまま
 *   失われた。**機構としての害は実在し、100%再現する——ただし自然な同時実行
 *   （2c/2d/2e）ではこの `at`/`nowSeq` の逆転そのものが一度も起こらなかった、という
 *   のがここまでの実測である。
 *
 * **確かめていないこと**: 複数の Node プロセス・複数ホストからの同時アクセス、
 * ネットワーク越しの DB（本測定は localhost）、GC 一時停止やイベントループの詰まりが
 * 大きい実運用下での `at`/`nowSeq` の逆転頻度。2f が示すとおり機構としての害は実在する
 * ため、この実測の「自然には起きなかった」を「起こりえない」と読み替えないこと。
 *
 * ## 引き受けた簡略化
 *
 * - シナリオ (a)/(b)/(e)/(f) と害の見積もりは、`runtime.recall()`（ANN 経路）を通さず
 *   `PostgresMemoryStore.createRecall` を直接呼んで recall 行を作る——`handleMemoryUsage`
 *   が触るのは `recalls.id` への外部キーだけであり、その行が ANN 経由か直接書き込みかは
 *   `reinforce`/`recordUsage` の挙動に影響しない（読んだコードの範囲での判断。実測で
 *   両経路の差を確かめてはいない）。
 * - シナリオ (c)/(d) は「examples/chat の会話ループに近い形」を要求されたため、
 *   `runtime.recall()` を実際に通す。単一の Memory を固定ベクトルで埋め込み、
 *   クエリも同じ固定ベクトルを渡すことで、毎回同じ Memory が確実に返る形にしている
 *   （意味のある近傍探索は測っていない——測っているのは reinforce の競合だけ）。
 */

import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type {
  Ctx,
  EmbeddingProvider,
  EmbeddingSpaceId,
  LLMProvider,
  Memory,
  ReinforceOptions,
} from "@mnemora/core";
import { createRuntime, DEFAULT_HALF_LIFE_RECALLS } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createPostgresClient, type PostgresClient } from "../client.js";
import { runMigrations } from "../migrate.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL が設定されていません。本物の Postgres + pgvector を指す接続文字列を" +
        "設定してから実行すること（擬似物では代替しない）。AGENTS.md「手元で Postgres を" +
        "立てる」参照。",
    );
  }
  return url;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`不正な ${name}: "${raw}"（正の整数で指定すること）`);
  }
  return n;
}

const DEFAULT_TRIALS = {
  clockSamples: envInt("BENCH_CLOCK_SAMPLES", 3_000_000),
  recordUsageDedupSameRecall: envInt("BENCH_TRIALS_A", 200),
  recordUsageDedupDuplicateId: envInt("BENCH_TRIALS_B", 200),
  sequentialTight: envInt("BENCH_TRIALS_C_TIGHT", 300),
  sequentialWithLlmGap: envInt("BENCH_TRIALS_C_GAP", 50),
  concurrentTrialsPerN: envInt("BENCH_TRIALS_D", 30),
  concurrentNs: (process.env.BENCH_CONCURRENT_NS ?? "2,8,32")
    .split(",")
    .map((s) => Number(s.trim())),
  restoreOverlap: envInt("BENCH_TRIALS_E", 100),
  forcedReverseCommit: envInt("BENCH_TRIALS_F", 50),
};

const BENCH_EMBEDDING_SPACE: EmbeddingSpaceId = {
  provider: "bench-730",
  model: "fixed-vector",
  dimensions: 3,
};
const FIXED_VECTOR = [1, 0, 0];
const LLM_GAP_MS = envInt("BENCH_LLM_GAP_MS", 300);

// ---------------------------------------------------------------------------
// 共通の下ごしらえ
// ---------------------------------------------------------------------------

function throwingLlm(): LLMProvider {
  return {
    complete: async () => {
      throw new Error("same-ms-usage-bench: LLM は使わない");
    },
    completeStructured: async () => {
      throw new Error("same-ms-usage-bench: LLM は使わない");
    },
  };
}

function throwingEmbeddingProvider(space: EmbeddingSpaceId): EmbeddingProvider {
  return {
    space,
    embed: async () => {
      throw new Error(
        "same-ms-usage-bench: embeddingProvider は使わない（recall には vector を直接渡す）",
      );
    },
  };
}

function dummyOutboxStore() {
  return {
    claimBatch: async () => [],
    complete: async () => {},
    fail: async () => {},
  };
}

function dummyEventStore() {
  return {
    append: async (_ctx: Ctx, e: { kind: string; at?: Date }) => ({
      id: randomUUID(),
      ...e,
      at: e.at ?? new Date(),
    }),
    get: async () => null,
    list: async () => [],
  };
}

interface Rig {
  memoryStore: PostgresMemoryStore;
  vectorStore: PostgresVectorStore;
  tenantSettingsStore: PostgresTenantSettingsStore;
  runtime: ReturnType<typeof createRuntime>;
  reinforceSpy: { setLog: (log: ReinforceCallLog[] | null) => void };
}

function buildRig(client: PostgresClient): Rig {
  const memoryStore = new PostgresMemoryStore(client.db);
  const vectorStore = new PostgresVectorStore(client.db);
  const tenantSettingsStore = new PostgresTenantSettingsStore(client.db);
  // `memoryStore.reinforce` を1回だけ差し替える(`installReinforceSpy` の doc コメント参照)。
  // `createRuntime` へ渡すのは、この差し替え後の `memoryStore` インスタンス——
  // `runtime.observe`/`runtime.restoreArchived` が内部で呼ぶ `deps.memoryStore.reinforce`
  // は、この時点でこのインスタンスが持つメソッドを常に指す。
  const reinforceSpy = installReinforceSpy(memoryStore);
  const runtime = createRuntime({
    memoryStore,
    outboxStore: dummyOutboxStore(),
    vectorStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventStore: dummyEventStore() as any,
    tenantSettingsStore,
    llmProvider: throwingLlm(),
    embeddingProvider: throwingEmbeddingProvider(BENCH_EMBEDDING_SPACE),
    hashContent: (content: string) => `sha256(${content})`,
    // clock は省略——systemClock（実時計、ミリ秒分解能）をそのまま使う。
    // これは意図的: このベンチが測りたいのは「本物の壁時計の下で何が起きるか」であり、
    // 偽の時計を注入すると測る対象そのものが消える。
  });
  return { memoryStore, vectorStore, tenantSettingsStore, runtime, reinforceSpy };
}

function freshCtx(): Ctx {
  return { tenantId: `bench-730-${randomUUID()}` };
}

/** `reinforce` に渡った引数と、その呼び出しが返した行の状態を記録する1件。 */
interface ReinforceCallLog {
  memoryId: string;
  at: Date;
  nowSeq: number | undefined;
  // その呼び出し「自身」が観測した返り値（並行実行では他の呼び出しに上書きされている
  // ことがあるため、最終判定には使わない——ここでは診断用にだけ残す）。
  observedLastReinforcedAt: Date | null;
  observedDecayBaseSeq: number | null;
}

/**
 * `store.reinforce` をインスタンス単位で**1回だけ**差し替え、呼ばれた引数と返り値を
 * 「そのとき差し込まれている」ログへ積む。クラス定義・プロトタイプは一切触らない
 * ——このインスタンスへの呼び出しだけを観測する。
 *
 * ⚠ **トライアルのたびに再度差し替えないこと。**`store.reinforce.bind(store)` を
 * 「元の実装」として毎回捕まえると、2回目以降の差し替えは「前回の差し替え後の関数」を
 * 元として包むことになり、呼び出しが前のトライアルのログにも積まれ続ける多重ラップに
 * なる——実際にこの実装で最初に踏んだ（集計がトライアル数と噛み合わなかった）。
 * 差し替えは1回だけ行い、どのログへ積むかを `setLog` で切り替える。
 */
function installReinforceSpy(store: PostgresMemoryStore): {
  setLog: (log: ReinforceCallLog[] | null) => void;
} {
  const original = store.reinforce.bind(store);
  let currentLog: ReinforceCallLog[] | null = null;
  store.reinforce = async (ctx: Ctx, id: string, at: Date, opts?: ReinforceOptions) => {
    const result = await original(ctx, id, at, opts);
    if (currentLog !== null) {
      currentLog.push({
        memoryId: id,
        at,
        nowSeq: opts?.nowSeq,
        observedLastReinforcedAt: result.lastReinforcedAt ?? null,
        observedDecayBaseSeq: result.decayBaseSeq ?? null,
      });
    }
    return result;
  };
  return {
    setLog: (log) => {
      currentLog = log;
    },
  };
}

/** `PostgresMemoryStore.createRecall` を直接呼んで、最小限の recall 行を1件作る。 */
async function seedRecall(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  memoryIds: string[],
  opts: { advanceActivityClock?: boolean } = {},
): Promise<string> {
  return memoryStore.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "bench-730" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: memoryIds.map((memoryId) => ({
      memoryId,
      score: { decay: 1, tagMatch: 0, freshness: 1, strength: 1, total: 1 },
      retrievedVia: "ann" as const,
    })),
    advanceActivityClock: opts.advanceActivityClock ?? false,
  });
}

async function createPlainMemory(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  overrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
): Promise<Memory> {
  return memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, ...overrides }),
  );
}

async function createEmbeddedMemory(
  memoryStore: PostgresMemoryStore,
  vectorStore: PostgresVectorStore,
  ctx: Ctx,
  overrides: Parameters<typeof buildNewMemoryFixture>[0] = {},
): Promise<Memory> {
  const memory = await createPlainMemory(memoryStore, ctx, {
    embeddingStatus: "ready",
    ...overrides,
  });
  await vectorStore.upsert(ctx, BENCH_EMBEDDING_SPACE, memory.id, FIXED_VECTOR);
  return memory;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// セクション1: 時計の分解能（DB 不要）
// ---------------------------------------------------------------------------

interface ClockResolutionResult {
  node: string;
  dateNow: {
    samples: number;
    distinctValues: number;
    sameAsPreviousRate: number;
    elapsedMs: number;
    avgCallsPerMs: number;
  };
  performanceNow: {
    samples: number;
    distinctValues: number;
    minObservedPositiveDiffMs: number;
  };
}

function measureClockResolution(samples: number): ClockResolutionResult {
  // Date.now(): 連続する呼び出しが同じ値を返す割合。
  let dnSameCount = 0;
  let dnDistinct = 1;
  let dnPrev = Date.now();
  const dnStart = performance.now();
  for (let i = 1; i < samples; i += 1) {
    const v = Date.now();
    if (v === dnPrev) {
      dnSameCount += 1;
    } else {
      dnDistinct += 1;
      dnPrev = v;
    }
  }
  const dnElapsedMs = performance.now() - dnStart;

  // performance.now(): 最小の正の刻み幅。
  let pnDistinct = 1;
  let pnPrev = performance.now();
  let minDiff = Number.POSITIVE_INFINITY;
  for (let i = 1; i < samples; i += 1) {
    const v = performance.now();
    if (v !== pnPrev) {
      const diff = v - pnPrev;
      if (diff > 0 && diff < minDiff) minDiff = diff;
      pnDistinct += 1;
      pnPrev = v;
    }
  }

  return {
    node: process.version,
    dateNow: {
      samples,
      distinctValues: dnDistinct,
      sameAsPreviousRate: dnSameCount / (samples - 1),
      elapsedMs: dnElapsedMs,
      avgCallsPerMs: samples / dnElapsedMs,
    },
    performanceNow: {
      samples,
      distinctValues: pnDistinct,
      minObservedPositiveDiffMs: minDiff,
    },
  };
}

// ---------------------------------------------------------------------------
// セクション2: シナリオ (a)/(b) — recordUsage の重複排除（reinforce に到達しない経路）
// ---------------------------------------------------------------------------

interface DedupResult {
  trials: number;
  firstCallInsertedCount: number[];
  secondCallInsertedCounts: number[];
  allSecondCallsEmpty: boolean;
  reinforceCallsForSecondReport: number;
}

async function scenarioSameRecallReportedTwice(rig: Rig, trials: number): Promise<DedupResult> {
  const secondCallInsertedCounts: number[] = [];
  const firstCallInsertedCount: number[] = [];
  let reinforceCallsForSecondReport = 0;

  for (let i = 0; i < trials; i += 1) {
    const ctx = freshCtx();
    const memory = await createPlainMemory(rig.memoryStore, ctx);
    const recallId = await seedRecall(rig.memoryStore, ctx, [memory.id]);

    const log: ReinforceCallLog[] = [];
    rig.reinforceSpy.setLog(log);

    const first = await rig.runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });
    firstCallInsertedCount.push(first.memoryIds.length);
    const logAfterFirst = log.length;

    const second = await rig.runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id],
    });
    secondCallInsertedCounts.push(second.memoryIds.length);
    reinforceCallsForSecondReport += log.length - logAfterFirst;
  }

  return {
    trials,
    firstCallInsertedCount,
    secondCallInsertedCounts,
    allSecondCallsEmpty: secondCallInsertedCounts.every((n) => n === 0),
    reinforceCallsForSecondReport,
  };
}

async function scenarioDuplicateIdInSingleReport(rig: Rig, trials: number): Promise<DedupResult> {
  const secondCallInsertedCounts: number[] = [];
  const firstCallInsertedCount: number[] = [];

  for (let i = 0; i < trials; i += 1) {
    const ctx = freshCtx();
    const memory = await createPlainMemory(rig.memoryStore, ctx);
    const recallId = await seedRecall(rig.memoryStore, ctx, [memory.id]);

    const result = await rig.runtime.observe(ctx, {
      kind: "memory_usage",
      recallId,
      usedMemoryIds: [memory.id, memory.id, memory.id],
    });
    firstCallInsertedCount.push(result.memoryIds.length);
    secondCallInsertedCounts.push(0); // このシナリオに「2回目」は無い。形を揃えるためのダミー。
  }

  return {
    trials,
    firstCallInsertedCount,
    secondCallInsertedCounts,
    allSecondCallsEmpty: firstCallInsertedCount.every((n) => n === 1),
    reinforceCallsForSecondReport: 0,
  };
}

// ---------------------------------------------------------------------------
// セクション2: シナリオ (c)/(d) の共通処理 — 異なる recallId からの reinforce 競合
// ---------------------------------------------------------------------------

interface CollisionTrialOutcome {
  memoryId: string;
  calls: ReinforceCallLog[];
  finalLastReinforcedAtMs: number | null;
  finalDecayBaseSeq: number | null;
}

/**
 * `calls`(同じ Memory に対する `reinforce` 呼び出しの列)を集計する。
 *
 * **`at` が一致するペアの数**（Issue #730 が指す形そのもの）と、**害（活動時計の
 * seq を実際に取り逃がしたか）を分けて数える**——`at` が一致しても害が出るとは
 * 限らない(誰かの書き込みが結果的に勝てば、その nowSeq が正しく残る)。害は
 * **呼び出し単位**で判定する: その呼び出しの `nowSeq` が、最終的に残った
 * `decay_base_seq` より大きいのに反映されていない場合だけが実害である
 * (`nowSeq` が最終値以下なら、そもそも取り逃がしていない——最終値のほうが
 * 進んでいるだけ)。
 *
 * `at` が一致しない場合の害(古い `at` が、より新しい `at` の後にコミットされて
 * no-op になった側の呼び出しが、たまたま大きい `nowSeq` を持っていた場合)も、
 * **同じ「呼び出し単位で `nowSeq` > 最終 `decay_base_seq`」の基準**で数える——
 * 逐次シナリオ(c)の通常経路(at も nowSeq も両方単調に増える)では、古い呼び出しが
 * 負けるのは当たり前で、それ自体は害ではない。害として数えるべきは、
 * **`at` の順序と `nowSeq` の順序が食い違った**ときだけである。
 */
interface CollisionStats {
  memoriesObserved: number;
  totalReinforceCalls: number;
  // `at` が一致した呼び出しペアの数(一致した回数そのもの)。
  equalAtPairs: number;
  totalPairs: number;
  // `at` が一致しなかったペアの数(参考——(e) の逆順コミットの機会の母数)。
  differingAtPairs: number;
  // 取り逃がした seq の差(nowSeq - 実際に残った decay_base_seq)の分布。
  // `at` が最終値と一致した呼び出しの損失(同着で負けた側)。
  lostSeqDeltasAtTie: number[];
  // `at` が最終値と一致しなかった呼び出しの損失(古い at が新しい at に
  // 追い越された側で、なお nowSeq のほうは進んでいた——「古い at の逆順コミット」
  // が実際に害を出したケース)。
  lostSeqDeltasReverseOrder: number[];
}

function analyzeCollisions(outcomes: CollisionTrialOutcome[]): CollisionStats {
  let equalAtPairs = 0;
  let totalPairs = 0;
  let differingAtPairs = 0;
  const lostSeqDeltasAtTie: number[] = [];
  const lostSeqDeltasReverseOrder: number[] = [];
  let totalReinforceCalls = 0;

  for (const outcome of outcomes) {
    totalReinforceCalls += outcome.calls.length;
    const final = outcome.finalLastReinforcedAtMs;
    const finalSeq = outcome.finalDecayBaseSeq;

    // 一致した回数(ペア単位、Issue #730 が指す量そのもの)。
    for (let i = 0; i < outcome.calls.length; i += 1) {
      for (let j = i + 1; j < outcome.calls.length; j += 1) {
        totalPairs += 1;
        const atA = outcome.calls[i]!.at.getTime();
        const atB = outcome.calls[j]!.at.getTime();
        if (atA === atB) {
          equalAtPairs += 1;
        } else {
          differingAtPairs += 1;
        }
      }
    }

    // 害(呼び出し単位)。
    if (final === null || finalSeq === null) continue;
    for (const call of outcome.calls) {
      if (call.nowSeq === undefined) continue;
      const delta = call.nowSeq - finalSeq;
      if (delta <= 0) continue; // 最終値のほうが進んでいる、または同じ——取り逃がしていない。
      if (call.at.getTime() === final) {
        lostSeqDeltasAtTie.push(delta);
      } else {
        lostSeqDeltasReverseOrder.push(delta);
      }
    }
  }

  return {
    memoriesObserved: outcomes.length,
    totalReinforceCalls,
    equalAtPairs,
    totalPairs,
    differingAtPairs,
    lostSeqDeltasAtTie,
    lostSeqDeltasReverseOrder,
  };
}

async function readFinalState(
  memoryStore: PostgresMemoryStore,
  ctx: Ctx,
  memoryId: string,
): Promise<{ finalLastReinforcedAtMs: number | null; finalDecayBaseSeq: number | null }> {
  const memory = await memoryStore.get(ctx, memoryId);
  return {
    finalLastReinforcedAtMs: memory?.lastReinforcedAt?.getTime() ?? null,
    finalDecayBaseSeq: memory?.decayBaseSeq ?? null,
  };
}

// ---------------------------------------------------------------------------
// セクション2: シナリオ (c) — 逐次、recall を挟む
// ---------------------------------------------------------------------------

async function scenarioSequential(
  rig: Rig,
  trials: number,
  opts: { gapMs: number; activityClock: boolean },
): Promise<CollisionStats> {
  const outcomes: CollisionTrialOutcome[] = [];

  for (let i = 0; i < trials; i += 1) {
    const ctx = freshCtx();
    if (opts.activityClock) {
      await rig.tenantSettingsStore.setDecayClock(ctx, "activity");
    }
    const memory = await createEmbeddedMemory(rig.memoryStore, rig.vectorStore, ctx, {
      halfLifeRecalls: opts.activityClock ? DEFAULT_HALF_LIFE_RECALLS : undefined,
    });

    const log: ReinforceCallLog[] = [];
    rig.reinforceSpy.setLog(log);

    const recall1 = await rig.runtime.recall(ctx, { vector: FIXED_VECTOR, limit: 1 });
    await rig.runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: recall1.recallId,
      usedMemoryIds: [memory.id],
    });

    if (opts.gapMs > 0) {
      await sleep(opts.gapMs);
    }

    const recall2 = await rig.runtime.recall(ctx, { vector: FIXED_VECTOR, limit: 1 });
    await rig.runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: recall2.recallId,
      usedMemoryIds: [memory.id],
    });

    const final = await readFinalState(rig.memoryStore, ctx, memory.id);
    outcomes.push({ memoryId: memory.id, calls: log, ...final });
  }

  return analyzeCollisions(outcomes);
}

// ---------------------------------------------------------------------------
// セクション2: シナリオ (d) — 並行 N 本
// ---------------------------------------------------------------------------

async function scenarioConcurrent(rig: Rig, n: number, trials: number): Promise<CollisionStats> {
  const outcomes: CollisionTrialOutcome[] = [];

  for (let t = 0; t < trials; t += 1) {
    const ctx = freshCtx();
    await rig.tenantSettingsStore.setDecayClock(ctx, "activity");
    const memory = await createEmbeddedMemory(rig.memoryStore, rig.vectorStore, ctx, {
      halfLifeRecalls: DEFAULT_HALF_LIFE_RECALLS,
    });

    const log: ReinforceCallLog[] = [];
    rig.reinforceSpy.setLog(log);

    await Promise.all(
      Array.from({ length: n }, async () => {
        const recall = await rig.runtime.recall(ctx, { vector: FIXED_VECTOR, limit: 1 });
        await rig.runtime.observe(ctx, {
          kind: "memory_usage",
          recallId: recall.recallId,
          usedMemoryIds: [memory.id],
        });
      }),
    );

    const final = await readFinalState(rig.memoryStore, ctx, memory.id);
    outcomes.push({ memoryId: memory.id, calls: log, ...final });
  }

  return analyzeCollisions(outcomes);
}

// ---------------------------------------------------------------------------
// セクション2: シナリオ (e) — restoreArchived と使用報告の重なり
// ---------------------------------------------------------------------------

async function scenarioRestoreOverlap(rig: Rig, trials: number): Promise<CollisionStats> {
  const outcomes: CollisionTrialOutcome[] = [];

  for (let i = 0; i < trials; i += 1) {
    const ctx = freshCtx();
    await rig.tenantSettingsStore.setDecayClock(ctx, "activity");
    const memory = await createPlainMemory(rig.memoryStore, ctx, {
      status: "archived",
      halfLifeRecalls: DEFAULT_HALF_LIFE_RECALLS,
    });
    const recallId = await seedRecall(rig.memoryStore, ctx, [memory.id]);

    const log: ReinforceCallLog[] = [];
    rig.reinforceSpy.setLog(log);

    await Promise.all([
      rig.runtime.restoreArchived(ctx, { memoryId: memory.id }),
      rig.runtime.observe(ctx, {
        kind: "memory_usage",
        recallId,
        usedMemoryIds: [memory.id],
      }),
    ]);

    const final = await readFinalState(rig.memoryStore, ctx, memory.id);
    outcomes.push({ memoryId: memory.id, calls: log, ...final });
  }

  return analyzeCollisions(outcomes);
}

// ---------------------------------------------------------------------------
// セクション2: シナリオ (f) — 強制的な逆順コミットの実演（自然頻度ではなく機械的確認）
// ---------------------------------------------------------------------------

interface ForcedReverseCommitResult {
  trials: number;
  oldAtAlwaysNoOp: boolean;
  seqLossWhenOldAtHadLargerSeq: number[];
}

async function scenarioForcedReverseCommit(
  rig: Rig,
  trials: number,
): Promise<ForcedReverseCommitResult> {
  const seqLossWhenOldAtHadLargerSeq: number[] = [];
  let oldAtAlwaysNoOp = true;

  for (let i = 0; i < trials; i += 1) {
    const ctx = freshCtx();
    await rig.tenantSettingsStore.setDecayClock(ctx, "activity");
    const memory = await createPlainMemory(rig.memoryStore, ctx, {
      halfLifeRecalls: DEFAULT_HALF_LIFE_RECALLS,
    });

    const oldAt = new Date(memory.recordedAt.getTime() + 1000 * 60 * 60);
    const newAt = new Date(memory.recordedAt.getTime() + 1000 * 60 * 60 * 2);
    // 「A(古い at・大きい nowSeq) が、B(新しい at・小さい nowSeq) より後にコミットされる」
    // という、活動時計にとって最悪の組み合わせを意図的に作る——古い at のほうが seq は
    // 進んでいた、という状況が実際に起こりうることを機械的に示す（並行下で seq の
    // 進み方と at の発行順が一致する保証は無い——両者は別のクロックである）。
    const oldAtLargerSeq = 500;
    const newAtSmallerSeq = 100;

    // 先に新しい at で確定させる。
    await rig.memoryStore.reinforce(ctx, memory.id, newAt, { nowSeq: newAtSmallerSeq });
    // そのあとで、古い at・より大きい nowSeq を持つ書き込みを試みる。
    const result = await rig.memoryStore.reinforce(ctx, memory.id, oldAt, {
      nowSeq: oldAtLargerSeq,
    });

    if (result.lastReinforcedAt?.getTime() !== newAt.getTime()) {
      oldAtAlwaysNoOp = false;
    }
    if ((result.decayBaseSeq ?? null) !== newAtSmallerSeq) {
      // 古い at の書き込みが決して適用されないなら、ここは常に newAtSmallerSeq のまま。
      oldAtAlwaysNoOp = false;
    }
    // 古い at のほうが本来 nowSeq が大きかった（=より活発だった）のに、結果は
    // newAtSmallerSeq のまま——差分を損失として記録する。
    seqLossWhenOldAtHadLargerSeq.push(oldAtLargerSeq - newAtSmallerSeq);
  }

  return { trials, oldAtAlwaysNoOp, seqLossWhenOldAtHadLargerSeq };
}

// ---------------------------------------------------------------------------
// 害の見積もり（decay への影響）
// ---------------------------------------------------------------------------

function estimateDecayImpact(lostSeqDeltas: number[]): {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  // halfLifeRecalls=DEFAULT_HALF_LIFE_RECALLS のとき、seq が delta だけ余計に「古い」
  // ことにされた場合の強さの相対低下（0.5 ** (delta / halfLifeRecalls) - 1、負の値）。
  strengthRatioAtP50: number;
  strengthRatioAtP95: number;
  strengthRatioAtMax: number;
} | null {
  if (lostSeqDeltas.length === 0) return null;
  const sorted = [...lostSeqDeltas].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const strengthRatio = (delta: number) => 0.5 ** (delta / DEFAULT_HALF_LIFE_RECALLS) - 1;
  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean,
    p50: pick(0.5),
    p95: pick(0.95),
    strengthRatioAtP50: strengthRatio(pick(0.5)),
    strengthRatioAtP95: strengthRatio(pick(0.95)),
    strengthRatioAtMax: strengthRatio(sorted[sorted.length - 1]!),
  };
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

function printImpact(label: string, stats: CollisionStats): void {
  const atTie = estimateDecayImpact(stats.lostSeqDeltasAtTie);
  const reverseOrder = estimateDecayImpact(stats.lostSeqDeltasReverseOrder);
  console.log(
    `害の見積もり（${label}）: at一致による損失=${JSON.stringify(atTie)} / 逆順コミットによる損失=${JSON.stringify(reverseOrder)}`,
  );
}

async function main(): Promise<void> {
  const databaseUrl = requireDatabaseUrl();
  console.log(`# Issue #730 same-ms usage bench`);
  console.log(
    `node: ${process.version}, cpus: ${await import("node:os").then((os) => os.cpus().length)}`,
  );
  console.log("");

  console.log("## 1. 時計の分解能（DB 不要）");
  const clockResult = measureClockResolution(DEFAULT_TRIALS.clockSamples);
  console.log(JSON.stringify(clockResult, null, 2));
  console.log("");

  const client = createPostgresClient(databaseUrl);
  try {
    await runMigrations(client.pool);
    await registerEmbeddingSpace(client.pool, BENCH_EMBEDDING_SPACE);
    const rig = buildRig(client);

    console.log(
      `## 2a. 同じ recall を2回報告（${DEFAULT_TRIALS.recordUsageDedupSameRecall} 試行）`,
    );
    const a = await scenarioSameRecallReportedTwice(rig, DEFAULT_TRIALS.recordUsageDedupSameRecall);
    console.log(
      JSON.stringify(
        {
          trials: a.trials,
          allSecondCallsEmpty: a.allSecondCallsEmpty,
          reinforceCallsForSecondReport: a.reinforceCallsForSecondReport,
        },
        null,
        2,
      ),
    );
    console.log("");

    console.log(
      `## 2b. 1回の報告で usedMemoryIds に同じ id が3回重複（${DEFAULT_TRIALS.recordUsageDedupDuplicateId} 試行）`,
    );
    const b = await scenarioDuplicateIdInSingleReport(
      rig,
      DEFAULT_TRIALS.recordUsageDedupDuplicateId,
    );
    console.log(
      JSON.stringify(
        {
          trials: b.trials,
          allFirstCallsInsertedExactlyOne: b.allSecondCallsEmpty,
        },
        null,
        2,
      ),
    );
    console.log("");

    console.log(
      `## 2c-tight. 逐次・LLM 呼び出しなしの最悪条件（wall のみ、${DEFAULT_TRIALS.sequentialTight} 試行）`,
    );
    const cTightWall = await scenarioSequential(rig, DEFAULT_TRIALS.sequentialTight, {
      gapMs: 0,
      activityClock: false,
    });
    console.log(JSON.stringify(cTightWall, null, 2));
    console.log("");

    console.log(
      `## 2c-tight-activity. 逐次・LLM 呼び出しなしの最悪条件（活動時計、${DEFAULT_TRIALS.sequentialTight} 試行）`,
    );
    const cTightActivity = await scenarioSequential(rig, DEFAULT_TRIALS.sequentialTight, {
      gapMs: 0,
      activityClock: true,
    });
    console.log(JSON.stringify(cTightActivity, null, 2));
    printImpact("2c-tight-activity", cTightActivity);
    console.log("");

    console.log(
      `## 2c-gap. 逐次・LLM 相当の遅延あり（${LLM_GAP_MS}ms、活動時計、${DEFAULT_TRIALS.sequentialWithLlmGap} 試行）`,
    );
    const cGap = await scenarioSequential(rig, DEFAULT_TRIALS.sequentialWithLlmGap, {
      gapMs: LLM_GAP_MS,
      activityClock: true,
    });
    console.log(JSON.stringify(cGap, null, 2));
    printImpact("2c-gap", cGap);
    console.log("");

    for (const n of DEFAULT_TRIALS.concurrentNs) {
      console.log(`## 2d. 並行 N=${n}（活動時計、${DEFAULT_TRIALS.concurrentTrialsPerN} 試行）`);
      const d = await scenarioConcurrent(rig, n, DEFAULT_TRIALS.concurrentTrialsPerN);
      console.log(JSON.stringify(d, null, 2));
      printImpact(`2d N=${n}`, d);
      console.log("");
    }

    console.log(
      `## 2e. restoreArchived と使用報告の重なり（活動時計、${DEFAULT_TRIALS.restoreOverlap} 試行）`,
    );
    const e = await scenarioRestoreOverlap(rig, DEFAULT_TRIALS.restoreOverlap);
    console.log(JSON.stringify(e, null, 2));
    printImpact("2e", e);
    console.log("");

    console.log(`## 2f. 強制的な逆順コミットの実演（${DEFAULT_TRIALS.forcedReverseCommit} 試行）`);
    const f = await scenarioForcedReverseCommit(rig, DEFAULT_TRIALS.forcedReverseCommit);
    console.log(
      JSON.stringify(
        {
          trials: f.trials,
          oldAtAlwaysNoOp: f.oldAtAlwaysNoOp,
          seqLossWhenOldAtHadLargerSeq: {
            count: f.seqLossWhenOldAtHadLargerSeq.length,
            allPositive: f.seqLossWhenOldAtHadLargerSeq.every((d) => d > 0),
            sample: f.seqLossWhenOldAtHadLargerSeq.slice(0, 5),
          },
        },
        null,
        2,
      ),
    );
    console.log("");
  } finally {
    await client.pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
