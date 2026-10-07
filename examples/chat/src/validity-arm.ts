import type { Ctx, MemoryStore, RecallAssociationQuery, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { ProviderMode } from "./providers.js";
import { resolveExternalId } from "./provenance-trace.js";
import {
  VALIDITY_PROBES,
  buildValidityConversation,
  currentExternalId,
  historicalValidAt,
  otherExternalId,
} from "./validity-probe-set.js";
import type { ValidityProbe } from "./validity-probe-set.js";

/**
 * ペアの本文を厳密に同一にし（`time-term-arm.ts` と同じ設計）、`similarity` を構成上同じにする。書く経路は `Runtime.observe()` の `validFrom`/`validUntil` で、`MemoryStore` を直に叩かない。
 * probe ごとに別テナントを使う（`time-term-arm.ts` と同じ理由）。
 */

export interface ValidityMemberOutcome {
  returnedAtNow: boolean;
}

export interface ValidityHistoricalCheck {
  validAt: Date;
  currentReturned: boolean;
  otherReturned: boolean;
  omittedConditions: string[];
}

export interface ValidityOptOutCheck {
  currentReturned: boolean;
  otherReturned: boolean;
}

export interface ValidityProbeOutcome {
  probeId: string;
  otherReason: ValidityProbe["otherReason"];
  current: ValidityMemberOutcome;
  other: ValidityMemberOutcome;
  omittedConditionsAtNow: string[];
  historical: ValidityHistoricalCheck | null;
  optOut: ValidityOptOutCheck;
  totalInScope: number;
}

export interface ValidityArmReport {
  armLabel: string;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  now: Date;
  probes: ValidityProbeOutcome[];
}

export interface RunValidityArmOptions {
  armLabel: string;
  tenantIdPrefix: string;
  runtime: Runtime;
  memoryStore: MemoryStore;
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
  now?: Date;
  /** 省略時は `null`（この arm の基準線を変えない）。 */
  association?: RecallAssociationQuery | null;
}

async function memoryIdsByExternalId(
  memoryStore: MemoryStore,
  ctx: Ctx,
  memoryIds: string[],
): Promise<string[]> {
  return Promise.all(memoryIds.map((id) => resolveExternalId(memoryStore, ctx, id))).then(
    (resolved) => resolved.filter((id): id is string => id !== null),
  );
}

async function runOneProbe(
  probe: ValidityProbe,
  options: RunValidityArmOptions,
  now: Date,
): Promise<ValidityProbeOutcome> {
  const ctx: Ctx = { tenantId: `${options.tenantIdPrefix}-${probe.id}` };
  const utterances = buildValidityConversation(probe, now);

  let expectedEmbedJobs = 0;
  for (const utterance of utterances) {
    const observed = await options.runtime.observe(ctx, {
      kind: "utterance",
      text: utterance.text,
      externalId: utterance.externalId,
      ...(utterance.validFrom !== undefined ? { validFrom: utterance.validFrom } : {}),
      ...(utterance.validUntil !== undefined ? { validUntil: utterance.validUntil } : {}),
    });
    expectedEmbedJobs += observed.memoryIds.length;
  }

  await drainEmbedTicks(options.runtime, ctx, { expectedProcessed: expectedEmbedJobs });

  const currentId = currentExternalId(probe.id);
  const otherId = otherExternalId(probe.id);

  const association = options.association ?? null;
  const atNow = await options.runtime.recall(ctx, { text: probe.query, association });
  const atNowExternalIds = await memoryIdsByExternalId(
    options.memoryStore,
    ctx,
    atNow.memories.map((m) => m.memoryId),
  );
  const omittedConditionsAtNow = atNow.omitted
    .filter((o): o is Extract<typeof o, { kind: "filtered" }> => o.kind === "filtered")
    .map((o) => o.condition);

  let historical: ValidityHistoricalCheck | null = null;
  const validAt = historicalValidAt(probe, now);
  if (validAt !== undefined) {
    const atValidAt = await options.runtime.recall(ctx, {
      text: probe.query,
      validAt,
      association,
    });
    const atValidAtExternalIds = await memoryIdsByExternalId(
      options.memoryStore,
      ctx,
      atValidAt.memories.map((m) => m.memoryId),
    );
    historical = {
      validAt,
      currentReturned: atValidAtExternalIds.includes(currentId),
      otherReturned: atValidAtExternalIds.includes(otherId),
      omittedConditions: atValidAt.omitted
        .filter((o): o is Extract<typeof o, { kind: "filtered" }> => o.kind === "filtered")
        .map((o) => o.condition),
    };
  }

  const optOutResult = await options.runtime.recall(ctx, {
    text: probe.query,
    includeOutsideValidity: true,
    association,
  });
  const optOutExternalIds = await memoryIdsByExternalId(
    options.memoryStore,
    ctx,
    optOutResult.memories.map((m) => m.memoryId),
  );

  return {
    probeId: probe.id,
    otherReason: probe.otherReason,
    current: { returnedAtNow: atNowExternalIds.includes(currentId) },
    other: { returnedAtNow: atNowExternalIds.includes(otherId) },
    omittedConditionsAtNow,
    historical,
    optOut: {
      currentReturned: optOutExternalIds.includes(currentId),
      otherReturned: optOutExternalIds.includes(otherId),
    },
    totalInScope: atNow.index.totalInScope,
  };
}

export async function runValidityArm(options: RunValidityArmOptions): Promise<ValidityArmReport> {
  const now = options.now ?? new Date();
  const probes: ValidityProbeOutcome[] = [];
  for (const probe of VALIDITY_PROBES) {
    probes.push(await runOneProbe(probe, options, now));
  }
  return {
    armLabel: options.armLabel,
    llmMode: options.llmMode,
    embeddingMode: options.embeddingMode,
    now,
    probes,
  };
}

export function formatValidityReport(report: ValidityArmReport): string {
  const lines: string[] = [];
  lines.push(`=== validity arm ${report.armLabel} ===`);
  lines.push(`provider: llm=${report.llmMode} / embedding=${report.embeddingMode}`);
  lines.push(`now: ${report.now.toISOString()}`);
  for (const p of report.probes) {
    lines.push(`  - ${p.probeId} (otherReason=${p.otherReason}):`);
    lines.push(
      `      いま: current=${p.current.returnedAtNow ? "返った" : "返らない"} ` +
        `other=${p.other.returnedAtNow ? "返った" : "返らない"} ` +
        `omitted=[${p.omittedConditionsAtNow.join(",")}] totalInScope=${p.totalInScope}`,
    );
    if (p.historical) {
      lines.push(
        `      過去(validAt=${p.historical.validAt.toISOString()}): ` +
          `current=${p.historical.currentReturned ? "返った" : "返らない"} ` +
          `other=${p.historical.otherReturned ? "返った" : "返らない"} ` +
          `omitted=[${p.historical.omittedConditions.join(",")}]`,
      );
    }
    lines.push(
      `      includeOutsideValidity: current=${p.optOut.currentReturned ? "返った" : "返らない"} ` +
        `other=${p.optOut.otherReturned ? "返った" : "返らない"}`,
    );
  }
  return lines.join("\n");
}
