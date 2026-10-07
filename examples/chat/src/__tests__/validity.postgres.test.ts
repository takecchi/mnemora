import { afterAll, describe, expect, it } from "vitest";
import { createExampleRuntime } from "../runtime-factory.js";
import { formatValidityReport, runValidityArm } from "../validity-arm.js";
import type { ValidityProbeOutcome } from "../validity-arm.js";
import { VALIDITY_PROBES } from "../validity-probe-set.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

// provider は deterministic に固定する。ペアの2件は本文が同一で similarity が定数になり、測定は provider 層に依らない。
// MutableClock は使わない。動かす項は recordedAt ではなく validFrom/validUntil の明示的な Date。
// 書く経路は Runtime.observe() を通す。MemoryStore を直に叩かない。
// 以下の assert は実測の前に立てた予測。実測が違っても期待値を静かに書き換えて緑にしない（ADR 0058・0164）。
describe("examples/chat: validity arm（擬似 provider・本物の Postgres）", () => {
  it("2 probe の recall 結果（既定/過去のvalidAt/includeOutsideValidity）を実測する", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    try {
      expect(handle.llmMode).toBe("deterministic");
      expect(handle.embeddingMode).toBe("deterministic");

      const now = new Date();
      const report = await runValidityArm({
        armLabel: "validity-test",
        tenantIdPrefix: "validity-test",
        runtime: handle.runtime,
        memoryStore: handle.memoryStore,
        llmMode: handle.llmMode,
        embeddingMode: handle.embeddingMode,
        now,
      });

      console.log(formatValidityReport(report));

      const byId = new Map<string, ValidityProbeOutcome>(report.probes.map((p) => [p.probeId, p]));
      expect(byId.size).toBe(VALIDITY_PROBES.length);

      for (const probe of VALIDITY_PROBES) {
        const outcome = byId.get(probe.id)!;
        expect(outcome.current.returnedAtNow).toBe(true);
        expect(outcome.other.returnedAtNow).toBe(false);
        expect(outcome.omittedConditionsAtNow).toContain(probe.otherReason);
      }

      const address = byId.get("address")!;
      expect(address.historical).not.toBeNull();
      expect(address.historical!.currentReturned).toBe(false);
      expect(address.historical!.otherReturned).toBe(true);
      expect(address.historical!.omittedConditions).toContain("not_yet_valid");

      for (const probe of VALIDITY_PROBES) {
        const outcome = byId.get(probe.id)!;
        expect(outcome.optOut.currentReturned).toBe(true);
        expect(outcome.optOut.otherReturned).toBe(true);
      }
    } finally {
      await handle.close();
    }
  }, 60_000);
});

afterAll(async () => {
  await closeTestClient();
});
