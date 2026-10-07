import type { Ctx, RecallResult, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";

export const SCOPE_DEMO_ALICE_SUBJECT_ID = "alice";
export const SCOPE_DEMO_BOB_SUBJECT_ID = "bob";

export const ALICE_FACT = "私が飼っているペットは犬のポチです。";
export const BOB_FACT = "私が飼っているペットは猫のタマです。";

export const SCOPE_DEMO_QUERY = "わたしが飼っているペットは何ですか?";

const ALICE_EXTERNAL_ID = "scope-demo-alice-pet-fact";
const BOB_EXTERNAL_ID = "scope-demo-bob-pet-fact";

export interface ScopeDemoResult {
  tenantId: string;
  otherTenantId: string;
  aliceOnly: RecallResult;
  tenantWide: RecallResult;
  otherTenant: RecallResult;
}

function digestsInclude(memories: { digest: string }[], marker: string): boolean {
  return memories.some((m) => m.digest.includes(marker));
}

export interface ScopeDemoCheck {
  aliceOnlyHasAlice: boolean;
  aliceOnlyExcludesBob: boolean;
  tenantWideHasAlice: boolean;
  tenantWideHasBob: boolean;
  otherTenantIsEmpty: boolean;
}

export function checkScopeDemo(result: ScopeDemoResult): ScopeDemoCheck {
  return {
    aliceOnlyHasAlice: digestsInclude(result.aliceOnly.memories, "ポチ"),
    aliceOnlyExcludesBob: !digestsInclude(result.aliceOnly.memories, "タマ"),
    tenantWideHasAlice: digestsInclude(result.tenantWide.memories, "ポチ"),
    tenantWideHasBob: digestsInclude(result.tenantWide.memories, "タマ"),
    otherTenantIsEmpty: result.otherTenant.memories.length === 0,
  };
}

export async function runScopeDemo(
  runtime: Runtime,
  tenantId: string,
  otherTenantId: string,
): Promise<ScopeDemoResult> {
  const aliceCtx: Ctx = { tenantId, subjectId: SCOPE_DEMO_ALICE_SUBJECT_ID };
  const bobCtx: Ctx = { tenantId, subjectId: SCOPE_DEMO_BOB_SUBJECT_ID };
  const tenantCtx: Ctx = { tenantId };
  const otherTenantCtx: Ctx = { tenantId: otherTenantId };

  const aliceObserved = await runtime.observe(aliceCtx, {
    kind: "utterance",
    text: ALICE_FACT,
    speaker: "user",
    externalId: ALICE_EXTERNAL_ID,
  });
  const bobObserved = await runtime.observe(bobCtx, {
    kind: "utterance",
    text: BOB_FACT,
    speaker: "user",
    externalId: BOB_EXTERNAL_ID,
  });
  // outbox の claimBatch はテナント単位で subjectId では絞らない。tenantId だけの ctx で1回干上がらせれば alice・bob 両方の embed ジョブが処理される。
  await drainEmbedTicks(runtime, tenantCtx, {
    expectedProcessed: aliceObserved.memoryIds.length + bobObserved.memoryIds.length,
  });

  const aliceOnly = await runtime.recall(aliceCtx, { text: SCOPE_DEMO_QUERY });
  const tenantWide = await runtime.recall(tenantCtx, { text: SCOPE_DEMO_QUERY });
  const otherTenant = await runtime.recall(otherTenantCtx, { text: SCOPE_DEMO_QUERY });

  return { tenantId, otherTenantId, aliceOnly, tenantWide, otherTenant };
}

function formatMemoryList(memories: { digest: string }[]): string {
  if (memories.length === 0) {
    return "  (0件)";
  }
  return memories.map((m) => `  - "${m.digest}"`).join("\n");
}

export function formatScopeDemo(result: ScopeDemoResult): string {
  const check = checkScopeDemo(result);
  const lines: string[] = [];

  lines.push(`tenantId      = ${result.tenantId}`);
  lines.push(`otherTenantId = ${result.otherTenantId}`);
  lines.push("");

  lines.push('--- 1. { tenantId, subjectId: "alice" } で recall ---');
  lines.push(`件数: ${result.aliceOnly.memories.length}`);
  lines.push(formatMemoryList(result.aliceOnly.memories));
  lines.push(
    `⟹ alice の記憶が含まれる: ${check.aliceOnlyHasAlice ? "はい" : "いいえ"} / ` +
      `bob の記憶が含まれない: ${check.aliceOnlyExcludesBob ? "はい" : "いいえ"}`,
  );
  lines.push("");

  lines.push("--- 2. { tenantId }（subjectId 省略）で recall ---");
  lines.push(`件数: ${result.tenantWide.memories.length}`);
  lines.push(formatMemoryList(result.tenantWide.memories));
  lines.push(
    `⟹ alice の記憶が含まれる: ${check.tenantWideHasAlice ? "はい" : "いいえ"} / ` +
      `bob の記憶が含まれる: ${check.tenantWideHasBob ? "はい" : "いいえ"}`,
  );
  lines.push("");

  lines.push("--- 3. { tenantId: otherTenantId }（別テナント）で recall ---");
  lines.push(`件数: ${result.otherTenant.memories.length}`);
  lines.push(formatMemoryList(result.otherTenant.memories));
  lines.push(
    `⟹ 0件である（tenantId の記憶が一切現れない）: ${check.otherTenantIsEmpty ? "はい" : "いいえ"}`,
  );

  return lines.join("\n");
}
