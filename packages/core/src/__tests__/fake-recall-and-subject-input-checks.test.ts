import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { isMalformedIdentifierError } from "../identifier.js";
import type { NewRecallRecord } from "../recall.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const claimKey = { subject: "s", predicate: "p" } as never;

function recall(overrides: Partial<NewRecallRecord> = {}): NewRecallRecord {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    query: { text: "banana" },
    budget: null,
    omitted: [],
    usage: {},
    indexBand: {},
    explain: { stages: [] },
    returnedMemories: [],
    ...overrides,
  } as unknown as NewRecallRecord;
}

function claimQuery(subjectId: string | null) {
  return {
    subjectId,
    claimKey,
    excludeMemoryId: "mem-x",
    contentHash: "h",
    validFrom: null,
    validUntil: null,
  };
}

describe("ADR 0506: createRecall が Postgres の書けない入力を断る", () => {
  const malformed: Array<[string, Partial<NewRecallRecord>]> = [
    ["subjectId の NUL", { subjectId: "a\u0000b" }],
    ["subjectId の孤立サロゲート", { subjectId: "a\ud800" }],
    [
      "advanceActivityClock.subjectId の NUL",
      { advanceActivityClock: { scope: "subject", subjectId: "a\u0000" } },
    ],
    [
      "advanceActivityClock.subjectId の孤立サロゲート",
      { advanceActivityClock: { scope: "subject", subjectId: "a\udc00" } },
    ],
  ];
  for (const [label, overrides] of malformed) {
    it(`${label}は MalformedIdentifierError で断り、何も書かず活動時計も進めない`, async () => {
      const { memoryStore, tenantSettingsStore } = createFakeRuntimeStores();
      let caught: unknown;
      try {
        await memoryStore.createRecall(ctx, recall(overrides));
      } catch (error) {
        caught = error;
      }
      expect(isMalformedIdentifierError(caught)).toBe(true);
      expect(await memoryStore.getRecall(ctx, "rcl-1")).toBeNull();
      expect(await tenantSettingsStore.getActivitySeq?.(ctx)).toBe(0);
    });
  }

  const nulFields: Array<[string, Partial<NewRecallRecord>, RegExp]> = [
    ["query の値", { query: { q: "a\u0000" } }, /query must not contain NUL/],
    ["query のキー", { query: { "a\u0000": 1 } }, /query must not contain NUL/],
    ["budget", { budget: { maxTokens: "a\u0000" } as never }, /budget must not contain NUL/],
    ["omitted", { omitted: ["a\u0000"] as never }, /omitted must not contain NUL/],
    ["usage", { usage: { a: "\u0000" } as never }, /usage must not contain NUL/],
    ["indexBand", { indexBand: { a: "\u0000" } as never }, /indexBand must not contain NUL/],
    ["explain", { explain: { a: "\u0000" } as never }, /explain must not contain NUL/],
    [
      "returnedMemories",
      { returnedMemories: ["\u0000"] as never },
      /returnedMemories must not contain NUL/,
    ],
  ];
  for (const [label, overrides, pattern] of nulFields) {
    it(`${label}の NUL を断る`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      await expect(memoryStore.createRecall(ctx, recall(overrides))).rejects.toThrow(pattern);
    });
  }

  const notJson: Array<[string, Partial<NewRecallRecord>]> = [
    ["query: undefined", { query: undefined }],
    ["omitted: undefined", { omitted: undefined as never }],
    ["usage: undefined", { usage: undefined as never }],
    ["indexBand: undefined", { indexBand: undefined as never }],
    ["explain: undefined", { explain: undefined as never }],
    ["returnedMemories: undefined", { returnedMemories: undefined as never }],
    ["query: 関数", { query: () => 1 }],
  ];
  for (const [label, overrides] of notJson) {
    it(`NOT NULL の jsonb 欄が JSON にならない値（${label}）を断る`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      await expect(memoryStore.createRecall(ctx, recall(overrides))).rejects.toThrow(
        /must be JSON-serializable/,
      );
    });
  }

  it("BigInt と循環参照は JSON.stringify の TypeError で断る", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await expect(memoryStore.createRecall(ctx, recall({ query: 1n }))).rejects.toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(memoryStore.createRecall(ctx, recall({ query: cyclic }))).rejects.toThrow(
      TypeError,
    );
  });

  it("対照: 妥当な値は通り、活動時計も進む（budget: undefined/null・絵文字の subjectId・対のサロゲート・Date・NaN）", async () => {
    const { memoryStore, tenantSettingsStore } = createFakeRuntimeStores();
    await memoryStore.createRecall(ctx, recall({ budget: undefined }));
    await memoryStore.createRecall(ctx, recall({ budget: null, query: null }));
    await memoryStore.createRecall(
      ctx,
      recall({
        subjectId: "S\u{1F600}😀",
        query: { at: new Date("2026-01-01T00:00:00Z"), n: Number.NaN, text: "\\u0000" },
        advanceActivityClock: true,
      }),
    );
    await memoryStore.createRecall(
      ctx,
      recall({ advanceActivityClock: { scope: "subject", subjectId: "Sub-\u{1F600}" } }),
    );
    expect(await tenantSettingsStore.getActivitySeq?.(ctx)).toBe(1);
    expect(await tenantSettingsStore.getSubjectActivitySeqs?.(ctx, ["Sub-\u{1F600}"])).toEqual({
      "Sub-\u{1F600}": 1,
    });
  });
});

describe("ADR 0506: subjectId を取る読み口が、読む前に断る", () => {
  const badSubjects: Array<[string, string]> = [
    ["NUL", "a\u0000"],
    ["孤立サロゲート", "a\ud800"],
  ];
  for (const [label, subjectId] of badSubjects) {
    it(`findActiveByClaimKey・findContestedByClaimKey・listActiveClaimPredicates の query.subjectId の${label}`, async () => {
      const { memoryStore } = createFakeRuntimeStores();
      for (const call of [
        () => memoryStore.findActiveByClaimKey(ctx, claimQuery(subjectId)),
        () => memoryStore.findContestedByClaimKey?.(ctx, claimQuery(subjectId)),
        () => memoryStore.listActiveClaimPredicates?.(ctx, { subjectId, limit: 1 }),
      ]) {
        let caught: unknown;
        try {
          await call();
        } catch (error) {
          caught = error;
        }
        expect(isMalformedIdentifierError(caught)).toBe(true);
      }
    });
    it(`getSubjectActivitySeqs の subjectIds の要素の${label}`, async () => {
      const { tenantSettingsStore } = createFakeRuntimeStores();
      let caught: unknown;
      try {
        await tenantSettingsStore.getSubjectActivitySeqs?.(ctx, ["ok", subjectId]);
      } catch (error) {
        caught = error;
      }
      expect(isMalformedIdentifierError(caught)).toBe(true);
    });
  }

  it("対照: 絵文字・大文字・null の subjectId は通る", async () => {
    const { memoryStore, tenantSettingsStore } = createFakeRuntimeStores();
    for (const subjectId of ["S\u{1F600}", "SUBJECT-UPPER", "x".repeat(5000), null]) {
      expect(await memoryStore.findActiveByClaimKey(ctx, claimQuery(subjectId))).toEqual([]);
      expect(await memoryStore.findContestedByClaimKey?.(ctx, claimQuery(subjectId))).toEqual([]);
      expect(await memoryStore.listActiveClaimPredicates?.(ctx, { subjectId, limit: 1 })).toEqual(
        [],
      );
    }
    expect(await tenantSettingsStore.getSubjectActivitySeqs?.(ctx, ["S\u{1F600}", "UP"])).toEqual(
      {},
    );
  });
});

describe("ADR 0506: ctx の検査（代表の口）と、本物が通す ctx", () => {
  it("tenantId の NUL・孤立サロゲート、subjectId の NUL は全 store の代表の口で断る", async () => {
    const s = createFakeRuntimeStores();
    const space = { provider: "p", model: "m", dimensions: 3 };
    for (const bad of [
      { tenantId: "a\u0000b" },
      { tenantId: "a\ud800" },
      { tenantId: "t", subjectId: "a\u0000" },
    ] as Ctx[]) {
      for (const call of [
        () => s.memoryStore.get(bad, "x"),
        () => s.memoryStore.createRecall(bad, recall()),
        () => s.vectorStore.search(bad, space, [1, 0, 0], { limit: 1, filter: { tenantId: "t" } }),
        () => s.lexicalStore.search(bad, "a", { limit: 1, filter: { tenantId: "t" } }),
        () => s.eventStore.list(bad, {}),
        () =>
          s.outboxStore.claimBatch(bad, {
            limit: 1,
            leaseMs: 1000,
            claimedBy: "w",
            now: new Date(),
          }),
        () => s.tenantSettingsStore.getSubjectActivitySeqs?.(bad, []),
        () => s.relationStore.listRelated(bad, "x"),
      ]) {
        let caught: unknown;
        try {
          await call();
        } catch (error) {
          caught = error;
        }
        expect(isMalformedIdentifierError(caught)).toBe(true);
      }
    }
  });

  it("対照（やりすぎの歯）: 大文字・長い・絵文字・対のサロゲート・空の tenantId は通る（本物が通す）", async () => {
    const s = createFakeRuntimeStores();
    const space = { provider: "p", model: "m", dimensions: 3 };
    for (const tenantId of ["TENANT-ABC", "x".repeat(5000), "t\u{1F600}", "t😀", ""]) {
      const c: Ctx = { tenantId, subjectId: "Sub\u{1F600}" };
      expect(await s.memoryStore.get(c, "x")).toBeNull();
      expect(
        await s.vectorStore.search(c, space, [1, 0, 0], { limit: 1, filter: { tenantId } }),
      ).toEqual([]);
      expect(await s.lexicalStore.search(c, "a", { limit: 1, filter: { tenantId } })).toEqual([]);
      expect(await s.eventStore.list(c, {})).toEqual([]);
      expect(await s.relationStore.listRelated(c, "x")).toEqual([]);
      expect(typeof (await s.memoryStore.createRecall(c, recall({ tenantId })))).toBe("string");
    }
  });
});
