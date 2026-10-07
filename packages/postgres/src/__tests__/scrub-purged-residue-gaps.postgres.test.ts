import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { isMalformedIdentifierError, type Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "scrub-purged-residue-gaps" };

interface Kit {
  store: InMemoryMemoryStore | PostgresMemoryStore;
  markPurgedAt: (id: string) => Promise<void>;
  setProposedCount: (name: string, count: number) => Promise<void>;
}

// v1.0.x の purge が残した状態は公開の口では作れないので、InMemory は内部の Map を、Postgres は SQL を直に書き換えて作る。
const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const store = new InMemoryMemoryStore();
      const internals = store as unknown as {
        memories: Map<string, { tenantId: string; purgedAt?: Date | null }>;
        labels: Map<string, { proposedCount: number }>;
        labelKey: (tenantId: string, name: string) => string;
      };
      return {
        store,
        markPurgedAt: async (id) => {
          internals.memories.get(id)!.purgedAt = new Date();
        },
        setProposedCount: async (name, count) => {
          internals.labels.get(internals.labelKey(ctx.tenantId, name))!.proposedCount = count;
        },
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return {
        store: new PostgresMemoryStore(db),
        markPurgedAt: async (id) => {
          await db.execute(sql`
            UPDATE memories SET purged_at = now()
            WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
          `);
        },
        setProposedCount: async (name, count) => {
          await db.execute(sql`
            UPDATE labels SET proposed_count = ${count}
            WHERE tenant_id = ${ctx.tenantId} AND name = ${name}
          `);
        },
      };
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe.each(KITS)("scrubPurged：適合テストが見ていない隅（%s）", (_name, make) => {
  it.each([
    ["tags だけ", { tags: ["only-tag"] }],
    ["attributes だけ", { attributes: { owner: "alice" } }],
    ["claim key だけ", { claimKey: { subject: "user", predicate: "home_city" } }],
  ])("残骸が %s の purge 済みの行も、その欄が消える", async (_label, residue) => {
    const { store, markPurgedAt } = await make();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "single-residue",
        status: "forgotten",
        ...residue,
      }),
    );
    await markPurgedAt(memory.id);

    await store.scrubPurged!(ctx, [memory.id]);

    const after = await store.get(ctx, memory.id);
    expect({ tags: after?.tags, attributes: after?.attributes, claimKey: after?.claimKey }).toEqual(
      { tags: [], attributes: {}, claimKey: null },
    );
  });

  it("purgedAt が立っていても forgotten でない行（active）は、id を渡されても触らない", async () => {
    const { store, markPurgedAt } = await make();
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "purged-at-but-active",
        status: "active",
        tags: ["keep-tag"],
        attributes: { owner: "alice" },
        claimKey: { subject: "user", predicate: "home_city" },
      }),
    );
    await markPurgedAt(memory.id);
    const before = await store.get(ctx, memory.id);

    await store.scrubPurged!(ctx, [memory.id]);

    expect(await store.get(ctx, memory.id)).toEqual(before);
  });

  it("登録済み（registered）の label は、紐付けを外しても proposedCount を動かさない", async () => {
    const { store, markPurgedAt } = await make();
    const legacy = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "registered-legacy",
        status: "forgotten",
        tags: ["registered-label"],
      }),
    );
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "registered-keep",
        tags: ["registered-label"],
      }),
    );
    await store.registerLabel!(ctx, "registered-label");
    await markPurgedAt(legacy.id);
    const readLabel = async () =>
      (await store.listLabels!(ctx)).find((l) => l.name === "registered-label");
    expect(await readLabel()).toMatchObject({ status: "registered", proposedCount: 2 });

    await store.scrubPurged!(ctx, [legacy.id]);

    expect(await readLabel()).toMatchObject({ status: "registered", proposedCount: 2 });
  });

  it("proposedCount は 0 を割らない（数え間違いで実際の紐付けより小さくなっていても、負にしない）", async () => {
    const { store, markPurgedAt, setProposedCount } = await make();
    const legacy = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "floor-legacy",
        status: "forgotten",
        tags: ["floor-label"],
      }),
    );
    await markPurgedAt(legacy.id);
    await setProposedCount("floor-label", 0);

    await store.scrubPurged!(ctx, [legacy.id]);

    const label = (await store.listLabels!(ctx)).find((l) => l.name === "floor-label");
    expect(label?.proposedCount).toBe(0);
  });

  it("形の壊れた ctx（NUL を含む tenantId）は MalformedIdentifierError で断る", async () => {
    const { store } = await make();
    const reason = await store.scrubPurged!({ tenantId: "bad\u0000tenant" }, [
      "00000000-0000-4000-8000-000000000001",
    ]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isMalformedIdentifierError(reason)).toBe(true);
  });
});

describe("scrubPurged：Postgres の claim key は2つの列（subject と predicate）で、片方だけの残骸も消える", () => {
  it.each([
    ["claim_key_subject だけ", sql`claim_key_subject = 'user', claim_key_predicate = NULL`],
    ["claim_key_predicate だけ", sql`claim_key_subject = NULL, claim_key_predicate = 'home_city'`],
  ])("残骸が %s の行", async (_label, assignment) => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const memory = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "partial-claim-key",
        status: "forgotten",
      }),
    );
    await db.execute(sql`
      UPDATE memories SET ${assignment}, purged_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${memory.id}
    `);

    await store.scrubPurged!(ctx, [memory.id]);

    const rows = await db.execute(sql`
      SELECT claim_key_subject, claim_key_predicate FROM memories
      WHERE tenant_id = ${ctx.tenantId} AND id = ${memory.id}
    `);
    expect(rows.rows[0]).toEqual({ claim_key_subject: null, claim_key_predicate: null });
  });
});
