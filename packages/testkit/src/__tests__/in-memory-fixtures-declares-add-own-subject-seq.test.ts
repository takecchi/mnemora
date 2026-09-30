import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

/**
 * [ADR 0394](../../../../docs/decisions/0394-activity-clock-writes-use-memorys-own-subject.md):
 * testkit の in-memory fixture は、`ReinforceOptions.addOwnSubjectSeq` を読めることを宣言する
 * （`MemoryStore.supportsAddOwnSubjectSeq?()` が `true`）。宣言が外れると、runtime は
 * 宣言の無い store 向けの値（`T + S_ctx`）を渡し、適合テストの歯も skip されて黙る。
 */
describe("InMemoryMemoryStore の supportsAddOwnSubjectSeq", () => {
  it("true を宣言している", () => {
    expect(new InMemoryMemoryStore().supportsAddOwnSubjectSeq?.()).toBe(true);
  });
});
