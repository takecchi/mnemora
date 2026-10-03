import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0562: Fake が、呼び手の書き換えから自分の中身を守る歯（Issue #1412 A8 の約束）。
 *
 * 約束は2方向ある。
 *  - 入力: 渡した配列・オブジェクト・Date を、渡した後に呼び手が書き換えても、保存した値は変わらない。
 *  - 返り値: 返された配列・オブジェクト・Date を呼び手が書き換えても、次に読んだ値は変わらない。
 *
 * `packages/testkit` の適合テストは Fake を通らない（Issue #768、そのコメント2）ので、同じ期待をここで当てる。
 * 適合テストの該当 9 本は `describeXxxStoreConformance` の it 名のうち「Issue #1412 A8」のもの
 * （`createMemory` の入力・`get`・`getMany`・`supersedeWithNewMemories` の `created[].memory`・`getVectors`・
 * `EventStore.append` の meta・`EventStore.get` の meta・`claimBatch` の payload・`complete`/`fail` の `opts.at`）。
 *
 * 各 `describe` の後半は**対照の歯**——書き換えない場合に値が正しく読める／返り値を呼び手が書き換えること自体は
 * できる（凍結していない）／Date が Date のまま読める（文字列化していない）／id が変わらない、を縛る。
 * 「写しを取りすぎて正当な操作まで壊す」実装で赤くなる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const T0 = "2026-01-01T00:00:00.000Z";

let hashCounter = 0;
function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${hashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date(T0),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function eventInput(
  memoryId: string | null,
  overrides: Partial<NewMemoryEvent> = {},
): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "superseded",
    actor: { type: "system" },
    digestSnapshot: "digest",
    sizeBeforeBytes: null,
    meta: { reason: "test" },
    ...overrides,
  };
}

describe("FakeMemoryStore は呼び手の書き換えから Memory を守る（ADR 0562）", () => {
  it("createMemory: 入力の tags・attributes・validFrom を渡した後に書き換えても、保存した値は変わらない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const validFrom = new Date(T0);
    const input = newMemory({ tags: ["original-tag"], attributes: { region: "jp" }, validFrom });
    const created = await memoryStore.createMemory(ctx, input);

    input.tags.push("mutated-by-caller");
    (input.attributes as Record<string, string>).region = "mutated-by-caller";
    validFrom.setTime(0);

    const reread = await memoryStore.get(ctx, created.id);
    expect(reread?.tags).toEqual(["original-tag"]);
    expect(reread?.attributes).toEqual({ region: "jp" });
    expect(reread?.validFrom?.toISOString()).toBe(T0);
  });

  it("createMemory: 入力の provenance・recordedAt も保存時に切り離される", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const recordedAt = new Date(T0);
    const input = newMemory({ recordedAt });
    const created = await memoryStore.createMemory(ctx, input);

    (input.provenance as { batchId: string }).batchId = "mutated-by-caller";
    recordedAt.setTime(0);

    const reread = await memoryStore.get(ctx, created.id);
    expect(reread?.provenance).toEqual({ kind: "imported", batchId: "fixture" });
    expect(reread?.recordedAt.toISOString()).toBe(T0);
  });

  it("createMemory: 入力の decayFloorAt・occurredAt・validUntil も保存時に切り離される（ADR 0562 決定2、ADR 0595）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const decayFloorAt = new Date("2026-06-01T00:00:00.000Z");
    const occurredAt = new Date(T0);
    const validUntil = new Date("2027-01-01T00:00:00.000Z");
    const input = newMemory({ decayFloorAt, occurredAt, validUntil });
    const created = await memoryStore.createMemory(ctx, input);

    decayFloorAt.setTime(0);
    occurredAt.setTime(0);
    validUntil.setTime(0);

    const reread = await memoryStore.get(ctx, created.id);
    expect(reread?.decayFloorAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(reread?.occurredAt?.toISOString()).toBe(T0);
    expect(reread?.validUntil?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("createMemory: 返した Memory が、後の purge（行の書き換え）で動かない／書き換えても store に届かない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const created = await memoryStore.createMemory(ctx, newMemory({ digest: "元の要旨" }));
    await memoryStore.updateStatus(ctx, created.id, "forgotten");
    await memoryStore.purgeMemory(
      ctx,
      created.id,
      { content: "[purged]", digest: "[purged]" },
      eventInput(created.id, { kind: "purged" }),
    );
    // 適合テスト（purgeMemory は recalls.index_band の digestBand から digest を伏せる）の期待値は
    // createMemory が返した値の digest である。行の書き換えで動くと、期待値が `[purged]` になってしまう。
    expect(created.digest).toBe("元の要旨");
    expect(created.status).toBe("active");

    const other = await memoryStore.createMemory(ctx, newMemory({ tags: ["t"] }));
    other.tags.push("mutated-by-caller");
    expect((await memoryStore.get(ctx, other.id))?.tags).toEqual(["t"]);
  });

  it("get: 返した Memory を書き換えても、次の get は影響を受けない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory({ tags: ["original-tag"] }));

    const first = await memoryStore.get(ctx, memory.id);
    (first as { status: string }).status = "mutated-by-caller";
    first!.tags.push("mutated-by-caller");
    first!.recordedAt.setTime(0);

    const second = await memoryStore.get(ctx, memory.id);
    expect(second?.status).toBe("active");
    expect(second?.tags).toEqual(["original-tag"]);
    expect(second?.recordedAt.toISOString()).toBe(T0);
  });

  it("getMany: 返した配列の要素を書き換えても、次の getMany は影響を受けない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory({ tags: ["original-tag"] }));

    const first = await memoryStore.getMany(ctx, [memory.id]);
    first[0]!.tags.push("mutated-by-caller");

    const second = await memoryStore.getMany(ctx, [memory.id]);
    expect(second[0]?.tags).toEqual(["original-tag"]);
  });

  it("supersedeWithNewMemories: 返した created[].memory を書き換えても、次の get は影響を受けない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const old = await memoryStore.createMemory(ctx, newMemory());
    const result = await memoryStore.supersedeWithNewMemories!(
      ctx,
      [{ input: newMemory({ content: "news", tags: ["original-tag"] }), jobKinds: [] }],
      [{ id: old.id, supersededByIndex: 0, event: eventInput(old.id) }],
    );

    const created = result.created[0]!.memory;
    created.tags.push("mutated-by-caller");

    const reread = await memoryStore.get(ctx, created.id);
    expect(reread?.tags).toEqual(["original-tag"]);
  });

  describe("対照: 書き換えなければ正しく読める／写しの取りすぎで壊さない", () => {
    it("get・getMany は同じ中身（id・tags・Date は Date のまま）を何度でも返す", async () => {
      const { memoryStore } = createFakeRuntimeStores();
      const created = await memoryStore.createMemory(
        ctx,
        newMemory({ tags: ["a", "b"], attributes: { k: "v" }, validFrom: new Date(T0) }),
      );

      const viaGet = await memoryStore.get(ctx, created.id);
      const viaGetMany = (await memoryStore.getMany(ctx, [created.id]))[0];
      for (const read of [viaGet, viaGetMany]) {
        expect(read?.id).toBe(created.id);
        expect(read?.tags).toEqual(["a", "b"]);
        expect(read?.attributes).toEqual({ k: "v" });
        expect(read?.validFrom).toBeInstanceOf(Date);
        expect(read?.validFrom?.toISOString()).toBe(T0);
        expect(read?.recordedAt).toBeInstanceOf(Date);
        expect(read?.createdAt).toBeInstanceOf(Date);
      }
      expect(viaGet).toEqual(viaGetMany);
    });

    it("返り値は凍結されていない（呼び手が自分の手元の値を書き換えること自体はできる）", async () => {
      const { memoryStore } = createFakeRuntimeStores();
      const created = await memoryStore.createMemory(ctx, newMemory({ tags: ["a"] }));
      const read = (await memoryStore.get(ctx, created.id))!;
      expect(Object.isFrozen(read)).toBe(false);
      expect(Object.isFrozen(read.tags)).toBe(false);
      expect(() => read.tags.push("x")).not.toThrow();
      expect(read.tags).toEqual(["a", "x"]);
    });

    it("書き込みの口（updateStatus）は、get が返した複製ではなく store の中の行を更新する", async () => {
      const { memoryStore } = createFakeRuntimeStores();
      const created = await memoryStore.createMemory(ctx, newMemory());
      await memoryStore.get(ctx, created.id);
      await memoryStore.updateStatus(ctx, created.id, "archived");
      expect((await memoryStore.get(ctx, created.id))?.status).toBe("archived");
    });

    it("入力の写しを取っても、入力の側の値は呼び手のもののまま（入力自体を凍結・変更しない）", async () => {
      const { memoryStore } = createFakeRuntimeStores();
      const input = newMemory({ tags: ["a"] });
      await memoryStore.createMemory(ctx, input);
      expect(input.tags).toEqual(["a"]);
      expect(Object.isFrozen(input.tags)).toBe(false);
      expect(input.recordedAt.toISOString()).toBe(T0);
    });

    it("同じ入力でも、created の id は get の id と一致する（写しで id を変えない）", async () => {
      const { memoryStore } = createFakeRuntimeStores();
      const old = await memoryStore.createMemory(ctx, newMemory());
      const result = await memoryStore.supersedeWithNewMemories!(
        ctx,
        [{ input: newMemory({ tags: ["t"] }), jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, event: eventInput(old.id) }],
      );
      const created = result.created[0]!.memory;
      const reread = await memoryStore.get(ctx, created.id);
      expect(reread).not.toBeNull();
      expect(reread?.id).toBe(created.id);
      expect(reread?.tags).toEqual(["t"]);
      expect((await memoryStore.get(ctx, old.id))?.supersededById).toBe(created.id);
    });
  });
});

describe("FakeVectorStore.getVectors は呼び手の書き換えからベクトルを守る（ADR 0562）", () => {
  const space = { provider: "p", model: "m", dimensions: 3 };

  it("返した vector の配列を書き換えても、次の getVectors は影響を受けない", async () => {
    const { memoryStore, vectorStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory());
    await vectorStore.upsert(ctx, space, memory.id, [1, 0.5, 0.25]);

    const first = await vectorStore.getVectors(ctx, space, [memory.id]);
    first[0]!.vector[0] = 999;

    const second = await vectorStore.getVectors(ctx, space, [memory.id]);
    expect(second[0]?.vector).toEqual([1, 0.5, 0.25]);
  });

  it("対照: 書き換えなければ元の値・memoryId のまま読め、凍結もされていない", async () => {
    const { memoryStore, vectorStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory());
    await vectorStore.upsert(ctx, space, memory.id, [1, 0.5, 0.25]);

    const read = await vectorStore.getVectors(ctx, space, [memory.id]);
    expect(read).toEqual([{ memoryId: memory.id, vector: [1, 0.5, 0.25] }]);
    expect(Array.isArray(read[0]!.vector)).toBe(true);
    expect(Object.isFrozen(read[0]!.vector)).toBe(false);
  });
});

describe("FakeEventStore は呼び手の書き換えから meta を守る（ADR 0562）", () => {
  it("append: 入力 meta（配列を含む）を後から書き換えても、保存した値は変わらない", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory());
    const sources = [randomUUID(), randomUUID()];
    const meta = { reason: "consolidated", sources };
    const expected = { reason: "consolidated", sources: [...sources] };

    const appended = await eventStore.append(ctx, eventInput(memory.id, { meta }));
    meta.reason = "mutated-by-caller";
    meta.sources.push(randomUUID());

    expect((await eventStore.get(ctx, appended.id))?.meta).toEqual(expected);
    expect(appended.meta).toEqual(expected);
  });

  it("append: 入力の at・actor を後から書き換えても、保存した値は変わらない（ADR 0562 決定2、ADR 0595）", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory());
    const at = new Date(T0);
    const actor = { type: "system" } as NewMemoryEvent["actor"];

    const appended = await eventStore.append(ctx, eventInput(memory.id, { at, actor }));
    at.setTime(0);
    (actor as { type: string }).type = "mutated-by-caller";

    const reread = await eventStore.get(ctx, appended.id);
    expect(reread?.at.toISOString()).toBe(T0);
    expect(reread?.actor).toEqual({ type: "system" });
  });

  it("get: 返した meta を書き換えても、次の get は影響を受けない", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory());
    const sources = [randomUUID(), randomUUID()];
    const appended = await eventStore.append(
      ctx,
      eventInput(memory.id, { meta: { reason: "consolidated", sources } }),
    );

    const first = await eventStore.get(ctx, appended.id);
    (first!.meta as { reason: string }).reason = "mutated-by-caller";
    (first!.meta.sources as string[]).push(randomUUID());

    const second = await eventStore.get(ctx, appended.id);
    expect(second?.meta).toEqual({ reason: "consolidated", sources });
  });

  it("対照: 書き換えなければ meta・at（Date のまま）・id が読み戻り、get は同じ id を返す", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory());
    const at = new Date(T0);
    const appended = await eventStore.append(
      ctx,
      eventInput(memory.id, { at, meta: { reason: "r", n: 3, nested: { a: ["x"] } } }),
    );

    const read = await eventStore.get(ctx, appended.id);
    expect(read?.id).toBe(appended.id);
    expect(read?.meta).toEqual({ reason: "r", n: 3, nested: { a: ["x"] } });
    expect(read?.at).toBeInstanceOf(Date);
    expect(read?.at.toISOString()).toBe(T0);
    expect(Object.isFrozen(read?.meta)).toBe(false);
  });

  it("対照: updateStatusWithEvent が積んだイベントも、get で meta ごと読み戻る", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory());
    const { event } = await memoryStore.updateStatusWithEvent(
      ctx,
      memory.id,
      "archived",
      {},
      eventInput(memory.id, { kind: "archived", meta: { reason: "r", list: [1, 2] } }),
    );
    const read = await eventStore.get(ctx, event.id);
    expect(read?.meta).toEqual({ reason: "r", list: [1, 2] });
  });
});

describe("FakeOutboxStore は呼び手の書き換えから行を守る（ADR 0562）", () => {
  type Stores = ReturnType<typeof createFakeRuntimeStores>;
  const rows = (stores: Stores) =>
    (stores.memoryStore as unknown as { backing: { outboxJobs: Array<Record<string, unknown>> } })
      .backing.outboxJobs;

  async function seed(stores: Stores, payload: Record<string, unknown>): Promise<string> {
    const { jobs } = await stores.memoryStore.createObservationWithOutbox(
      ctx,
      { tenantId: ctx.tenantId, subjectId: null, externalId: null, kind: "utterance", payload: {} },
      ["extract"],
    );
    const row = rows(stores).find((j) => j.id === jobs[0]!.id)!;
    row.payload = payload;
    row.availableAt = new Date("2020-01-01T00:00:00.000Z"); // T0 で claim できるよう過去へ
    return jobs[0]!.id;
  }

  const claim = (stores: Stores, now = new Date()) =>
    stores.outboxStore.claimBatch(ctx, { limit: 10, now, claimedBy: "w", leaseMs: 60_000 });

  it("claimBatch: 返した payload を書き換えても、store 側の行は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const id = await seed(stores, { observationId: "obs-1", tags: ["original-tag"] });

    const claimed = (await claim(stores)).find((j) => j.id === id)!;
    (claimed.payload as Record<string, unknown>).observationId = "mutated-by-caller";
    (claimed.payload.tags as string[]).push("mutated-by-caller");

    expect(rows(stores).find((j) => j.id === id)!.payload).toEqual({
      observationId: "obs-1",
      tags: ["original-tag"],
    });
  });

  it("claimBatch: 返した claimedAt・availableAt の Date を書き換えても、store 側の行は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const id = await seed(stores, {});
    const now = new Date(T0);
    const claimed = (await claim(stores, now)).find((j) => j.id === id)!;
    const availableAt = rows(stores).find((j) => j.id === id)!.availableAt as Date;
    const availableBefore = availableAt.getTime();

    claimed.claimedAt!.setTime(0);
    claimed.availableAt.setTime(0);
    now.setTime(0);

    const row = rows(stores).find((j) => j.id === id)!;
    expect((row.claimedAt as Date).toISOString()).toBe(T0);
    expect((row.availableAt as Date).getTime()).toBe(availableBefore);
  });

  for (const op of ["complete", "fail"] as const) {
    it(`${op}: 渡した opts.at を後から書き換えても、${op === "complete" ? "completedAt" : "failedAt"} は変わらない`, async () => {
      const stores = createFakeRuntimeStores();
      const id = await seed(stores, {});
      const [claimed] = await claim(stores);
      const at = new Date(T0);
      if (op === "complete") {
        await stores.outboxStore.complete(ctx, id, claimed!.attempts, { at });
      } else {
        await stores.outboxStore.fail(ctx, id, "boom", claimed!.attempts, { at });
      }
      at.setTime(0);

      const row = rows(stores).find((j) => j.id === id)!;
      const stamped = (op === "complete" ? row.completedAt : row.failedAt) as Date;
      expect(stamped.toISOString()).toBe(T0);
    });
  }

  describe("対照: 書き換えなければ正しく読める／写しの取りすぎで壊さない", () => {
    it("claimBatch の返り値は payload が同じ中身で、Date は Date のまま、attempts・id が正しい", async () => {
      const stores = createFakeRuntimeStores();
      const id = await seed(stores, { observationId: "obs-1", tags: ["t"], n: 2 });
      const now = new Date(T0);

      const claimed = (await claim(stores, now)).find((j) => j.id === id)!;
      expect(claimed.id).toBe(id);
      expect(claimed.payload).toEqual({ observationId: "obs-1", tags: ["t"], n: 2 });
      expect(claimed.attempts).toBe(1);
      expect(claimed.claimedBy).toBe("w");
      expect(claimed.claimedAt).toBeInstanceOf(Date);
      expect(claimed.claimedAt!.toISOString()).toBe(T0);
      expect(claimed.availableAt).toBeInstanceOf(Date);
      expect(Object.isFrozen(claimed.payload)).toBe(false);
    });

    it("complete・fail は opts.at を省くと Date（現在時刻）を、渡すと渡した時刻そのものを残す", async () => {
      const stores = createFakeRuntimeStores();
      const idA = await seed(stores, {});
      const idB = await seed(stores, {});
      const claimed = await claim(stores);
      const attemptsOf = (id: string) => claimed.find((j) => j.id === id)!.attempts;

      await stores.outboxStore.complete(ctx, idA, attemptsOf(idA));
      await stores.outboxStore.fail(ctx, idB, "e", attemptsOf(idB), { at: new Date(T0) });

      const a = rows(stores).find((j) => j.id === idA)!;
      const b = rows(stores).find((j) => j.id === idB)!;
      expect(a.completedAt).toBeInstanceOf(Date);
      expect(Number.isNaN((a.completedAt as Date).getTime())).toBe(false);
      expect(b.failedAt).toBeInstanceOf(Date);
      expect((b.failedAt as Date).toISOString()).toBe(T0);
      expect(b.lastError).toBe("e");
    });

    it("claim の再取得（lease 切れ）は store 側の行を更新する（複製に書いて消えない）", async () => {
      const stores = createFakeRuntimeStores();
      const id = await seed(stores, {});
      const first = (await claim(stores, new Date(T0))).find((j) => j.id === id)!;
      expect(first.attempts).toBe(1);
      const later = new Date(new Date(T0).getTime() + 120_000);
      const second = (await claim(stores, later)).find((j) => j.id === id)!;
      expect(second.attempts).toBe(2);
      expect(rows(stores).find((j) => j.id === id)!.attempts).toBe(2);
    });
  });
});
