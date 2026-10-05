import { describe, expect, it } from "vitest";
import { MemorySchema, NewMemorySchema } from "../memory.js";
import { assertWellFormedNewMemory } from "../new-memory-check.js";
import type { NewMemory } from "../memory.js";
import { MALFORMED_NEW_MEMORY_CASES, WELL_FORMED_NEW_MEMORY_CASES } from "./malformed-new-memory-cases.js";

/** ADR 0630: 3つの実装が共有する検査関数（`assertWellFormedNewMemory`）そのものの歯。 */

const base = (over: Partial<NewMemory>): NewMemory => ({
  tenantId: "t",
  subjectId: null,
  sourceObservationId: "obs-1",
  extractorVersion: "v1",
  content: "本文",
  contentHash: "h",
  digest: "要旨",
  digestSource: "llm",
  provenance: { kind: "imported", batchId: "b" },
  tags: [],
  recordedAt: new Date("2026-01-01T00:00:00Z"),
  strength: 1,
  halfLifeHours: 720,
  decayFloorAt: new Date("2027-01-01T00:00:00Z"),
  embeddingStatus: "pending",
  ...over,
});

describe("assertWellFormedNewMemory", () => {
  it.each(MALFORMED_NEW_MEMORY_CASES.map((c) => [c.label, c] as const))(
    "%s は、owner と欄の名前を載せた Error で拒む",
    (_label, c) => {
      const input = base(c.over("obs-1"));
      expect(() => assertWellFormedNewMemory("Owner", input)).toThrow(c.field);
      expect(() => assertWellFormedNewMemory("Owner", input)).toThrow(/^Owner: /);
      expect(() => assertWellFormedNewMemory("Owner", input)).toThrow(Error);
    },
  );

  it.each(WELL_FORMED_NEW_MEMORY_CASES.map((c) => [c.label, c] as const))(
    "%s は通る",
    (_label, c) => {
      expect(() => assertWellFormedNewMemory("Owner", base(c.over("obs-1")))).not.toThrow();
    },
  );

  it("拒む形は、書いて読み戻した Memory が MemorySchema を通らない形と一致する（NewMemorySchema も通らない）", () => {
    for (const c of MALFORMED_NEW_MEMORY_CASES) {
      const input = base(c.over("obs-1"));
      expect(NewMemorySchema.safeParse(input).success, c.label).toBe(false);
    }
    for (const c of WELL_FORMED_NEW_MEMORY_CASES) {
      const input = base(c.over("obs-1"));
      expect(NewMemorySchema.safeParse(input).success, c.label).toBe(true);
      expect(
        MemorySchema.safeParse({
          ...input,
          id: "m",
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        }).success,
        c.label,
      ).toBe(true);
    }
  });

  it("範囲外の欄は見ない: subjectId の空文字・provenance.kind が列挙に無い・provenance が null・日時・tags の中身", () => {
    for (const over of [
      { subjectId: "" },
      { provenance: { kind: "bogus" } as never },
      { provenance: null as never },
      { tags: [1] as never },
      { occurredAt: new Date(Number.NaN) },
      { validFrom: new Date("2026-02-01"), validUntil: new Date("2026-01-01") },
    ] satisfies Array<Partial<NewMemory>>) {
      expect(() => assertWellFormedNewMemory("Owner", base(over))).not.toThrow();
    }
  });

  it("値そのものを message に載せない", () => {
    expect(() =>
      assertWellFormedNewMemory("Owner", base({ attributes: { secret: 12345678 } as never })),
    ).not.toThrow(/12345678/);
  });
});
