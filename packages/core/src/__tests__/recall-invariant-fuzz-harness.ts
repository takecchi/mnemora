import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import type { RecallQuery, RecallResult } from "../recall.js";
import type { createRuntime as CreateRuntime, RuntimeDeps } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";

/**
 * recall の不変条件を、シードつきのランダムな操作列で検査する検査器の本体（Issue #1019・#1020・
 * #1021 を見つけた検査器）。store 一式は呼び出し側が渡す——Fake（`recall-invariant-fuzz.test.ts`）と
 * Postgres（`packages/postgres/src/__tests__/recall-invariant-fuzz.postgres.test.ts`）が同じ操作列・
 * 同じ検査を共有する。
 *
 * 操作: 記憶の作成（ゼロベクトル・`pending` を含む）、recall（`limit`・連想枠・予算・閾値・
 * 語彙チャンネルを振る）、使用報告による強化、forget、purge、restoreArchived、markContested、
 * resolveContested、consolidate（LLM は固定の応答）、sweepArchive、時計を進める。
 *
 * recall のたびに検査する不変条件と、その約束の在り処:
 * - I1 contested は対向なしで返らない（`docs/architecture.md` §0 原則1、`MemoryStore` の契約、
 *   `docs/recall.md` §8、ADR 0136、Issue #959）
 * - I2 `memories` に同じ id が2回出ない（ADR 0203）
 * - I3 status が active/contested 以外の記憶・purge 済みの記憶は返らない
 *   （`docs/recall.md` §2 段0 の status ゲート、ADR 0124）
 * - I4 `below_threshold.nearMisses` の id は返っておらず、score は閾値未満（ADR 0203、
 *   `BelowThresholdOmission` の doc）
 * - I5 `score.total` は `affinity × decay × tagMatch × freshness × strength`
 *   （`strategies/scoring.ts`、`docs/recall.md` §7）
 * - I6 `axis: 'subject'` の群カウントの総和は `totalInScope`（`docs/recall.md` §5）
 * - I7 digest 帯の id は返っていない（`docs/recall.md` §5）
 * - I8 `contestedWith` の相手は同じ結果に居る（ADR 0335）
 * - I9 同じ操作列は同じ結果を返す（Fake の決定性。`checkDeterminism` を立てた backend だけ）
 * - I10 件数の勘定。スコープ内の記憶を、返したもの（status が active/contested）と、**候補ごとの層**の
 *   札（`below_threshold`・`over_limit`・`budget_dropped`・`score_not_comparable`・
 *   `unit_assembly_dropped`）の件数で数える。**集約の層**の札（`not_indexed`、`filtered` のすべての
 *   `condition`）は、スコープ全体の集約から出す件数で、排他性の対象の外に置く（ADR 0203 追記9、
 *   Issue #1021・#1025）ので、この和には入れない。
 *   - 上限: 和 ≦ `totalInScope`。ADR 0203 の「1件の Memory は `omitted` の中で1回だけ数える」
 *     （決めたこと1、追記3〜8）から導ける。
 *   - 下限: 候補ごとの層の件数がすべて `'exact'` で、件数を持たない札（`ann_truncated`・
 *     `ann_unreached`・`lexical_truncated`・段1の `stage_skipped`）が無いとき、
 *     和 ≧ `totalInScope` − `not_indexed` − スコープ内の `filtered`（`within_scope`）。
 *     候補にならなかったスコープ内の記憶は、埋め込みが無いか減衰しきっているかのどちらかであり、
 *     それは集約の層の札が数えている。`docs/recall.md` 冒頭の原則3（結果は、そこから漏れたものと
 *     必ず同時に提示する）から導ける。
 * - I11 集約の件数を、検査器が作った記憶の現在の状態から独立に数えた値と突き合わせる。この検査器の
 *   recall は scope を絞らない（subject・期間・`validAt` の外に出る記憶・taxonomy を持たない）ので、
 *   `totalInScope` は status が active/contested の記憶の件数（`docs/recall.md` §5「`totalInScope` が
 *   何を数えているか」）、`not_indexed` の合計はそのうち埋め込みが `ready` でないものの件数に等しい。
 *   I10 の下限は、`totalInScope` が膨らむと `ann_unreached` が立って効かなくなる（eligible も一緒に
 *   膨らむ）ので、膨らみはここで捕まえる。
 * - I12 `filtered`（`outside_scope`）の `archived`・`superseded`・`forgotten` の件数は、その status の
 *   記憶の件数に等しい（`docs/recall.md` §5 の表の甲群）。
 *
 * 落ちたときは、操作を1つずつ抜いて違反が残るかを見る形で操作列を最小化し、シードと最小の
 * 操作列を出力に出す。
 */

export const FUZZ_CTX: Ctx = { tenantId: "tenant-1" };
const ctx = FUZZ_CTX;
const T0 = new Date("2026-06-01T00:00:00.000Z").getTime();

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Op =
  | {
      k: "create";
      v: number;
      tags: string[];
      ready: boolean;
      zero: boolean;
      subj: boolean;
      hl: number;
    }
  | {
      k: "recall";
      v: number;
      limit: number;
      off: number;
      assoc: number;
      budget: number;
      thr: number;
      lex: boolean;
    }
  | { k: "bulk"; n: number; seed: number }
  | { k: "usage"; pick: number }
  | { k: "forget"; i: number }
  | { k: "purge"; i: number }
  | { k: "restore"; i: number }
  | { k: "mark"; i: number; j: number }
  | { k: "resolve"; i: number; sup: boolean }
  | { k: "consolidate"; i: number; j: number }
  | { k: "sweep" }
  | { k: "advance"; hours: number };

/** 操作列が使うベクトル（2次元）。backend の空間の次元へは `FuzzBackend.vector` が写す。 */
const VECS = [
  [1, 0],
  [0.95, 0.31],
  [0.7, 0.71],
  [0.31, 0.95],
  [0, 1],
  [0.05, 0.9987],
];

/**
 * 操作列の形。
 * - `default`: 元の検査器（PR #1030）の操作列そのもの。同じシードは同じ列になる。
 * - `wide`: 記憶を一度に数十〜数百件作る `bulk` を混ぜ、recall の窓（`limit`・`overFetchFactor`）を
 *   広げる。`default` は1シードの記憶が高々二十数件で、窓 k' が scope の候補より小さいため
 *   `ann_unreached`（info）がほぼ常に立ち、I10 の下限がほとんど効かない。`wide` は
 *   索引（HNSW）を通る規模と、k' ≧ 候補数の recall（I10 の下限が効く）の両方を作る。
 */
export type FuzzProfile = "default" | "wide";

export function genOps(seed: number, n: number, profile: FuzzProfile = "default"): Op[] {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const idx = () => Math.floor(r() * 1000);
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    const x = r();
    if (profile === "wide" && (i === 0 || r() < 0.04)) {
      ops.push({ k: "bulk", n: pick([20, 60, 150]), seed: Math.floor(r() * 2 ** 31) });
      continue;
    }
    if (i < 3 || x < 0.3) {
      ops.push({
        k: "create",
        v: Math.floor(r() * VECS.length),
        tags: ["a", "b", "c"].filter(() => r() < 0.4),
        ready: r() < 0.9,
        zero: r() < 0.05,
        subj: r() < 0.3,
        hl: pick([1, 24, 24 * 365]),
      });
    } else if (x < 0.6) {
      ops.push({
        k: "recall",
        v: Math.floor(r() * VECS.length),
        limit: 1 + Math.floor(r() * (profile === "wide" ? 20 : 4)),
        off: 1 + Math.floor(r() * (profile === "wide" ? 5 : 3)),
        assoc: Math.floor(r() * 3),
        budget: pick([0, 0, 5, 12, 25]),
        thr: pick([-1, 0, 0.3, 0.6]),
        lex: r() < 0.2,
      });
    } else if (x < 0.68) ops.push({ k: "usage", pick: idx() });
    else if (x < 0.74) ops.push({ k: "forget", i: idx() });
    else if (x < 0.78) ops.push({ k: "purge", i: idx() });
    else if (x < 0.8) ops.push({ k: "restore", i: idx() });
    else if (x < 0.87) ops.push({ k: "mark", i: idx(), j: idx() });
    else if (x < 0.91) ops.push({ k: "resolve", i: idx(), sup: r() < 0.5 });
    else if (x < 0.94) ops.push({ k: "consolidate", i: idx(), j: idx() });
    else if (x < 0.96) ops.push({ k: "sweep" });
    else ops.push({ k: "advance", hours: pick([1, 24, 24 * 30, 24 * 400]) });
  }
  return ops;
}

/** 検査器が使う store 一式（`createFakeRuntimeStores()` の戻り値と同じ形）。 */
export type FuzzStores = Pick<
  RuntimeDeps,
  "memoryStore" | "outboxStore" | "vectorStore" | "eventStore" | "tenantSettingsStore"
> & {
  lexicalStore: NonNullable<RuntimeDeps["lexicalStore"]>;
  embeddingProvider: RuntimeDeps["embeddingProvider"];
};

export interface FuzzBackend {
  /**
   * 1回の実行ぶんの store 一式を、前の実行の状態を持ち越さない形で用意する。`createRuntime` も
   * 一緒に返す——Fake は id の採番をモジュール単位の続き番号で持つので、実行ごとにモジュールを
   * 読み直す（I9）。
   */
  setup(): Promise<{ stores: FuzzStores; createRuntime: typeof CreateRuntime }>;
  /** `VECS` の2次元ベクトルを、`stores.embeddingProvider.space` の次元へ写す。 */
  vector(v: readonly number[]): number[];
}

export interface Violation {
  inv: string;
  detail: string;
  op: number;
}

export interface RunOutcome {
  violations: Violation[];
  trace: string[];
  /**
   * recall ごとの、backend に依らない形の結果（`RunOptions.snapshot` を立てたときだけ）。
   * Memory の id は作成順の別名（`c0`, `c1`, …。検査器が作ったもの以外は初出順の `x0`, …）へ、
   * 数値は有効数字6桁へ丸める——Fake と Postgres の差分検査（`diffBackends`）が突き合わせる。
   */
  snapshots: string[];
}

/**
 * 差分検査で `VECS` の代わりに使うベクトル。角度（度）をゴロム定規 {0, 1, 4, 10, 12, 17} の
 * 5倍に置く——どの2本の組の角度差も互いに異なるので、**違うベクトルどうしが、あるクエリに
 * 対して数学的に同じ cosine を持つことが無い**。`VECS` は鏡像（[0.95, 0.31] と [0.31, 0.95]、
 * [1, 0] と [0, 1]）を含み、数学的な同点を作る。同点の決着は浮動小数の端数に落ち、pgvector は
 * ベクトルを float4 で持つので、Fake（float8）と逆に転ぶことがある（実測: seed 183 の連想枠の
 * 過取得の窓、#1033）。
 */
const DIFF_VECS = [0, 5, 20, 50, 60, 85].map((deg) => [
  Math.cos((deg * Math.PI) / 180),
  Math.sin((deg * Math.PI) / 180),
]);

export interface RunOptions {
  /**
   * 操作ごと（`bulk` は1件ごと）に時計を進める（既定は進めない）。同じ時刻に作った記憶の並びは
   * id で決着し、id の振り方は backend ごとに違う（Fake は続き番号、Postgres は
   * `gen_random_uuid()`）。差分検査では時刻をずらして、並びを id に頼らせない。
   * 進め幅は、このシードの擬似乱数で 1〜1,000,000 ms に散らす——一定の幅だと
   * 「減衰の起点 + 鮮度の起点 = 2 × 別の記憶の起点」のような算術的な一致が起き、
   * 数学的に同点の total を作る（実測: seed 85、#1033）。
   */
  jitterSeed?: number;
  /** `VECS` の代わりに `DIFF_VECS` を使う。 */
  diffVectors?: boolean;
  snapshot?: boolean;
}

export async function runOps(
  backend: FuzzBackend,
  ops: readonly Op[],
  runOpts: RunOptions = {},
): Promise<RunOutcome> {
  const jitter = runOpts.jitterSeed === undefined ? undefined : rng(runOpts.jitterSeed);
  const step = () => (jitter ? 1 + Math.floor(jitter() * 1_000_000) : 0);
  const vecs = runOpts.diffVectors ? DIFF_VECS : VECS;
  let now = T0;
  const { stores, createRuntime } = await backend.setup();
  const vec = (i: number) => backend.vector(vecs[i]!);
  const llm = {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async (
      _c: Ctx,
      req: { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } },
    ) => {
      for (const cand of [
        { content: "merged", digest: "merged" },
        { outcome: "reflected", content: "reflection", digest: "reflection" },
      ]) {
        const parsed = req.schema.safeParse(cand);
        if (parsed.success) return parsed.data;
      }
      throw new Error("stub: no candidate matched");
    },
  };
  const makeRuntime = (lexical: boolean) =>
    createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      lexicalStore: lexical ? stores.lexicalStore : undefined,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llm as never,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => new Date(now) },
    });
  const rt = makeRuntime(false);
  const rtLex = makeRuntime(true);
  const ids: MemoryId[] = [];
  /** I11・I12 の数え上げ用。`ids` と違い、consolidate が作った記憶も入れる（`nth` の意味は変えない）。 */
  const allIds: MemoryId[] = [];
  let lastRecall: RecallResult | null = null;
  const violations: Violation[] = [];
  const trace: string[] = [];
  const snapshots: string[] = [];
  const alias = new Map<string, string>();
  let extra = 0;
  const normalize = async (value: unknown): Promise<unknown> => {
    if (typeof value === "number") return Number(value.toPrecision(6));
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") {
      const known = alias.get(value);
      if (known !== undefined) return known;
      if (/^mem-\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) {
        const m = await stores.memoryStore.get(ctx, value as MemoryId);
        if (m) {
          const name = `x${extra++}`;
          alias.set(value, name);
          return name;
        }
      }
      return value;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const x of value) out.push(await normalize(x));
      return out;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        if (k === "recallId") continue;
        out[k] = await normalize((value as Record<string, unknown>)[k]);
        // `groups` の出現順序は契約にしない（ADR 0307 決定6）。
        if (k === "groups" && Array.isArray(out[k]))
          out[k] = (out[k] as unknown[])
            .map((g) => JSON.stringify(g))
            .sort()
            .map((g) => JSON.parse(g) as unknown);
      }
      return out;
    }
    return value;
  };
  const nth = (i: number) => (ids.length > 0 ? ids[i % ids.length] : undefined);

  const check = async (r: RecallResult, q: RecallQuery, oi: number) => {
    const v = (inv: string, detail: string) => violations.push({ inv, detail, op: oi });
    const returned = new Set(r.memories.map((m) => m.memoryId));
    if (returned.size !== r.memories.length) v("I2-unique", JSON.stringify([...returned]));
    let returnedInScope = 0;
    for (const rm of r.memories) {
      const m = await stores.memoryStore.get(ctx, rm.memoryId);
      if (!m) {
        v("I3-missing", rm.memoryId);
        continue;
      }
      if (m.status === "active" || m.status === "contested") returnedInScope++;
      else v("I3-status", `${rm.memoryId} ${m.status} via ${rm.retrievedVia}`);
      if (m.purgedAt) v("I3-purged", rm.memoryId);
      if (m.status === "contested" && m.contestedWithId && !returned.has(m.contestedWithId)) {
        v("I1-lone-contested", `${rm.memoryId} via ${rm.retrievedVia}`);
      }
      if (rm.contestedWith !== undefined && !returned.has(rm.contestedWith))
        v("I8-contestedWith", rm.memoryId);
      const s = rm.score;
      const affinity =
        s.lexicalMatch === undefined
          ? (s.similarity ?? 1)
          : s.similarity === undefined
            ? s.lexicalMatch
            : Math.max(s.similarity, s.lexicalMatch);
      const product = affinity * s.decay * s.tagMatch * s.freshness * s.strength;
      if (!(Number.isNaN(product) && Number.isNaN(s.total)) && product !== s.total) {
        v("I5-product", `${rm.memoryId} ${product} vs ${s.total}`);
      }
    }
    const threshold = q.scoreThreshold ?? 0.1;
    for (const o of r.omitted) {
      if (o.kind !== "below_threshold") continue;
      for (const nm of o.nearMisses ?? []) {
        if (returned.has(nm.memoryId)) v("I4-nearMiss-returned", nm.memoryId);
        if (!(nm.score < threshold))
          v("I4-nearMiss-score", `${nm.memoryId} ${nm.score} < ${threshold}`);
      }
    }
    const subjectSum = r.index.groups
      .filter((g) => g.axis === "subject")
      .reduce((acc, g) => acc + g.count, 0);
    if (subjectSum !== r.index.totalInScope)
      v("I6-groups", `${subjectSum} vs ${r.index.totalInScope}`);
    for (const d of r.index.digestBand ?? [])
      if (returned.has(d.memoryId)) v("I7-band-returned", d.memoryId);

    let counted = returnedInScope;
    // 集約の層の札（ADR 0203 追記9）。和には入れず、下限の余白にだけ使う。
    let aggregateSlack = 0;
    let allExact = true;
    for (const o of r.omitted) {
      switch (o.kind) {
        case "not_indexed":
          aggregateSlack += o.count;
          break;
        case "filtered":
          if (o.scopeRelation === "within_scope") aggregateSlack += o.count;
          break;
        case "below_threshold":
        case "over_limit":
        case "budget_dropped":
        case "score_not_comparable":
        case "unit_assembly_dropped":
          counted += o.count;
          if (o.countKind !== "exact") allExact = false;
          break;
        case "ann_truncated":
        case "ann_unreached":
        case "lexical_truncated":
          allExact = false;
          break;
        case "stage_skipped":
          if (o.stage !== "association") allExact = false;
          break;
      }
    }
    const summary = () =>
      `returned ${returnedInScope}, counted ${counted}, aggregate-layer ${aggregateSlack}, total ${r.index.totalInScope} :: ${JSON.stringify(r.omitted)}`;
    if (counted > r.index.totalInScope) v("I10-upper", summary());
    if (allExact && counted < r.index.totalInScope - aggregateSlack) v("I10-lower", summary());

    const all = await stores.memoryStore.getMany(ctx, allIds);
    const live = all.filter((m) => m.status === "active" || m.status === "contested");
    if (r.index.totalInScope !== live.length)
      v("I11-totalInScope", `${r.index.totalInScope} vs ${live.length}`);
    const notIndexed = r.omitted.reduce(
      (acc, o) => acc + (o.kind === "not_indexed" ? o.count : 0),
      0,
    );
    const unready = live.filter((m) => m.embeddingStatus !== "ready").length;
    if (notIndexed !== unready) v("I11-notIndexed", `${notIndexed} vs ${unready}`);
    for (const status of ["archived", "superseded", "forgotten"] as const) {
      const reported = r.omitted.reduce(
        (acc, o) =>
          acc +
          (o.kind === "filtered" && o.condition === status && o.scopeRelation === "outside_scope"
            ? o.count
            : 0),
        0,
      );
      const actual = all.filter((m) => m.status === status).length;
      if (reported !== actual) v(`I12-filtered-${status}`, `${reported} vs ${actual}`);
    }
  };

  const createOne = async (
    op: { tags: string[]; ready: boolean; subj: boolean; hl: number },
    vector: number[],
  ) => {
    const at = new Date(now);
    const n: NewMemory = {
      tenantId: ctx.tenantId,
      subjectId: op.subj ? "s1" : null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `content ${ids.length} ${op.tags.join(" ")}`,
      contentHash: `h${ids.length}`,
      digest: `d${ids.length}`,
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fuzz" },
      tags: op.tags,
      occurredAt: null,
      recordedAt: at,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: op.hl,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt: at,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: op.hl,
      }),
      embeddingStatus: op.ready ? "ready" : "pending",
    };
    const m = await stores.memoryStore.createMemory(ctx, n);
    alias.set(m.id, `c${ids.length}`);
    if (op.ready) {
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, m.id, vector);
    }
    ids.push(m.id);
    allIds.push(m.id);
    now += step();
  };

  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi]!;
    try {
      switch (op.k) {
        case "create":
          await createOne(op, op.zero ? backend.vector([0, 0]) : vec(op.v));
          break;
        case "bulk": {
          const br = rng(op.seed);
          for (let b = 0; b < op.n; b++) {
            // 第1象限の単位ベクトル（`VECS` と同じ範囲）。1/4 は `VECS` と同じ向きにして同点を作る。
            const theta = (br() * Math.PI) / 2;
            const exact = br() < 0.25 ? Math.floor(br() * vecs.length) : -1;
            await createOne(
              {
                tags: ["a", "b", "c"].filter(() => br() < 0.4),
                ready: true,
                subj: br() < 0.3,
                hl: [24, 24 * 30, 24 * 365][Math.floor(br() * 3)]!,
              },
              exact >= 0 ? vec(exact) : backend.vector([Math.cos(theta), Math.sin(theta)]),
            );
          }
          break;
        }
        case "recall": {
          const q = {
            vector: vec(op.v),
            limit: op.limit,
            overFetchFactor: op.off,
            association:
              op.assoc === 0
                ? null
                : op.assoc === 1
                  ? undefined
                  : { maxCount: 1, anchorCount: 2, minSimilarity: 0.3 },
            ...(op.budget ? { budget: { maxMemoryChars: op.budget } } : {}),
            ...(op.thr >= 0 ? { scoreThreshold: op.thr } : {}),
            ...(op.lex ? { channels: ["ann", "lexical"], text: "a b" } : {}),
          } as RecallQuery;
          const r = await (op.lex ? rtLex : rt).recall(ctx, q);
          lastRecall = r;
          trace.push(
            JSON.stringify({
              m: r.memories.map((x) => [x.memoryId, x.retrievedVia, x.score.total]),
              o: r.omitted,
              i: r.index,
            }),
          );
          await check(r, q, oi);
          if (runOpts.snapshot) {
            snapshots.push(
              JSON.stringify(
                await normalize({
                  memories: r.memories,
                  omitted: r.omitted,
                  index: r.index,
                }),
              ),
            );
          }
          break;
        }
        case "usage": {
          if (lastRecall && lastRecall.memories.length > 0) {
            const used = lastRecall.memories
              .filter((_, i) => (op.pick >> i) & 1)
              .map((m) => m.memoryId);
            if (used.length > 0) {
              await rt.observe(ctx, {
                kind: "memory_usage",
                recallId: lastRecall.recallId,
                usedMemoryIds: used,
              });
            }
          }
          break;
        }
        case "forget": {
          const id = nth(op.i);
          if (id) await rt.forget(ctx, { memoryId: id });
          break;
        }
        case "purge": {
          const id = nth(op.i);
          if (id) await rt.purge(ctx, { memoryId: id });
          break;
        }
        case "restore": {
          const id = nth(op.i);
          if (id) await rt.restoreArchived(ctx, { memoryId: id });
          break;
        }
        case "mark": {
          const a = nth(op.i);
          const b = nth(op.j);
          if (a && b && a !== b) await rt.markContested(ctx, a, b);
          break;
        }
        case "resolve": {
          const a = nth(op.i);
          if (a) {
            const m = await stores.memoryStore.get(ctx, a);
            if (m?.status === "contested" && m.contestedWithId) {
              await rt.resolveContested(
                ctx,
                a,
                m.contestedWithId,
                op.sup ? { kind: "supersede", winnerId: a } : { kind: "both_active" },
              );
            }
          }
          break;
        }
        case "consolidate": {
          const a = nth(op.i);
          const b = nth(op.j);
          if (a && b && a !== b) {
            const res = await rt.consolidate(ctx, { target: { memoryIds: [a, b] } });
            if (res.consolidatedMemoryId) allIds.push(res.consolidatedMemoryId);
          }
          break;
        }
        case "sweep":
          await rt.sweepArchive(ctx, { now: new Date(now), limit: 50 } as never);
          break;
        case "advance":
          now += op.hours * 3_600_000;
          break;
      }
    } catch (e) {
      violations.push({ inv: "EXCEPTION", detail: `${op.k}: ${(e as Error).message}`, op: oi });
    }
    now += step();
  }
  return { violations, trace, snapshots };
}

/** 違反の種類 `inv` が残る限り、操作を1つずつ抜いて短くする。 */
export async function minimize(
  backend: FuzzBackend,
  ops: readonly Op[],
  inv: string,
): Promise<Op[]> {
  let current = [...ops];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = current.length - 1; i >= 0; i--) {
      const candidate = current.filter((_, j) => j !== i);
      const { violations } = await runOps(backend, candidate);
      if (violations.some((x) => x.inv === inv)) {
        current = candidate;
        changed = true;
      }
    }
  }
  return current;
}

export interface FuzzSeedsOptions {
  seeds: number;
  len: number;
  /** 同じ操作列を2回流して trace を比べる（I9）。 */
  checkDeterminism: boolean;
  /** 1から数えたシードの始点（既定 1）。 */
  firstSeed?: number;
  /** 操作列の形（既定 `default`）。 */
  profile?: FuzzProfile;
}

/**
 * シードごとに操作列を流し、違反があれば最小化した操作列つきの報告を返す（空なら違反なし）。
 */
export async function fuzzSeeds(backend: FuzzBackend, opts: FuzzSeedsOptions): Promise<string> {
  const reports: string[] = [];
  const first = opts.firstSeed ?? 1;
  for (let seed = first; seed < first + opts.seeds; seed++) {
    const ops = genOps(seed, opts.len, opts.profile);
    const firstRun = await runOps(backend, ops);
    const violations = [...firstRun.violations];
    if (opts.checkDeterminism) {
      const second = await runOps(backend, ops);
      const k = firstRun.trace.findIndex((t, i) => t !== second.trace[i]);
      if (k !== -1 || firstRun.trace.length !== second.trace.length) {
        violations.push({
          inv: "I9-determinism",
          detail: `recall #${k} が2回の実行で食い違った`,
          op: -1,
        });
      }
    }
    if (violations.length === 0) continue;
    const v0 = violations[0]!;
    const minimal = v0.inv === "I9-determinism" ? ops : await minimize(backend, ops, v0.inv);
    reports.push(
      [
        `seed=${seed}${opts.profile === "wide" ? "（wide）" : ""} ${v0.inv}（op ${v0.op}）: ${v0.detail}`,
        `  ほかの違反: ${
          violations
            .slice(1)
            .map((x) => x.inv)
            .join(", ") || "なし"
        }`,
        `  最小化した操作列（${minimal.length} 操作）: ${JSON.stringify(minimal)}`,
      ].join("\n"),
    );
  }
  return reports.join("\n\n");
}

/** 1つの操作列の差分検査の結果。食い違いが無ければ `null`。 */
export interface BackendDiff {
  /** 何番目の recall で食い違ったか（0 始まり）。 */
  recall: number;
  /** 最初に食い違った場所（JSON のパス）。 */
  path: string;
  a: string;
  b: string;
}

/**
 * 数値は相対誤差 `1e-5` までを同じとみなす。pgvector はベクトルを float4 で持つので、
 * 類似度は Fake（float8）と下の桁で揺れる。
 */
function firstMismatch(a: unknown, b: unknown, path: string): string | null {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : path;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) {
      const m = firstMismatch(a[i], b[i], `${path}[${i}]`);
      if (m !== null) return m;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const m = firstMismatch(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
      if (m !== null) return m;
    }
    return null;
  }
  return a === b ? null : path;
}

export interface DiffOutcome {
  diff: BackendDiff | null;
  /** 突き合わせた recall の数（打ち切った recall より前のもの）。 */
  compared: number;
}

/**
 * 同じ操作列を2つの backend に流し、recall ごとの正規化した結果（`RunOutcome.snapshots`）を
 * 突き合わせる。最初に食い違った recall を返す。
 *
 * **どちらかに `lexical_truncated` が立った recall で、突き合わせを打ち切る。**語彙の窓は
 * `coverage` 降順・同値なら `rank` 降順で切るが、`rank` の尺度は adapter ごとに違う
 * （`LexicalHit.rank` の doc。Postgres は `ts_rank_cd`、Fake は出現回数）。窓が切れたとき、
 * 同じ `coverage` のどれが窓に入るかは約束の外であり、そこから先は使用報告の対象・強化・
 * 減衰を通じて状態そのものが分かれうる。
 *
 * **近似索引（HNSW）を通す backend には当てない。**窓が満杯でも近似索引は真の上位を
 * 取りこぼしうる（ADR 0193、`ann_unreached`）ので、同じ理由で食い違いが約束の内に入る。
 */
export async function diffBackends(
  a: FuzzBackend,
  b: FuzzBackend,
  ops: readonly Op[],
  jitterSeed: number,
): Promise<DiffOutcome> {
  const runOpts: RunOptions = { jitterSeed, diffVectors: true, snapshot: true };
  const ra = await runOps(a, ops, runOpts);
  const rb = await runOps(b, ops, runOpts);
  const n = Math.max(ra.snapshots.length, rb.snapshots.length);
  const lexicalTruncated = (x: unknown) =>
    (x as { omitted?: { kind: string }[] } | null)?.omitted?.some(
      (o) => o.kind === "lexical_truncated",
    ) ?? false;
  for (let i = 0; i < n; i++) {
    const sa = ra.snapshots[i] ?? "null";
    const sb = rb.snapshots[i] ?? "null";
    const ja = JSON.parse(sa) as unknown;
    const jb = JSON.parse(sb) as unknown;
    if (lexicalTruncated(ja) || lexicalTruncated(jb)) return { diff: null, compared: i };
    const path = firstMismatch(ja, jb, "$");
    if (path !== null) return { diff: { recall: i, path, a: sa, b: sb }, compared: i };
  }
  return { diff: null, compared: n };
}
