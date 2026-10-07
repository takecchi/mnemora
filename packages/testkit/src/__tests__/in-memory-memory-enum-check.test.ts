import { describe, expect, it } from "vitest";
import type { Ctx, NewMemory, NewMemoryEvent } from "@mnemora/core";
import {
  DigestSourceSchema,
  EmbeddingStatusSchema,
  MemoryStatusConflictError,
  MemoryStatusSchema,
  ProvenanceKindSchema,
} from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { assertStorableMemoryColumn } from "../__fixtures__/memory-enum-check.js";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";

const ctx: Ctx = { tenantId: "memory-enum-check" };

const BOGUS = "bogus" as never;

function event(memoryId: string): NewMemoryEvent {
  return { tenantId: ctx.tenantId, memoryId, kind: "updated", actor: { type: "system" }, meta: {} };
}

function build() {
  const memoryStore = new InMemoryMemoryStore();
  const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
  return { memoryStore, eventStore };
}

describe("testkit の fixture は memories の列挙の列に無い値を拒む", () => {
  const createCases: Array<[string, Partial<NewMemory>, RegExp]> = [
    [
      "status",
      { status: BOGUS },
      /^memories\.status must be one of active, superseded, contested, archived, forgotten \(got "bogus"\)$/,
    ],
    [
      "digestSource",
      { digestSource: BOGUS },
      /^memories\.digest_source must be one of llm, fallback \(got "bogus"\)$/,
    ],
    [
      "embeddingStatus",
      { embeddingStatus: BOGUS },
      /^memories\.embedding_status must be one of pending, ready, failed, skipped \(got "bogus"\)$/,
    ],
    [
      "provenance.kind",
      { provenance: { kind: BOGUS } },
      /^memories\.provenance_kind must be one of stated, inferred, consolidated, reflected, imported \(got "bogus"\)$/,
    ],
  ];
  for (const [field, override, message] of createCases) {
    it(`createMemory・createMemoryWithOutbox は列挙に無い ${field} を拒み、何も書かない`, async () => {
      const { memoryStore } = build();
      const observation = await memoryStore.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
      );
      const valid = buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `enum-${field}`,
        sourceObservationId: observation.id,
        extractorVersion: "v1",
      });
      const input = { ...valid, ...override };

      await expect(memoryStore.createMemory(ctx, input)).rejects.toThrow(message);
      await expect(memoryStore.createMemoryWithOutbox(ctx, input, ["embed"])).rejects.toThrow(
        message,
      );

      expect(memoryStore.outboxJobs).toHaveLength(0);
      const retried = await memoryStore.createMemoryWithOutbox(ctx, valid, ["embed"]);
      expect(retried.created).toBe(true);
    });
  }

  it("updateStatus・updateStatusWithEvent は拒み、状態もイベントも変えない", async () => {
    const { memoryStore } = build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-update" }),
    );

    await expect(memoryStore.updateStatus(ctx, m.id, BOGUS)).rejects.toThrow(
      /^memories\.status must be one of /,
    );
    await expect(
      memoryStore.updateStatusWithEvent(ctx, m.id, BOGUS, {}, event(m.id)),
    ).rejects.toThrow(/^memories\.status must be one of /);

    expect(await memoryStore.get(ctx, m.id)).toEqual(m);
    expect(memoryStore.events).toHaveLength(0);
  });

  it("見つからない id・CAS の食い違いは、列挙の検査より先に決まる（Postgres は更新する行が無ければ CHECK に届かない）", async () => {
    const { memoryStore } = build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-order" }),
    );

    await expect(memoryStore.updateStatus(ctx, "mem-missing", BOGUS)).rejects.toThrow(
      /memory not found/,
    );
    await expect(
      memoryStore.updateStatus(ctx, m.id, BOGUS, { expectedStatus: "archived" }),
    ).rejects.toMatchObject({ name: "MemoryStatusConflictError" });
    await expect(memoryStore.setEmbeddingStatus(ctx, "mem-missing", BOGUS)).rejects.toThrow(
      /memory not found/,
    );
  });

  it("setEmbeddingStatus は拒み、状態を変えない", async () => {
    const { memoryStore } = build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-embedding" }),
    );

    await expect(memoryStore.setEmbeddingStatus(ctx, m.id, BOGUS)).rejects.toThrow(
      /^memories\.embedding_status must be one of /,
    );

    expect(await memoryStore.get(ctx, m.id)).toEqual(m);
  });

  it("resolveContestedPair は拒み、2件とも contested のまま残し、イベントも書かない", async () => {
    const { memoryStore } = build();
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-pair-a" }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-pair-b" }),
    );
    await memoryStore.markContestedPair(
      ctx,
      { id: a.id, event: event(a.id) },
      { id: b.id, event: event(b.id) },
    );
    const eventsBefore = memoryStore.events.length;

    await expect(
      memoryStore.resolveContestedPair(
        ctx,
        { id: a.id, status: "active", event: event(a.id) },
        { id: b.id, status: BOGUS, event: event(b.id) },
      ),
    ).rejects.toThrow(/^resolveContestedPair: second\.status must be "active" or "superseded"/);

    expect((await memoryStore.get(ctx, a.id))?.status).toBe("contested");
    expect((await memoryStore.get(ctx, b.id))?.status).toBe("contested");
    expect(memoryStore.events).toHaveLength(eventsBefore);
  });

  it("updateStatusWithEvent でも、見つからない id・CAS の食い違いは、列挙の検査より先に決まる（#1183）", async () => {
    const { memoryStore } = build();
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "enum-order-with-event" }),
    );

    await expect(
      memoryStore.updateStatusWithEvent(ctx, "mem-missing", BOGUS, {}, event("mem-missing")),
    ).rejects.toThrow(/memory not found/);
    await expect(
      memoryStore.updateStatusWithEvent(
        ctx,
        m.id,
        BOGUS,
        { expectedStatus: "archived" },
        event(m.id),
      ),
    ).rejects.toThrow(MemoryStatusConflictError);
  });

  describe("supersedeWithNewMemories の news[i] の列挙の外の値を拒み、何も書かない（#1183）", () => {
    const cases: Array<[string, Partial<NewMemory>, RegExp]> = [
      ["status", { status: BOGUS }, /^memories\.status must be one of /],
      ["digestSource", { digestSource: BOGUS }, /^memories\.digest_source must be one of /],
      [
        "embeddingStatus",
        { embeddingStatus: BOGUS },
        /^memories\.embedding_status must be one of /,
      ],
      [
        "provenance.kind",
        { provenance: { kind: BOGUS } },
        /^memories\.provenance_kind must be one of /,
      ],
    ];
    it.each(cases)("%s", async (field, override, message) => {
      const { memoryStore } = build();
      const old = await memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `enum-super-old-${field}` }),
      );
      await expect(
        memoryStore.supersedeWithNewMemories(
          ctx,
          [
            {
              input: buildNewMemoryFixture({
                tenantId: ctx.tenantId,
                contentHash: `enum-super-ok-${field}`,
              }),
              jobKinds: ["embed"],
            },
            {
              input: {
                ...buildNewMemoryFixture({
                  tenantId: ctx.tenantId,
                  contentHash: `enum-super-bad-${field}`,
                }),
                ...override,
              },
              jobKinds: ["embed"],
            },
          ],
          [
            {
              id: old.id,
              supersededByIndex: 0,
              expectedStatus: "active",
              event: event(old.id),
            },
          ],
        ),
      ).rejects.toThrow(message);

      expect((await memoryStore.get(ctx, old.id))?.status).toBe("active");
      expect(memoryStore.listByTenant(ctx)).toHaveLength(1);
      expect(memoryStore.outboxJobs).toHaveLength(0);
      expect(memoryStore.events).toHaveLength(0);
    });
  });
});

describe("assertStorableMemoryColumn は、列ごとに列挙のすべての値を通し、近い綴りを拒む（#1183）", () => {
  const columns = {
    status: MemoryStatusSchema.options,
    digest_source: DigestSourceSchema.options,
    embedding_status: EmbeddingStatusSchema.options,
    provenance_kind: ProvenanceKindSchema.options,
  } as const;
  const allOptions = new Set<string>(Object.values(columns).flat());

  for (const [column, options] of Object.entries(columns)) {
    const name = column as keyof typeof columns;

    it(`${column}: 列挙のすべての値（${options.join(", ")}）は通る`, () => {
      for (const option of options) {
        expect(() => assertStorableMemoryColumn(name, option)).not.toThrow();
      }
    });

    it(`${column}: 近い綴り・ほかの列の値・列挙に無い値は、値の集合を名指しして拒む`, () => {
      const outside = new Set<unknown>(["", " ", "bogus", "purged", null, undefined, 0]);
      for (const option of options) {
        outside.add(option.toUpperCase());
        outside.add(` ${option}`);
        outside.add(`${option} `);
        outside.add(option.slice(0, -1));
      }
      for (const other of allOptions) {
        if (!(options as readonly string[]).includes(other)) outside.add(other);
      }
      for (const value of outside) {
        if ((options as readonly unknown[]).includes(value)) continue;
        expect(() => assertStorableMemoryColumn(name, value)).toThrow(
          `memories.${column} must be one of ${options.join(", ")} (got ${JSON.stringify(value)})`,
        );
      }
    });
  }
});
