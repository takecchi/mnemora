import { describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

describe("runtime.sweepArchive — subject 単位カウンタの有無の解決", () => {
  it("'wall' のテナントでは、subject カウンタの有無を読まず、false を渡す", async () => {
    const { runtime, stores } = buildRuntime();
    const archiveDecayed = vi.spyOn(stores.memoryStore, "archiveDecayed");
    const hasCounters = vi.spyOn(stores.tenantSettingsStore, "hasSubjectActivityCounters");

    await runtime.sweepArchive(ctx, { now: NOW, limit: 10 });

    expect(hasCounters).not.toHaveBeenCalled();
    expect(archiveDecayed.mock.calls[0]?.[1].usesSubjectActivityCounters).toBe(false);
  });

  it("'activity' のテナントで opts.usesSubjectActivityCounters を明示すると、テナントの実態に関わらずそちらが渡る", async () => {
    const { runtime, stores } = buildRuntime();
    await stores.tenantSettingsStore.setDecayClock(ctx, "activity");
    expect(await stores.tenantSettingsStore.hasSubjectActivityCounters(ctx)).toBe(false);
    const archiveDecayed = vi.spyOn(stores.memoryStore, "archiveDecayed");
    const hasCounters = vi.spyOn(stores.tenantSettingsStore, "hasSubjectActivityCounters");

    await runtime.sweepArchive(ctx, { now: NOW, limit: 10, usesSubjectActivityCounters: true });

    expect(hasCounters).not.toHaveBeenCalled();
    expect(archiveDecayed.mock.calls[0]?.[1].usesSubjectActivityCounters).toBe(true);
  });
});
