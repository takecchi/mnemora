import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import type { RecallQuery, RecallResult } from "../recall.js";
import { defaultDecayStrategy } from "../strategies/decay.js";

/**
 * recall の不変条件を、シードつきのランダムな操作列で検査する（Issue #1019・#1020・#1021 を
 * 見つけた検査器を、固定シードで回す形にしたもの）。Fake（`runtime-fakes.ts`）だけで完結する。
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
 * - I9 同じ操作列は同じ結果を返す（Fake の決定性。id の採番は実行ごとにモジュールを読み直して
 *   揃える）
 * - I10 件数の勘定。スコープ内の記憶を、返したもの（status が active/contested）と、スコープ内の
 *   Omission（`below_threshold`・`over_limit`・`budget_dropped`・`score_not_comparable`・
 *   `unit_assembly_dropped`・`filtered` のうち `scopeRelation: 'within_scope'`）の件数で数える。
 *   `not_indexed` はスコープ全体の集約から出す件数で、排他性の対象の外に置く（ADR 0203 追記9、
 *   Issue #1021）ので、この勘定には入れない。
 *   - 上限: 和 ≦ `totalInScope`。ADR 0203 の「1件の Memory は `omitted` の中で1回だけ数える」
 *     （追記3〜8）から導ける。
 *   - 下限: 件数がすべて `'exact'` で、件数を持たない札（`ann_truncated`・`ann_unreached`・
 *     `lexical_truncated`・段1の `stage_skipped`）が無いとき、和 ≧ `totalInScope` − `not_indexed`。
 *     `docs/recall.md` 冒頭の原則3（結果は、そこから漏れたものと必ず同時に提示する）から導ける。
 *
 * 落ちたときは、操作を1つずつ抜いて違反が残るかを見る形で操作列を最小化し、シードと最小の
 * 操作列を出力に出す。`RECALL_FUZZ_SEEDS`・`RECALL_FUZZ_LEN` で本数と長さを変えられる。
 */

const SEEDS = Number(process.env.RECALL_FUZZ_SEEDS ?? 40);
const LEN = Number(process.env.RECALL_FUZZ_LEN ?? 60);
const ctx: Ctx = { tenantId: "tenant-1" };
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

type Op =
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
  | { k: "usage"; pick: number }
  | { k: "forget"; i: number }
  | { k: "purge"; i: number }
  | { k: "restore"; i: number }
  | { k: "mark"; i: number; j: number }
  | { k: "resolve"; i: number; sup: boolean }
  | { k: "consolidate"; i: number; j: number }
  | { k: "sweep" }
  | { k: "advance"; hours: number };

const VECS = [
  [1, 0],
  [0.95, 0.31],
  [0.7, 0.71],
  [0.31, 0.95],
  [0, 1],
  [0.05, 0.9987],
];

function genOps(seed: number, n: number): Op[] {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const idx = () => Math.floor(r() * 1000);
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    const x = r();
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
        limit: 1 + Math.floor(r() * 4),
        off: 1 + Math.floor(r() * 3),
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

interface Violation {
  inv: string;
  detail: string;
  op: number;
}

interface RunOutcome {
  violations: Violation[];
  trace: string[];
}

async function run(ops: readonly Op[]): Promise<RunOutcome> {
  // I9: Fake の id はモジュール単位の続き番号で振られるので、実行ごとに読み直して揃える。
  vi.resetModules();
  const { createFakeRuntimeStores } = await import("./runtime-fakes.js");
  const { createRuntime } = await import("../runtime.js");

  let now = T0;
  const stores = createFakeRuntimeStores();
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
  let lastRecall: RecallResult | null = null;
  const violations: Violation[] = [];
  const trace: string[] = [];
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
    let notIndexed = 0;
    let allExact = true;
    for (const o of r.omitted) {
      switch (o.kind) {
        case "not_indexed":
          notIndexed += o.count;
          break;
        case "filtered":
          if (o.scopeRelation === "within_scope") counted += o.count;
          if (o.countKind !== "exact") allExact = false;
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
      `returned ${returnedInScope}, counted ${counted}, not_indexed ${notIndexed}, total ${r.index.totalInScope} :: ${JSON.stringify(r.omitted)}`;
    if (counted > r.index.totalInScope) v("I10-upper", summary());
    if (allExact && counted < r.index.totalInScope - notIndexed) v("I10-lower", summary());
  };

  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi]!;
    try {
      switch (op.k) {
        case "create": {
          const at = new Date(now);
          const n: NewMemory = {
            tenantId: "tenant-1",
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
          if (op.ready) {
            await stores.vectorStore.upsert(
              ctx,
              stores.embeddingProvider.space,
              m.id,
              op.zero ? [0, 0] : VECS[op.v]!,
            );
          }
          ids.push(m.id);
          break;
        }
        case "recall": {
          const q = {
            vector: VECS[op.v]!,
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
          if (a && b && a !== b) await rt.consolidate(ctx, { target: { memoryIds: [a, b] } });
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
  }
  return { violations, trace };
}

/** 違反の種類 `inv` が残る限り、操作を1つずつ抜いて短くする。 */
async function minimize(ops: readonly Op[], inv: string): Promise<Op[]> {
  let current = [...ops];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = current.length - 1; i >= 0; i--) {
      const candidate = current.filter((_, j) => j !== i);
      const { violations } = await run(candidate);
      if (violations.some((x) => x.inv === inv)) {
        current = candidate;
        changed = true;
      }
    }
  }
  return current;
}

describe("recall の不変条件（シードつきのランダムな操作列、Fake）", () => {
  it(`${SEEDS} シード × ${LEN} 操作で、I1〜I10 の違反が無い`, async () => {
    const reports: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const ops = genOps(seed, LEN);
      const first = await run(ops);
      const second = await run(ops);
      const violations = [...first.violations];
      const k = first.trace.findIndex((t, i) => t !== second.trace[i]);
      if (k !== -1 || first.trace.length !== second.trace.length) {
        violations.push({
          inv: "I9-determinism",
          detail: `recall #${k} が2回の実行で食い違った`,
          op: -1,
        });
      }
      if (violations.length === 0) continue;
      const v0 = violations[0]!;
      const minimal = v0.inv === "I9-determinism" ? ops : await minimize(ops, v0.inv);
      reports.push(
        [
          `seed=${seed} ${v0.inv}（op ${v0.op}）: ${v0.detail}`,
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
    expect(reports.join("\n\n")).toBe("");
  }, 600_000);
});
