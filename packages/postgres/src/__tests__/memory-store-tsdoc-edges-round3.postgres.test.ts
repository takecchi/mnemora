import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, NewMemory } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `MemoryStore` の TSDoc が約束していて、どのテストも縛っていなかった振る舞いを、`PostgresMemoryStore` について
 * 縛る（3回目の棚卸し）。振る舞いは変えていない。同じ本文の歯を testkit の fixture
 * （`packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts`）と core の Fake
 * （`packages/core/src/__tests__/fake-memory-store-tsdoc-edges-round3.test.ts`）にも置いている。
 *
 * - `findActiveByClaimKey`: claim key の `subject` が違えば返さない／有効期間は半開区間（接するだけでは重ならない）／
 *   `subjectId` の NULL と非 NULL は一致しない／claim key を正規化しない／`active` 以外は返さない／形の崩れた
 *   `excludeMemoryId` でも投げない。
 * - `listActiveClaimPredicates`: `limit: 0` は空／`active` 以外は対象にしない／`subjectId` の NULL と非 NULL は
 *   一致しない。
 * - `listLabels`: ラベルの行は消えず、`proposedCount` も減らない。`registerLabel`: 空白だけの名前もそのまま
 *   `registered` の行になる。
 * - `aggregateScope` の `axis: 'taxonomy'`: 0件のラベル・0件の残差は群を作らない／`taxonomyGroupCandidates: []` は
 *   残差だけ、`undefined` は taxonomy の群を作らない。
 *
 * このファイルの末尾に、Postgres だけの約束（`registerLabel` の孤立サロゲート・長すぎる名前）も置いている。
 *
 * `*-conformance.ts` には足していない（適合試験を厳しくすると、第三者の adapter を落としうるため）。
 */

const IMPL = "PostgresMemoryStore";

async function makeStore(): Promise<MemoryStore> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  return new PostgresMemoryStore(db);
}

afterAll(async () => {
  await closeTestClient();
});

const ctx: Ctx = { tenantId: "tsdoc-promises-round3" };
let hashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${hashCounter}`,
    contentHash: `tsdoc-round3-${hashCounter}`,
    digest: `要旨 ${hashCounter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "tsdoc-round3" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
    ...overrides,
  };
}

/** status を渡された値にした Memory を作る。`contested` は対向が要るので、無関係の対向を1件作る（ADR 0140）。 */
async function memoryWithStatus(
  store: MemoryStore,
  status: "contested" | "superseded" | "forgotten",
  overrides: Partial<NewMemory>,
) {
  const companion = status === "contested" ? await store.createMemory(ctx, newMemory()) : undefined;
  return store.createMemory(
    ctx,
    newMemory({ ...overrides, status, contestedWithId: companion?.id }),
  );
}

const CLAIM_KEY = { subject: "user", predicate: "address" };

function claimQuery(overrides: Record<string, unknown> = {}) {
  return {
    subjectId: "u1" as string | null,
    claimKey: CLAIM_KEY,
    excludeMemoryId: "00000000-0000-4000-8000-000000000000",
    contentHash: "the-new-claim",
    validFrom: null as Date | null,
    validUntil: null as Date | null,
    ...overrides,
  };
}

describe(`${IMPL}.findActiveByClaimKey: 一致の条件の細部`, () => {
  it("claim key の subject だけが違っても返さない", async () => {
    const store = await makeStore();
    await store.createMemory(ctx, newMemory({ subjectId: "u1", claimKey: CLAIM_KEY }));

    const found = await store.findActiveByClaimKey!(
      ctx,
      claimQuery({ claimKey: { subject: "spouse", predicate: "address" } }),
    );

    expect(found).toEqual([]);
  });

  it("有効期間は半開区間——接するだけの区間は重ならない（両方の向き）", async () => {
    const store = await makeStore();
    await store.createMemory(
      ctx,
      newMemory({
        subjectId: "u1",
        claimKey: CLAIM_KEY,
        validFrom: new Date("2021-01-01T00:00:00.000Z"),
        validUntil: new Date("2022-01-01T00:00:00.000Z"),
      }),
    );

    const before = await store.findActiveByClaimKey!(
      ctx,
      claimQuery({
        validFrom: new Date("2020-01-01T00:00:00.000Z"),
        validUntil: new Date("2021-01-01T00:00:00.000Z"),
      }),
    );
    const after = await store.findActiveByClaimKey!(
      ctx,
      claimQuery({ validFrom: new Date("2022-01-01T00:00:00.000Z"), validUntil: null }),
    );
    const overlapping = await store.findActiveByClaimKey!(
      ctx,
      claimQuery({
        validFrom: new Date("2021-12-31T23:59:59.999Z"),
        validUntil: null,
      }),
    );

    expect({
      before: before.length,
      after: after.length,
      overlapping: overlapping.length,
    }).toEqual({ before: 0, after: 0, overlapping: 1 });
  });

  it("subjectId の NULL と非 NULL は一致しない（どちらの向きでも）", async () => {
    const store = await makeStore();
    await store.createMemory(ctx, newMemory({ subjectId: "u1", claimKey: CLAIM_KEY }));
    await store.createMemory(ctx, newMemory({ subjectId: null, claimKey: CLAIM_KEY }));

    const forNull = await store.findActiveByClaimKey!(ctx, claimQuery({ subjectId: null }));
    const forU1 = await store.findActiveByClaimKey!(ctx, claimQuery({ subjectId: "u1" }));

    expect({
      forNull: forNull.map((m) => m.subjectId),
      forU1: forU1.map((m) => m.subjectId),
    }).toEqual({ forNull: [null], forU1: ["u1"] });
  });

  it("claim key を正規化しない——大文字小文字だけが違う値は一致しない", async () => {
    const store = await makeStore();
    await store.createMemory(ctx, newMemory({ subjectId: "u1", claimKey: CLAIM_KEY }));

    const subjectCase = await store.findActiveByClaimKey!(
      ctx,
      claimQuery({ claimKey: { subject: "User", predicate: "address" } }),
    );
    const predicateCase = await store.findActiveByClaimKey!(
      ctx,
      claimQuery({ claimKey: { subject: "user", predicate: "Address" } }),
    );

    expect({ subjectCase, predicateCase }).toEqual({ subjectCase: [], predicateCase: [] });
  });

  it.each(["contested", "superseded", "forgotten"] as const)(
    "status が %s の行は返さない",
    async (status) => {
      const store = await makeStore();
      await memoryWithStatus(store, status, { subjectId: "u1", claimKey: CLAIM_KEY });

      expect(await store.findActiveByClaimKey!(ctx, claimQuery())).toEqual([]);
    },
  );

  it("excludeMemoryId の形が崩れていても投げず、どの行も除かない", async () => {
    const store = await makeStore();
    const other = await store.createMemory(
      ctx,
      newMemory({ subjectId: "u1", claimKey: CLAIM_KEY }),
    );

    const found = await store.findActiveByClaimKey!(
      ctx,
      claimQuery({ excludeMemoryId: "not-a-uuid" }),
    );

    expect(found.map((m) => m.id)).toEqual([other.id]);
  });
});

describe(`${IMPL}.listActiveClaimPredicates: limit・status・subjectId の細部`, () => {
  it("limit: 0 なら空配列", async () => {
    const store = await makeStore();
    await store.createMemory(ctx, newMemory({ subjectId: "u1", claimKey: CLAIM_KEY }));

    expect(await store.listActiveClaimPredicates!(ctx, { subjectId: "u1", limit: 0 })).toEqual([]);
  });

  it.each(["contested", "superseded", "forgotten"] as const)(
    "status が %s の行は対象にしない",
    async (status) => {
      const store = await makeStore();
      await memoryWithStatus(store, status, { subjectId: "u1", claimKey: CLAIM_KEY });

      expect(await store.listActiveClaimPredicates!(ctx, { subjectId: "u1", limit: 10 })).toEqual(
        [],
      );
    },
  );

  it("subjectId の NULL と非 NULL は一致しない（どちらの向きでも）", async () => {
    const store = await makeStore();
    await store.createMemory(
      ctx,
      newMemory({ subjectId: "u1", claimKey: { subject: "user", predicate: "only_u1" } }),
    );
    await store.createMemory(
      ctx,
      newMemory({ subjectId: null, claimKey: { subject: "user", predicate: "only_null" } }),
    );

    expect({
      forNull: await store.listActiveClaimPredicates!(ctx, { subjectId: null, limit: 10 }),
      forU1: await store.listActiveClaimPredicates!(ctx, { subjectId: "u1", limit: 10 }),
    }).toEqual({ forNull: ["only_null"], forU1: ["only_u1"] });
  });
});

describe(`${IMPL}.listLabels / registerLabel: 行は消えず、名前は検査しない`, () => {
  it("tags にその名前を持つ Memory が forgotten・archived・superseded になっても、行は残り proposedCount も減らない", async () => {
    const store = await makeStore();
    const memories = [
      await store.createMemory(ctx, newMemory({ tags: ["kept"] })),
      await store.createMemory(ctx, newMemory({ tags: ["kept"] })),
      await store.createMemory(ctx, newMemory({ tags: ["kept"] })),
    ];
    const before = (await store.listLabels!(ctx)).find((l) => l.name === "kept");

    await store.updateStatus(ctx, memories[0]!.id, "forgotten");
    await store.updateStatus(ctx, memories[1]!.id, "archived");
    await store.updateStatus(ctx, memories[2]!.id, "superseded");

    const after = (await store.listLabels!(ctx)).find((l) => l.name === "kept");
    expect({ before, after }).toEqual({
      before: { name: "kept", status: "proposed", proposedCount: 3, registeredAt: null },
      after: { name: "kept", status: "proposed", proposedCount: 3, registeredAt: null },
    });
  });

  it("空白だけの名前もそのまま registered の行になる（正規化しない）", async () => {
    const store = await makeStore();

    const registered = await store.registerLabel!(ctx, "  ");

    expect({
      returned: [registered.name, registered.status, registered.registeredAt instanceof Date],
      listed: (await store.listLabels!(ctx)).map((l) => [l.name, l.status]),
    }).toEqual({ returned: ["  ", "registered", true], listed: [["  ", "registered"]] });
  });
});

describe(`${IMPL}.aggregateScope の axis: 'taxonomy': 0件の群は載せず、空配列は「残差だけ」`, () => {
  it("候補に在っても0件のラベルは群を作らない", async () => {
    const store = await makeStore();
    await store.createMemory(ctx, newMemory({ tags: ["alpha"] }));

    const aggregate = await store.aggregateScope(ctx, {
      taxonomyGroupCandidates: ["alpha", "never-used"],
    });

    expect(aggregate.groups.filter((g) => g.axis === "taxonomy").map((g) => g.key)).toEqual([
      "alpha",
    ]);
  });

  it("残差が0件なら key: null の群を載せない", async () => {
    const store = await makeStore();
    await store.createMemory(ctx, newMemory({ tags: ["alpha"] }));
    await store.createMemory(ctx, newMemory({ tags: ["beta"] }));

    const aggregate = await store.aggregateScope(ctx, {
      taxonomyGroupCandidates: ["alpha", "beta"],
    });

    expect(
      aggregate.groups
        .filter((g) => g.axis === "taxonomy")
        .map((g) => g.key)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  it("空配列は残差（key: null）だけ、undefined は taxonomy の群を1つも作らない", async () => {
    const store = await makeStore();
    await store.createMemory(ctx, newMemory({ tags: ["alpha"] }));
    await store.createMemory(ctx, newMemory({ tags: [] }));

    const empty = await store.aggregateScope(ctx, { taxonomyGroupCandidates: [] });
    const omitted = await store.aggregateScope(ctx, {});

    const taxonomy = (groups: typeof empty.groups) =>
      groups.filter((g) => g.axis === "taxonomy").map((g) => [g.key, g.count]);
    expect({ empty: taxonomy(empty.groups), omitted: taxonomy(omitted.groups) }).toEqual({
      empty: [[null, 2]],
      omitted: [],
    });
  });
});

describe("PostgresMemoryStore.registerLabel: Postgres だけの約束（MemoryStore.registerLabel? の TSDoc）", () => {
  it("孤立サロゲートは U+FFFD に置き換わって registered の行になる", async () => {
    const store = await makeStore();

    const registered = await store.registerLabel!(ctx, "lone\uD800label");

    expect({
      returned: registered.name,
      listed: (await store.listLabels!(ctx)).map((l) => l.name),
    }).toEqual({ returned: "lone�label", listed: ["lone�label"] });
  });

  it("索引の1行の上限を超える長い名前は例外になり、行を作らない", async () => {
    const store = await makeStore();

    // 同じ字の繰り返しは Postgres が圧縮して索引の上限に届かないので、圧縮の効きにくい名前にする。
    const longName = Array.from({ length: 10_000 }, (_, i) =>
      String.fromCharCode(0x4e00 + ((i * 7919) % 20_000)),
    ).join("");

    await expect(store.registerLabel!(ctx, longName)).rejects.toThrow();

    expect(await store.listLabels!(ctx)).toEqual([]);
  });
});
