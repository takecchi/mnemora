import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { isMalformedIdentifierError } from "../identifier.js";
import type { NewMemory } from "../memory.js";
import type { NewObservation } from "../observation.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
let n = 0;

function observation(over: Partial<NewObservation> = {}): NewObservation {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    externalId: null,
    kind: "utterance",
    payload: {},
    ...over,
  } as NewObservation;
}

function memory(over: Partial<NewMemory> = {}): NewMemory {
  n += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `malformed-nul-${n}`,
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...over,
  };
}

type Port = (stores: ReturnType<typeof createFakeRuntimeStores>, value: string) => Promise<unknown>;

const ports: Array<[string, Port]> = [
  [
    "createObservation の input.subjectId",
    (s, v) => s.memoryStore.createObservation(ctx, observation({ subjectId: v })),
  ],
  [
    "createObservation の input.externalId",
    (s, v) => s.memoryStore.createObservation(ctx, observation({ externalId: v })),
  ],
  [
    "createObservationWithOutbox の input.subjectId",
    (s, v) => s.memoryStore.createObservationWithOutbox(ctx, observation({ subjectId: v }), []),
  ],
  [
    "createObservationWithOutbox の input.externalId",
    (s, v) => s.memoryStore.createObservationWithOutbox(ctx, observation({ externalId: v }), []),
  ],
  [
    "createMemory の input.subjectId",
    (s, v) => s.memoryStore.createMemory(ctx, memory({ subjectId: v })),
  ],
  [
    "createMemoryWithOutbox の input.subjectId",
    (s, v) => s.memoryStore.createMemoryWithOutbox(ctx, memory({ subjectId: v }), []),
  ],
];

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("reject するはずが、通った");
}

describe.each(ports)("FakeMemoryStore: %s の NUL（ADR 0563）", (_name, run) => {
  it("NUL を含むと MalformedIdentifierError（kind: malformed_identifier、reason: nul）で断り、message に入力値を載せない", async () => {
    const value = "id-\u0000-secret";
    const error = await rejection(run(createFakeRuntimeStores(), value));
    expect(isMalformedIdentifierError(error)).toBe(true);
    expect((error as { kind?: unknown }).kind).toBe("malformed_identifier");
    expect((error as { reason?: unknown }).reason).toBe("nul");
    expect((error as { index?: unknown }).index).toBe(3);
    expect(String((error as Error).message)).not.toContain("secret");
  });

  it("NUL を含むと、何も書かない", async () => {
    const stores = createFakeRuntimeStores();
    await rejection(run(stores, "id-\u0000"));
    const backing = (
      stores.memoryStore as unknown as {
        backing: {
          observations: Map<string, unknown>;
          memories: Map<string, unknown>;
          outboxJobs: unknown[];
        };
      }
    ).backing;
    expect(backing.observations.size).toBe(0);
    expect(backing.memories.size).toBe(0);
    expect(backing.outboxJobs.length).toBe(0);
  });

  it("対照: NUL の無い識別子は通る（NUL 以外の制御文字・対をなすサロゲートも）", async () => {
    for (const value of ["id-ok", "id-\u0001-\u001f", "id-\u{1F600}"]) {
      await expect(run(createFakeRuntimeStores(), value)).resolves.toBeDefined();
    }
  });

  it("対照: 孤立サロゲートは引き続き MalformedIdentifierError（reason: lone_surrogate）で断る", async () => {
    const error = await rejection(run(createFakeRuntimeStores(), "id-\uD800"));
    expect(isMalformedIdentifierError(error)).toBe(true);
    expect((error as { reason?: unknown }).reason).toBe("lone_surrogate");
  });
});

describe("FakeOutboxStore.fail は error の NUL を、6文字の \\u0000 に置き換えて lastError に残す（ADR 0563）", () => {
  async function seeded() {
    const stores = createFakeRuntimeStores();
    const { jobs } = await stores.memoryStore.createObservationWithOutbox(ctx, observation(), [
      "extract",
    ]);
    const job = jobs[0]!;
    return { stores, job };
  }
  const lastErrorAfter = (stores: ReturnType<typeof createFakeRuntimeStores>, jobId: string) =>
    stores.outboxStore.listJobs(ctx).find((j) => j.id === jobId)?.lastError;

  it("NUL は6文字の \\u0000 に置き換わり、元の文字列に NUL は残らない", async () => {
    const { stores, job } = await seeded();
    await stores.outboxStore.fail(ctx, job.id, "bad\u0000output\u0000", job.attempts);
    const lastError = lastErrorAfter(stores, job.id);
    expect(lastError).toBe("bad\\u0000output\\u0000");
    expect(lastError).not.toContain("\u0000");
    expect(lastError!.length).toBe("bad".length + 6 + "output".length + 6);
  });

  it("対照: NUL の無い error は変えない（NUL 以外の制御文字・バックスラッシュ入りの文字列も）", async () => {
    for (const error of [
      "plain failure",
      "ctrl\u0001\u001f\u007f",
      "literal \\u0000 text",
      "日本語\n改行",
    ]) {
      const { stores, job } = await seeded();
      await stores.outboxStore.fail(ctx, job.id, error, job.attempts);
      expect(lastErrorAfter(stores, job.id)).toBe(error);
    }
  });
});
