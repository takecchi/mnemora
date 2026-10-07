import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { AttributesSchema } from "../attributes.js";
import type { Ctx } from "../ctx.js";
import {
  EventActorSchema,
  EventFilterSchema,
  MemoryEventSchema,
  NewMemoryEventSchema,
} from "../event.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { ExtractionContextSchema, ObserveInputSchema } from "../observation.js";
import { RecallAssociationQuerySchema, RecallBudgetSchema, RecallQuerySchema } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `EventFilterSchema.limit`・`EventActorSchema.id` は、schema が `limit: 0`・空文字の `id` を拒むが、store（ここでは core の Fake）は受け付ける。
 * schema と store の差を今のまま縛る。Postgres と testkit の fixture の側は `packages/postgres/src/__tests__/event-filter-actor-schema-vs-store.postgres.test.ts`。
 * `*-conformance.ts` には足していない。
 */

const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("AttributesSchema: キーの文字種と空のキー", () => {
  it.each([["a b"], ["a/b"], ["キー"], ["a\nb"], [""]])("キー %j は拒む", (key) => {
    expect(accepts(AttributesSchema, { [key]: "v" })).toBe(false);
  });

  it("許された文字（英数字・`_`・`.`・`:`・`-`）だけのキーは受け付ける", () => {
    expect(accepts(AttributesSchema, { "Aa0_.:-": "v" })).toBe(true);
  });
});

describe("ExtractionContextSchema: speaker と messages[].text の境界", () => {
  const withMessage = (message: Record<string, unknown>) => ({ messages: [message] });

  it.each([
    ["speaker が201字", { text: "a", speaker: "a".repeat(201) }],
    ["speaker が空文字", { text: "a", speaker: "" }],
    ["text が空文字", { text: "" }],
  ])("%s は拒む", (_label, message) => {
    expect(accepts(ExtractionContextSchema, withMessage(message))).toBe(false);
  });

  it("speaker が200字ちょうどなら受け付ける", () => {
    expect(
      accepts(ExtractionContextSchema, withMessage({ text: "a", speaker: "a".repeat(200) })),
    ).toBe(true);
  });
});

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

const ctx: Ctx = { tenantId: "tenant-1" };

describe("RecallQuery: text の空文字・overFetchFactor・channels", () => {
  it("recall(ctx, { text: '' }) は ZodError で reject する（RecallQuery.text の TSDoc）", async () => {
    const { runtime } = buildRuntime();

    await expect(runtime.recall(ctx, { text: "" })).rejects.toThrow(ZodError);
  });

  it.each([[Infinity], [-Infinity], [NaN], [0], [-1]])("overFetchFactor: %s は拒む", (value) => {
    expect(accepts(RecallQuerySchema, { text: "q", overFetchFactor: value })).toBe(false);
  });

  it("overFetchFactor は 1 未満の正数（0.01）も受け付ける（上限も下限の丸めも無い、TSDoc）", () => {
    expect(accepts(RecallQuerySchema, { text: "q", overFetchFactor: 0.01 })).toBe(true);
  });

  it("channels: [] は拒む", () => {
    expect(accepts(RecallQuerySchema, { text: "q", channels: [] })).toBe(false);
  });
});

describe("RecallBudgetSchema・RecallAssociationQuery.anchorCount: 正の整数", () => {
  it.each(["maxMemoryChars", "maxMemoryTokens", "promptBudgetTokens"])(
    "RecallBudget.%s は 0・負・非整数を拒み、正の整数は受け付ける",
    (key) => {
      expect({
        zero: accepts(RecallBudgetSchema, { [key]: 0 }),
        negative: accepts(RecallBudgetSchema, { [key]: -1 }),
        fraction: accepts(RecallBudgetSchema, { [key]: 1.5 }),
        positive: accepts(RecallBudgetSchema, { [key]: 1 }),
      }).toEqual({ zero: false, negative: false, fraction: false, positive: true });
    },
  );

  it("anchorCount は 0・非整数を拒み、正の整数は受け付ける", () => {
    expect({
      zero: accepts(RecallAssociationQuerySchema, { maxCount: 1, anchorCount: 0 }),
      fraction: accepts(RecallAssociationQuerySchema, { maxCount: 1, anchorCount: 1.5 }),
      positive: accepts(RecallAssociationQuerySchema, { maxCount: 1, anchorCount: 1 }),
    }).toEqual({ zero: false, fraction: false, positive: true });
  });
});

describe("ClaimKeyOptions: observe の入力で limit と語彙の要素を検査する", () => {
  const utterance = (claimKey: Record<string, unknown>) => ({
    kind: "utterance" as const,
    text: "発話",
    claimKey: { enabled: true, ...claimKey },
  });

  it.each([
    ["knownPredicatesFromStore.limit: 0", { knownPredicatesFromStore: { limit: 0 } }],
    ["knownPredicatesFromStore.limit: -1", { knownPredicatesFromStore: { limit: -1 } }],
    ["knownPredicatesFromStore.limit: 1.5", { knownPredicatesFromStore: { limit: 1.5 } }],
    ["knownPredicates: ['']", { knownPredicates: [""] }],
    ["knownSubjects: ['']", { knownSubjects: [""] }],
  ])("%s は observe が ZodError で reject し、何も書かない", async (_label, claimKey) => {
    const { runtime, stores } = buildRuntime();

    await expect(runtime.observe(ctx, utterance(claimKey) as never)).rejects.toThrow(ZodError);

    const backing = (
      stores.memoryStore as unknown as { backing: { observations: Map<string, unknown> } }
    ).backing;
    expect(backing.observations.size).toBe(0);
  });

  it("knownPredicatesFromStore: {}（limit 省略）と正の整数の limit は受け付ける", () => {
    expect([
      accepts(ObserveInputSchema, utterance({ knownPredicatesFromStore: {} })),
      accepts(ObserveInputSchema, utterance({ knownPredicatesFromStore: { limit: 3 } })),
    ]).toEqual([true, true]);
  });
});

describe("MemoryEventSchema・NewMemoryEventSchema: events_purged なら memoryId は null", () => {
  const base = {
    tenantId: "t",
    actor: { type: "system" as const },
    meta: {},
  };

  it("events_purged で memoryId が非 null なら拒み、null なら受け付ける（ほかの kind は非 null でよい）", () => {
    const stored = { ...base, id: "e1", at: new Date() };
    expect({
      storedPurgedWithId: accepts(MemoryEventSchema, {
        ...stored,
        kind: "events_purged",
        memoryId: "m1",
      }),
      storedPurgedNull: accepts(MemoryEventSchema, {
        ...stored,
        kind: "events_purged",
        memoryId: null,
      }),
      storedCreatedWithId: accepts(MemoryEventSchema, {
        ...stored,
        kind: "created",
        memoryId: "m1",
      }),
      newPurgedWithId: accepts(NewMemoryEventSchema, {
        ...base,
        kind: "events_purged",
        memoryId: "m1",
      }),
      newPurgedNull: accepts(NewMemoryEventSchema, {
        ...base,
        kind: "events_purged",
        memoryId: null,
      }),
    }).toEqual({
      storedPurgedWithId: false,
      storedPurgedNull: true,
      storedCreatedWithId: true,
      newPurgedWithId: false,
      newPurgedNull: true,
    });
  });
});

describe("EventFilterSchema.limit・EventActorSchema.id: schema は store より厳しい（今の振る舞い）", () => {
  it("schema は limit: 0 と空文字の id を拒むが、core の Fake の store は受け付ける", async () => {
    const { stores } = buildRuntime();

    const appended = await stores.eventStore.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "events_purged",
      actor: { type: "human", id: "" },
      meta: {},
    });
    const listed = await stores.eventStore.list(ctx, { limit: 0 });

    expect({
      filterSchemaLimit0: accepts(EventFilterSchema, { limit: 0 }),
      filterSchemaLimit1: accepts(EventFilterSchema, { limit: 1 }),
      actorSchemaEmptyId: accepts(EventActorSchema, { type: "human", id: "" }),
      actorSchemaNoId: accepts(EventActorSchema, { type: "human" }),
      storeAppendedActor: appended.actor,
      storeListedWithLimit0: listed.length,
    }).toEqual({
      filterSchemaLimit0: false,
      filterSchemaLimit1: true,
      actorSchemaEmptyId: false,
      actorSchemaNoId: true,
      storeAppendedActor: { type: "human", id: "" },
      storeListedWithLimit0: 0,
    });
  });
});
