import type { Ctx } from "@mnemora/core";
import { DEFAULT_SCORE_THRESHOLD, type TimeWeightingPolicy } from "@mnemora/core";
import { clockPastRecentDbWrites, drainEmbedTicks } from "./embed-drain.js";
import {
  DIAGNOSTIC_SCORE_THRESHOLD,
  diagnosticOf,
  diagnosticRecallLimit,
  rankOf,
  type LongHorizonRuntimeHandle,
} from "./long-horizon-bench.js";
import {
  LONG_HORIZON_CHECKPOINT_DAYS,
  LONG_HORIZON_DAYS,
  LONG_HORIZON_FACTS,
  LONG_HORIZON_FILLERS_PER_DAY,
  buildLongHorizonMemorySeeds,
  checkpointTime,
  type LongHorizonFact,
  type LongHorizonFactClass,
  type LongHorizonMemoryRole,
  type LongHorizonMemorySeed,
} from "./long-horizon-case-set.js";
import { classifyGoldOutcome, type GoldOutcomeKind } from "./long-horizon-outcome.js";

/**
 * 段階2: 段階1と同じ時間軸の文を、記憶として直接書かずに発話として `observe()` へ流し、抽出 LLM に何を記憶にするかを決めさせる。
 * 使用報告なしの2方針（段階1の arm A / C）だけを測る: 使用報告ありの arm は方針ごとにテナントが分かれ、抽出をやり直すことになるため。
 */
export const LONG_HORIZON_E2E_ARMS = ["A", "C"] as const;
export type LongHorizonE2EArm = (typeof LONG_HORIZON_E2E_ARMS)[number];
const E2E_ARM_POLICY: Record<LongHorizonE2EArm, TimeWeightingPolicy> = {
  A: "legacy",
  C: "eventAwareFreshness",
};

/** 段階1の分類に「その発話から記憶が1件も抽出されなかった」を足したもの。 */
export type E2EOutcomeKind = GoldOutcomeKind | "not_extracted";

export interface E2EProbeRecord {
  arm: LongHorizonE2EArm;
  checkpointDay: number;
  factId: string;
  factClass: LongHorizonFactClass;
  role: "gold" | "superseded";
  outcome: E2EOutcomeKind;
  extractedCount: number;
  returnedRank: number | null;
  diagnosticRank: number | null;
  similarity: number | null;
  total: number | null;
}

export interface E2EExtractionRecord {
  localId: string;
  role: LongHorizonMemoryRole;
  utterance: string;
  extracted: string[];
}

export interface LongHorizonE2EReport {
  days: number;
  fillersPerDay: number;
  checkpointDays: readonly number[];
  utterancesObserved: number;
  memoriesByRole: Record<LongHorizonMemoryRole, { utterances: number; memories: number }>;
  memoriesAtCheckpoint: { day: number; memories: number }[];
  /** 事実に関わる発話（gold・古い側・distractor）だけ、抽出された本文を残す。雑談は件数だけ。 */
  factExtractions: E2EExtractionRecord[];
  probes: E2EProbeRecord[];
  observeMillis: number;
}

export interface LongHorizonE2EOptions {
  facts?: readonly LongHorizonFact[];
  days?: number;
  fillersPerDay?: number;
  checkpointDays?: readonly number[];
  tenantPrefix: string;
  log?: (line: string) => void;
}

/**
 * 段階1の gold の文には、記憶として書くための三人称（「この人の」）が1件だけ混じっている。利用者の発話としては不自然なので落とす。
 * 段階1の文面は変えない（段階1の結果を動かさないため）。
 */
export function utteranceOf(seed: LongHorizonMemorySeed): string {
  return seed.content.replace(/^この人の/, "");
}

const OBSERVE_ATTEMPTS = 3;

async function observeWithRetry(
  handle: LongHorizonRuntimeHandle,
  ctx: Ctx,
  seed: LongHorizonMemorySeed,
): Promise<readonly string[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const observed = await handle.runtime.observe(ctx, {
        kind: "utterance",
        text: utteranceOf(seed),
        speaker: "user",
        externalId: seed.localId,
      });
      return observed.memoryIds;
    } catch (err) {
      if (attempt >= OBSERVE_ATTEMPTS) {
        throw err;
      }
      // 一時的な API エラー（429 など）だけを想定した短い待ち。`externalId` で重複排除されるので、送り直しても二重に書かれない。
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
}

export async function runLongHorizonE2E(
  handle: LongHorizonRuntimeHandle,
  options: LongHorizonE2EOptions,
): Promise<LongHorizonE2EReport> {
  const facts = options.facts ?? LONG_HORIZON_FACTS;
  const days = options.days ?? LONG_HORIZON_DAYS;
  const fillersPerDay = options.fillersPerDay ?? LONG_HORIZON_FILLERS_PER_DAY;
  const checkpointDays = (options.checkpointDays ?? LONG_HORIZON_CHECKPOINT_DAYS).filter(
    (d) => d <= days,
  );
  const log = options.log ?? (() => {});
  const seeds = buildLongHorizonMemorySeeds(facts, days, fillersPerDay);
  const ctx: Ctx = { tenantId: `${options.tenantPrefix}-e2e` };

  const memoryIdsByLocalId = new Map<string, readonly string[]>();
  const allMemoryIds = new Set<string>();
  const memoriesByRole: LongHorizonE2EReport["memoriesByRole"] = {
    gold: { utterances: 0, memories: 0 },
    superseded: { utterances: 0, memories: 0 },
    distractor: { utterances: 0, memories: 0 },
    filler: { utterances: 0, memories: 0 },
  };
  const factSeeds: LongHorizonMemorySeed[] = [];
  const probes: E2EProbeRecord[] = [];
  const memoriesAtCheckpoint: { day: number; memories: number }[] = [];
  let observeMillis = 0;
  let cursor = 0;

  for (const day of checkpointDays) {
    const at = checkpointTime(day);
    let pendingEmbeds = 0;
    while (cursor < seeds.length && seeds[cursor]!.recordedAt.getTime() <= at.getTime()) {
      const seed = seeds[cursor]!;
      handle.clock.set(seed.recordedAt);
      const started = Date.now();
      const ids = await observeWithRetry(handle, ctx, seed);
      observeMillis += Date.now() - started;
      memoryIdsByLocalId.set(seed.localId, ids);
      for (const id of ids) {
        if (!allMemoryIds.has(id)) {
          allMemoryIds.add(id);
          pendingEmbeds += 1;
        }
      }
      memoriesByRole[seed.role].utterances += 1;
      memoriesByRole[seed.role].memories += ids.length;
      if (seed.role !== "filler") {
        factSeeds.push(seed);
      }
      cursor += 1;
      if (cursor % 100 === 0) {
        log(
          `[long-horizon-e2e] observed=${String(cursor)}/${String(seeds.length)} memories=${String(allMemoryIds.size)} ` +
            `avg=${String(Math.round(observeMillis / cursor))}ms`,
        );
      }
    }
    // 埋め込みの claim は実時刻で進める（段階1の `writeSeeds` と同じ）。
    handle.clock.set(clockPastRecentDbWrites());
    await drainEmbedTicks(handle.runtime, ctx, {
      expectedProcessed: pendingEmbeds,
      waitForClockToAdvance: false,
    });
    handle.clock.set(at);
    memoriesAtCheckpoint.push({ day, memories: allMemoryIds.size });
    log(`[long-horizon-e2e] day=${String(day)} memories=${String(allMemoryIds.size)}`);

    for (const arm of LONG_HORIZON_E2E_ARMS) {
      const policy = E2E_ARM_POLICY[arm];
      for (const fact of facts) {
        const recall = await handle.runtime.recall(ctx, {
          text: fact.question,
          timeWeighting: policy,
        });
        const diagnosticRecall = await handle.runtime.recall(ctx, {
          text: fact.question,
          timeWeighting: policy,
          scoreThreshold: DIAGNOSTIC_SCORE_THRESHOLD,
          includeFullyDecayed: true,
          limit: diagnosticRecallLimit(allMemoryIds.size),
          association: null,
        });
        const roles: ("gold" | "superseded")[] =
          fact.factClass === "correction" ? ["gold", "superseded"] : ["gold"];
        for (const role of roles) {
          const ids = memoryIdsByLocalId.get(`${fact.id}:${role}`);
          if (ids === undefined) {
            continue;
          }
          probes.push(
            await probeOne(handle, ctx, {
              arm,
              day,
              at,
              fact,
              role,
              ids,
              recall,
              diagnosticRecall,
            }),
          );
        }
      }
    }
  }

  const factExtractions: E2EExtractionRecord[] = [];
  for (const seed of factSeeds) {
    const extracted: string[] = [];
    for (const id of memoryIdsByLocalId.get(seed.localId) ?? []) {
      const memory = await handle.memoryStore.get(ctx, id);
      extracted.push(memory?.content ?? "(読めなかった)");
    }
    factExtractions.push({
      localId: seed.localId,
      role: seed.role,
      utterance: utteranceOf(seed),
      extracted,
    });
  }

  return {
    days,
    fillersPerDay,
    checkpointDays,
    utterancesObserved: cursor,
    memoriesByRole,
    memoriesAtCheckpoint,
    factExtractions,
    probes,
    observeMillis,
  };
}

async function probeOne(
  handle: LongHorizonRuntimeHandle,
  ctx: Ctx,
  p: {
    arm: LongHorizonE2EArm;
    day: number;
    at: Date;
    fact: LongHorizonFact;
    role: "gold" | "superseded";
    ids: readonly string[];
    recall: Parameters<typeof rankOf>[0];
    diagnosticRecall: Parameters<typeof diagnosticOf>[0];
  },
): Promise<E2EProbeRecord> {
  const base = {
    arm: p.arm,
    checkpointDay: p.day,
    factId: p.fact.id,
    factClass: p.fact.factClass,
    role: p.role,
    extractedCount: p.ids.length,
  };
  if (p.ids.length === 0) {
    return {
      ...base,
      outcome: "not_extracted",
      returnedRank: null,
      diagnosticRank: null,
      similarity: null,
      total: null,
    };
  }
  // 1つの発話から複数の記憶が抽出されることがある。そのうち一番よく届いたものでこの事実の結果とする。
  let best: { id: string; returned: number | null; diag: ReturnType<typeof diagnosticOf> } | null =
    null;
  for (const id of p.ids) {
    const returned = rankOf(p.recall, id)?.rank ?? null;
    const diag = diagnosticOf(p.diagnosticRecall, id);
    const candidate = { id, returned, diag };
    if (best === null || betterThan(candidate, best)) {
      best = candidate;
    }
  }
  const memory = await handle.memoryStore.get(ctx, best!.id);
  if (memory === null) {
    throw new Error(`runLongHorizonE2E: 抽出されたはずの記憶 "${best!.id}" を読めなかった。`);
  }
  return {
    ...base,
    outcome: classifyGoldOutcome({
      returnedRank: best!.returned,
      diagnosticTotal: best!.diag?.total ?? null,
      decayFloorAt: memory.decayFloorAt,
      probeAt: p.at,
      scoreThreshold: DEFAULT_SCORE_THRESHOLD,
    }),
    returnedRank: best!.returned,
    diagnosticRank: best!.diag?.rank ?? null,
    similarity: best!.diag?.similarity ?? null,
    total: best!.diag?.total ?? null,
  };
}

function betterThan(
  a: { returned: number | null; diag: { rank: number } | null },
  b: { returned: number | null; diag: { rank: number } | null },
): boolean {
  if (a.returned !== null || b.returned !== null) {
    return (a.returned ?? Infinity) < (b.returned ?? Infinity);
  }
  return (a.diag?.rank ?? Infinity) < (b.diag?.rank ?? Infinity);
}

const CLASS_LABEL: Record<LongHorizonFactClass, string> = {
  habitual: "常用",
  dormant: "休眠",
  correction: "訂正",
};
const OUTCOME_SHORT: Record<E2EOutcomeKind, string> = {
  returned: "ok",
  outranked: "out",
  below_threshold: "thr",
  decayed: "dec",
  not_reached: "nr",
  not_extracted: "nx",
};

/** 種類 × arm × 時点ごとに「返った件数/全件」と、返らなかったものの内訳。 */
export function formatLongHorizonE2EReport(report: LongHorizonE2EReport): string {
  const lines: string[] = [];
  lines.push(
    `発話 ${String(report.utterancesObserved)} 件を observe()（抽出の平均 ${String(Math.round(report.observeMillis / Math.max(1, report.utterancesObserved)))}ms/件）`,
  );
  lines.push("");
  lines.push("| 発話の種類 | 発話 | 抽出された記憶 |");
  lines.push("|---|---|---|");
  for (const [role, v] of Object.entries(report.memoriesByRole)) {
    lines.push(`| ${role} | ${String(v.utterances)} | ${String(v.memories)} |`);
  }
  lines.push("");
  lines.push(
    `時点ごとの記憶の総数: ${report.memoriesAtCheckpoint.map((m) => `${String(m.day)}日=${String(m.memories)}`).join(" / ")}`,
  );
  lines.push("");
  lines.push(
    `gold が既定の recall() に返った件数/全件（${Object.entries(OUTCOME_SHORT)
      .map(([k, v]) => `${v}=${k}`)
      .join(", ")}）`,
  );
  lines.push("");
  lines.push(`| 種類 | arm | ${report.checkpointDays.map((d) => `${String(d)}日`).join(" | ")} |`);
  lines.push(`|---|---|${report.checkpointDays.map(() => "---").join("|")}|`);
  for (const factClass of ["habitual", "dormant", "correction"] as const) {
    for (const arm of LONG_HORIZON_E2E_ARMS) {
      const cells = report.checkpointDays.map((day) => {
        const ps = report.probes.filter(
          (p) =>
            p.arm === arm &&
            p.checkpointDay === day &&
            p.factClass === factClass &&
            p.role === "gold",
        );
        if (ps.length === 0) {
          return "—";
        }
        const ok = ps.filter((p) => p.outcome === "returned").length;
        const misses = new Map<string, number>();
        for (const p of ps) {
          if (p.outcome !== "returned") {
            misses.set(OUTCOME_SHORT[p.outcome], (misses.get(OUTCOME_SHORT[p.outcome]) ?? 0) + 1);
          }
        }
        const detail = [...misses].map(([k, n]) => `${k}${String(n)}`).join(" ");
        return `${String(ok)}/${String(ps.length)}${detail ? ` ${detail}` : ""}`;
      });
      lines.push(`| ${CLASS_LABEL[factClass]} | ${arm} | ${cells.join(" | ")} |`);
    }
  }
  lines.push("");
  lines.push(
    "診断順位（gold・arm A）の中央値: " +
      report.checkpointDays
        .map((day) => {
          const ranks = report.probes
            .filter(
              (p) =>
                p.arm === "A" &&
                p.checkpointDay === day &&
                p.role === "gold" &&
                p.diagnosticRank !== null,
            )
            .map((p) => p.diagnosticRank!)
            .sort((a, b) => a - b);
          return `${String(day)}日=${ranks.length === 0 ? "—" : String(ranks[Math.floor(ranks.length / 2)])}`;
        })
        .join(" / "),
  );
  lines.push("");
  lines.push("事実の発話から抽出された記憶:");
  for (const e of report.factExtractions) {
    lines.push(`- [${e.role}] ${e.utterance}`);
    lines.push(
      e.extracted.length === 0
        ? "    → (抽出なし)"
        : e.extracted.map((c) => `    → ${c}`).join("\n"),
    );
  }
  return lines.join("\n");
}
