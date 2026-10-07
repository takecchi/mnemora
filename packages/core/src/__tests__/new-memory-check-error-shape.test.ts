import { describe, expect, it } from "vitest";
import { assertWellFormedNewMemory } from "../new-memory-check.js";
import type { NewMemory } from "../memory.js";
import { MALFORMED_NEW_MEMORY_CASES } from "./malformed-new-memory-cases.js";

// 例外は素の `Error`（`TypeError` でも型付きの新クラスでもない。ADR 0630 決定4）。値は message に載せない。
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

function thrown(input: NewMemory): Error {
  try {
    assertWellFormedNewMemory("Owner", input);
  } catch (e) {
    return e as Error;
  }
  throw new Error("拒まれなかった");
}

describe("assertWellFormedNewMemory の例外の形（ADR 0630 決定4）", () => {
  it.each(MALFORMED_NEW_MEMORY_CASES.map((c) => [c.label, c] as const))(
    "%s: 素の Error で、決まった文面",
    (_label, c) => {
      const error = thrown(base(c.over("obs-1")));
      expect(error.constructor).toBe(Error);
      expect(error.message).toMatch(
        /^Owner: [A-Za-z.0-9]+ is malformed \(.+\); the stored Memory would not pass MemorySchema when read back$/,
      );
    },
  );

  it("拒んだ値そのものは message に載せない", () => {
    const secrets: Array<[string, Partial<NewMemory>]> = [
      ["SECRET_SUBJECT_VALUE", { claimKey: { subject: "SECRET_SUBJECT_VALUE", predicate: "" } }],
      ["987654321", { attributes: { k: 987654321 } as never }],
      ["SECRET_NESTED_VALUE", { attributes: { k: { n: "SECRET_NESTED_VALUE" } } as never }],
      [
        "SECRET_BATCH",
        {
          provenance: {
            kind: "imported",
            batchId: "",
            note: "SECRET_BATCH",
          } as never,
        },
      ],
    ];
    for (const [secret, over] of secrets) {
      const error = thrown(base(over));
      expect(error.message, secret).not.toContain(secret);
    }
  });
});
