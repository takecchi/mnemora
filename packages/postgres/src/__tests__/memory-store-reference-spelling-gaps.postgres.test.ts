import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const A: Ctx = { tenantId: "ref-spelling-gaps-a" };
const MISSING_UPPER = "00000000-0000-4000-8000-00000000ABCD";
const MISSING_LOWER = MISSING_UPPER.toLowerCase();
const NOT_A_UUID = "not-a-uuid";

const event = (memoryId: MemoryId): NewMemoryEvent =>
  ({
    tenantId: A.tenantId,
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    meta: {},
  }) as never;

afterAll(async () => {
  await closeTestClient();
});

describe("PostgresMemoryStore：参照の入口の検査の隅", () => {
  let mem: PostgresMemoryStore;
  const make = (name: string, over: Record<string, unknown> = {}) =>
    mem.createMemory(
      A,
      buildNewMemoryFixture({
        tenantId: A.tenantId,
        content: name,
        contentHash: `ref-spelling-${name}`,
        ...over,
      }),
    );

  beforeEach(async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    mem = new PostgresMemoryStore(db);
  });

  it("実在しない大文字の uuid は、message に小文字にそろえた id が載る（createMemory の3つの参照欄）", async () => {
    await expect(make("src", { sourceObservationId: MISSING_UPPER })).rejects.toThrow(
      `PostgresMemoryStore: observation not found for tenant: ${MISSING_LOWER}`,
    );
    await expect(
      make("sup", { status: "superseded", supersededById: MISSING_UPPER }),
    ).rejects.toThrow(`PostgresMemoryStore: memory not found for tenant: ${MISSING_LOWER}`);
    await expect(
      make("con", { status: "contested", contestedWithId: MISSING_UPPER }),
    ).rejects.toThrow(`PostgresMemoryStore: memory not found for tenant: ${MISSING_LOWER}`);
  });

  it("実在しない大文字の uuid は、message に小文字にそろえた id が載る（updateStatus・updateStatusWithEvent・recordUsage の recall）", async () => {
    const a1 = await make("a1");
    const recall = await mem.createRecall(A, {
      tenantId: A.tenantId,
      subjectId: null,
      query: { text: "q" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
      explain: { stages: [] },
      returnedMemories: [],
    } as never);

    await expect(
      mem.updateStatus(A, a1.id, "superseded", { supersededById: MISSING_UPPER }),
    ).rejects.toThrow(`PostgresMemoryStore: memory not found for tenant: ${MISSING_LOWER}`);
    await expect(
      mem.updateStatusWithEvent(
        A,
        a1.id,
        "superseded",
        { supersededById: MISSING_UPPER },
        event(a1.id),
      ),
    ).rejects.toThrow(`PostgresMemoryStore: memory not found for tenant: ${MISSING_LOWER}`);
    await expect(mem.recordUsage(A, MISSING_UPPER, [a1.id])).rejects.toThrow(
      `PostgresMemoryStore: recall not found for tenant: ${MISSING_LOWER}`,
    );
    expect(recall).toBeTruthy();
  });

  it("実在しない大文字の uuid は、message に小文字にそろえた id が載る（resolveContestedPair・resolveContestedGroup）", async () => {
    const [p1, p2] = [await make("p1"), await make("p2")];
    await mem.markContestedPair!(
      A,
      { id: p1.id, event: event(p1.id) },
      { id: p2.id, event: event(p2.id) },
    );
    await expect(
      mem.resolveContestedPair!(
        A,
        { id: p1.id, status: "superseded", supersededById: MISSING_UPPER, event: event(p1.id) },
        { id: p2.id, status: "active", event: event(p2.id) },
      ),
    ).rejects.toThrow(`PostgresMemoryStore: memory not found for tenant: ${MISSING_LOWER}`);

    const g = [await make("g1"), await make("g2"), await make("g3")];
    await mem.markContestedGroup!(
      A,
      g.map((m) => ({ id: m.id, event: event(m.id) })),
    );
    await expect(
      mem.resolveContestedGroup!(
        A,
        g.map((m, i) => ({
          id: m.id,
          status: i === 0 ? ("active" as const) : ("superseded" as const),
          ...(i === 0 ? {} : { supersededById: MISSING_UPPER }),
          event: event(m.id),
        })),
      ),
    ).rejects.toThrow(`PostgresMemoryStore: memory not found for tenant: ${MISSING_LOWER}`);
  });

  it("uuid でない supersededById は、updateStatusWithEvent・resolveContestedGroup でも DB へ投げる前に弾く", async () => {
    const a1 = await make("a1");
    await expect(
      mem.updateStatusWithEvent(
        A,
        a1.id,
        "superseded",
        { supersededById: NOT_A_UUID },
        event(a1.id),
      ),
    ).rejects.toThrow(`PostgresMemoryStore: memory not found for tenant: ${NOT_A_UUID}`);

    const g = [await make("g1"), await make("g2"), await make("g3")];
    await mem.markContestedGroup!(
      A,
      g.map((m) => ({ id: m.id, event: event(m.id) })),
    );
    await expect(
      mem.resolveContestedGroup!(
        A,
        g.map((m, i) => ({
          id: m.id,
          status: i === 0 ? ("active" as const) : ("superseded" as const),
          ...(i === 0 ? {} : { supersededById: NOT_A_UUID }),
          event: event(m.id),
        })),
      ),
    ).rejects.toThrow(`PostgresMemoryStore: memory not found for tenant: ${NOT_A_UUID}`);
    expect((await mem.get(A, g[1]!.id))?.status).toBe("contested");
  });
});

const KITS: Array<[string, () => Promise<InMemoryMemoryStore | PostgresMemoryStore>]> = [
  ["testkit の InMemory", async () => new InMemoryMemoryStore()],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresMemoryStore(db);
    },
  ],
];

describe.each(KITS)("createMemory：明示の null は「参照しない」（%s）", (_name, make) => {
  it("sourceObservationId・supersededById・contestedWithId に null を渡しても通る", async () => {
    const store = await make();

    const created = await store.createMemory(
      A,
      buildNewMemoryFixture({
        tenantId: A.tenantId,
        contentHash: "explicit-null-refs",
        sourceObservationId: null,
        supersededById: null,
        contestedWithId: null,
      }),
    );

    expect(created.sourceObservationId ?? null).toBeNull();
    expect(created.supersededById ?? null).toBeNull();
    expect(created.contestedWithId ?? null).toBeNull();
  });
});
