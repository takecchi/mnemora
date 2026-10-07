import { afterAll, describe, expect, it } from "vitest";
import {
  buildArmTenantId,
  formatArmDetail,
  newRunToken,
  runRetrievalQualityArm,
} from "../retrieval-quality.js";
import type { ArmIngestSummary } from "../retrieval-quality.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// 2回目を測る。同じ tenant の2回目は observe() の冪等性で新規 observation が0件になり、1回目だけを測る歯では欠陥が捕まらない（ADR 0068）。
// haystackSize は DEFAULT_TICK_LIMIT(50) を超える値にする。超えないと singleTickWouldHaveStalled の分岐が死ぬ。
const HAYSTACK_SIZE = 55;

async function runOnce(tenantId: string): Promise<ArmIngestSummary> {
  const handle = await createExampleRuntime(requireDatabaseUrl(), {
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "deterministic",
  });
  try {
    const report = await runRetrievalQualityArm({
      armLabel: "ingest-honesty-arm",
      tenantId,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackSize: HAYSTACK_SIZE,
    });
    return report.ingest;
  } finally {
    await handle.close();
  }
}

describe("retrieval-quality: ingest の結論は run を跨いで正直か（ADR 0068 ①）", () => {
  it(
    "①-1 通常利用の再現性: newRunToken() で毎回別テナントを使えば、2回目も1回目と " +
      "同じ ingest の結論になる（deep-equal）",
    async () => {
      await resetTestDatabase();
      await getTestClient();

      const armKey = "repro";
      const first = await runOnce(buildArmTenantId(armKey, newRunToken()));
      const second = await runOnce(buildArmTenantId(armKey, newRunToken()));

      expect(second).toEqual(first);
      expect(first.measurement).toBe("measured");
      expect(second.measurement).toBe("measured");
      expect(first.singleTickWouldHaveStalled).toBe(true);
      expect(second.singleTickWouldHaveStalled).toBe(true);
    },
  );

  it(
    "①-2 同じテナントを使い回したとき: 2回目は「1回で足りた」と主張しない " +
      "（measurement=replayed、singleTickWouldHaveStalled=null）",
    async () => {
      await resetTestDatabase();
      await getTestClient();

      const tenantId = "retrieval-quality-test-ingest-honesty-fixed";
      const first = await runOnce(tenantId);
      expect(first.measurement).toBe("measured");
      expect(first.singleTickWouldHaveStalled).toBe(true);
      expect(first.extractionCounts).toEqual({
        ok: HAYSTACK_SIZE + 14, // gold 7 + distractor 7 + haystack
        skipped: 0,
        llmFailedWholeObservation: 0,
      });

      const second = await runOnce(tenantId);
      expect(second.measurement).toBe("replayed");
      expect(second.singleTickWouldHaveStalled).toBeNull();
      expect(second.extractionCounts).toEqual({
        ok: 0,
        skipped: HAYSTACK_SIZE + 14,
        llmFailedWholeObservation: 0,
      });
    },
  );

  it(
    "①-3 表示層: formatArmDetail は、測っていない run で「1回で全件処理できる件数だった」" +
      "という趣旨の文字列を出さない",
    async () => {
      await resetTestDatabase();
      await getTestClient();

      const tenantId = "retrieval-quality-test-ingest-honesty-display";
      const firstReport = await runOnceReport(tenantId);
      const secondReport = await runOnceReport(tenantId);

      expect(secondReport.ingest.measurement).toBe("replayed");
      const out = formatArmDetail(secondReport);
      expect(out).not.toContain("この arm では既定の tick() 1回で全件処理できる件数だった");
      expect(out).toMatch(/測っていない/);

      const firstOut = formatArmDetail(firstReport);
      expect(firstOut).toContain("既定の tick() を1回だけ呼ぶ実装だったら");
    },
  );
});

async function runOnceReport(tenantId: string) {
  const handle = await createExampleRuntime(requireDatabaseUrl(), {
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "deterministic",
  });
  try {
    return await runRetrievalQualityArm({
      armLabel: "ingest-honesty-display-arm",
      tenantId,
      runtime: handle.runtime,
      memoryStore: handle.memoryStore,
      llmMode: handle.llmMode,
      embeddingMode: handle.embeddingMode,
      haystackSize: HAYSTACK_SIZE,
    });
  } finally {
    await handle.close();
  }
}

afterAll(async () => {
  await closeTestClient();
});
