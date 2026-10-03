import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import type { NewObservation } from "../observation.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0578: ADR 0562 が「まだ store の行そのものを返す」と書き残した口（`createMemoryWithOutbox`・`list*`・
 * `updateStatus` などの返り値）を、写しを返す形に直した歯。
 *
 * 各口について「返り値を（配列・Date・ネストしたオブジェクトまで）書き換えても、その後に store から読み直した値は
 * 変わらない」を当てる。書き換えは {@link scribble} が、届く限りの値すべてに行う。
 * 比べる相手は `liveRowForTest`（store の中の行そのもの）と、公開の `get` / `list` の両方。
 *
 * 各 `describe` の最後は**対照の歯**——口が書いたことは store に届いている／`liveRowForTest` への書き込みは
 * 後の読みに見える／返り値は中身が正しく Date は Date のまま／凍結されていない、を縛る。
 * 「写しに書いてから別の写しを返す（store に届かない）」「浅い写しで配列を共有する」といった、写しの取りすぎ・
 * 取り足りなさで赤くなる。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";

type Stores = ReturnType<typeof createFakeRuntimeStores>;

/** 値の届く限りを書き換える。Date は 0 に、配列は要素を足して中も、オブジェクトは全欄を別の値にして中も。 */
function scribble(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Date) {
    value.setTime(0);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scribble(item, seen);
    value.push("mutated-by-caller");
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // `id` は書き換えない: 歯が返り値の id で後から読み直すため（返り値が行そのものなら、他の欄の書き換えで赤くなる）。
    if (key === "id") continue;
    const inner = record[key];
    if (inner !== null && typeof inner === "object") {
      scribble(inner, seen);
    } else {
      record[key] = "mutated-by-caller";
    }
  }
  record["extraByCaller"] = "mutated-by-caller";
}

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
    tags: ["tag-a", "tag-b"],
    attributes: { region: "jp", team: "core" },
    claimKey: { subject: "s", predicate: "p" },
    occurredAt: new Date(T0),
    recordedAt: new Date(T0),
    lastReinforcedAt: new Date(T0),
    validFrom: new Date(T0),
    validUntil: new Date("2027-01-01T00:00:00.000Z"),
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
    at: new Date(T0),
    actor: { type: "system" },
    digestSnapshot: "digest",
    sizeBeforeBytes: null,
    meta: { reason: "test", sources: ["s1", "s2"], nested: { n: 1 } },
    ...overrides,
  };
}

function newObservation(overrides: Partial<NewObservation> = {}): NewObservation {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    externalId: "ext-1",
    kind: "utterance",
    payload: { text: "hello", nested: { list: [1, 2] } },
    occurredAt: new Date(T0),
    recordedAt: new Date(T0),
    validFrom: new Date(T0),
    validUntil: new Date("2027-01-01T00:00:00.000Z"),
    attributes: { region: "jp", team: "core" },
    ...overrides,
  };
}

/** store の中の行そのものの、今この時点の深い写し（比べる基準）。 */
function liveClone(stores: Stores, id: string) {
  const row = stores.memoryStore.liveRowForTest(ctx, id);
  if (row === null) throw new Error(`row not found: ${id}`);
  return structuredClone(row);
}

/** 行（`liveRowForTest`）と公開の `get` の両方が、基準から変わっていないこと。 */
async function expectRowUnchanged(stores: Stores, id: string, baseline: unknown) {
  expect(stores.memoryStore.liveRowForTest(ctx, id)).toEqual(baseline);
  expect(await stores.memoryStore.get(ctx, id)).toEqual(baseline);
}

async function seed(stores: Stores, overrides: Partial<NewMemory> = {}) {
  return stores.memoryStore.createMemory(ctx, newMemory(overrides));
}

describe("Observation の口は、返り値の書き換えから行を守る（ADR 0578）", () => {
  it("createObservation: 返り値を書き換えても、getObservation は変わらない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const created = await memoryStore.createObservation(ctx, newObservation());
    const baseline = structuredClone((await memoryStore.getObservation(ctx, created.id))!);
    scribble(created);
    expect(await memoryStore.getObservation(ctx, created.id)).toEqual(baseline);
  });

  it("createObservation: 同じ externalId の再送が返す Observation を書き換えても、行は変わらない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const created = await memoryStore.createObservation(ctx, newObservation());
    const baseline = structuredClone((await memoryStore.getObservation(ctx, created.id))!);
    const again = await memoryStore.createObservation(ctx, newObservation());
    expect(again.id).toBe(created.id);
    scribble(again);
    expect(await memoryStore.getObservation(ctx, created.id)).toEqual(baseline);
  });

  it("getObservation: 返り値を書き換えても、次の getObservation は変わらない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const created = await memoryStore.createObservation(ctx, newObservation());
    const first = (await memoryStore.getObservation(ctx, created.id))!;
    const baseline = structuredClone(first);
    scribble(first);
    expect(await memoryStore.getObservation(ctx, created.id)).toEqual(baseline);
  });

  it("createObservationWithOutbox: observation（新規・既存の両方）と jobs を書き換えても、行は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const { memoryStore, outboxStore } = stores;
    const result = await memoryStore.createObservationWithOutbox(ctx, newObservation(), [
      "extract",
      "embed",
    ]);
    expect(result.created).toBe(true);
    const obsBaseline = structuredClone(
      (await memoryStore.getObservation(ctx, result.observation.id))!,
    );
    const jobsBaseline = structuredClone(outboxStore.listJobs(ctx));
    expect(jobsBaseline).toHaveLength(2);

    const again = await memoryStore.createObservationWithOutbox(ctx, newObservation(), ["extract"]);
    expect(again.created).toBe(false);
    scribble(result.observation);
    scribble(result.jobs);
    scribble(again.observation);

    expect(await memoryStore.getObservation(ctx, result.observation.id)).toEqual(obsBaseline);
    expect(outboxStore.listJobs(ctx)).toEqual(jobsBaseline);
  });

  describe("対照", () => {
    it("返り値は中身が正しく、Date は Date のまま、凍結されていない", async () => {
      const { memoryStore } = createFakeRuntimeStores();
      const created = await memoryStore.createObservation(ctx, newObservation());
      const read = (await memoryStore.getObservation(ctx, created.id))!;
      expect(read).toEqual(created);
      expect(read.id).toBe(created.id);
      expect(read.occurredAt).toBeInstanceOf(Date);
      expect(read.occurredAt?.toISOString()).toBe(T0);
      expect(read.payload).toEqual({ text: "hello", nested: { list: [1, 2] } });
      expect(Object.isFrozen(read)).toBe(false);
      expect(Object.isFrozen(read.payload)).toBe(false);
    });

    it("createObservationWithOutbox の jobs は store の job と同じ id・中身で、後の claimBatch に見える", async () => {
      const { memoryStore, outboxStore } = createFakeRuntimeStores();
      const { jobs, observation } = await memoryStore.createObservationWithOutbox(
        ctx,
        newObservation(),
        ["extract"],
      );
      expect(jobs[0]?.payload).toEqual({ observationId: observation.id });
      expect(jobs[0]?.availableAt).toBeInstanceOf(Date);
      expect(outboxStore.listJobs(ctx)).toEqual(jobs);
      const claimed = await outboxStore.claimBatch(ctx, {
        limit: 10,
        now: new Date(Date.now() + 1000),
        claimedBy: "w",
        leaseMs: 60_000,
      });
      expect(claimed.map((j) => j.id)).toEqual([jobs[0]!.id]);
    });
  });
});

describe("label の口は、返り値の書き換えから行を守る（ADR 0578）", () => {
  it("listLabels: 返した要素を書き換えても、次の listLabels は変わらない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    await memoryStore.createMemory(ctx, newMemory({ tags: ["proposed-label"] }));
    await memoryStore.registerLabel!(ctx, "registered-label");
    const baseline = structuredClone(await memoryStore.listLabels!(ctx));
    expect(baseline).toHaveLength(2);

    scribble(await memoryStore.listLabels!(ctx));
    expect(await memoryStore.listLabels!(ctx)).toEqual(baseline);
  });

  it("registerLabel: 返り値を書き換えても、次の listLabels は変わらない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const registered = await memoryStore.registerLabel!(ctx, "registered-label");
    const baseline = structuredClone(await memoryStore.listLabels!(ctx));
    scribble(registered);
    expect(await memoryStore.listLabels!(ctx)).toEqual(baseline);
  });

  describe("対照", () => {
    it("registerLabel の返り値と listLabels の中身は同じで、registeredAt は Date のまま、再登録で proposedCount を引き継ぐ", async () => {
      const { memoryStore } = createFakeRuntimeStores();
      await memoryStore.createMemory(ctx, newMemory({ tags: ["x"] }));
      const registered = await memoryStore.registerLabel!(ctx, "x");
      const listed = await memoryStore.listLabels!(ctx);
      expect(listed).toEqual([registered]);
      expect(registered.status).toBe("registered");
      expect(registered.proposedCount).toBe(1);
      expect(registered.registeredAt).toBeInstanceOf(Date);
      const again = await memoryStore.registerLabel!(ctx, "x");
      expect(again.registeredAt?.getTime()).toBe(registered.registeredAt?.getTime());
      expect(Object.isFrozen(listed[0])).toBe(false);
    });
  });
});

describe("createMemoryWithOutbox は、返り値の書き換えから行を守る（ADR 0578）", () => {
  it("memory（新規・既存の両方）と jobs を書き換えても、store は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const { memoryStore, outboxStore } = stores;
    // 冪等キーは (sourceObservationId, extractorVersion, contentHash)。sourceObservationId が無いと再送が別の行になる。
    const obs = await memoryStore.createObservation(ctx, newObservation());
    const input = newMemory({
      contentHash: "same-hash",
      sourceObservationId: obs.id,
      extractorVersion: "v1",
    });
    const result = await memoryStore.createMemoryWithOutbox(ctx, input, ["embed", "extract"]);
    expect(result.created).toBe(true);
    const baseline = liveClone(stores, result.memory.id);
    const jobsBaseline = structuredClone(outboxStore.listJobs(ctx));
    expect(jobsBaseline).toHaveLength(2);

    const again = await memoryStore.createMemoryWithOutbox(ctx, input, ["embed"]);
    expect(again.created).toBe(false);
    expect(again.memory.id).toBe(result.memory.id);
    scribble(result.memory);
    scribble(result.jobs);
    scribble(again.memory);

    await expectRowUnchanged(stores, result.memory.id, baseline);
    expect(outboxStore.listJobs(ctx)).toEqual(jobsBaseline);
  });

  describe("対照", () => {
    it("memory は get と同じ中身（Date は Date のまま）、jobs は store の job と同じ中身で、後の claimBatch に見える", async () => {
      const stores = createFakeRuntimeStores();
      const result = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
      expect(result.memory).toEqual(await stores.memoryStore.get(ctx, result.memory.id));
      expect(result.memory.recordedAt).toBeInstanceOf(Date);
      expect(result.jobs[0]?.payload).toEqual({ memoryId: result.memory.id });
      expect(result.jobs[0]?.availableAt).toBeInstanceOf(Date);
      expect(stores.outboxStore.listJobs(ctx)).toEqual(result.jobs);
      expect(Object.isFrozen(result.memory)).toBe(false);
      expect(Object.isFrozen(result.jobs[0])).toBe(false);
      const claimed = await stores.outboxStore.claimBatch(ctx, {
        limit: 10,
        now: new Date(Date.now() + 1000),
        claimedBy: "w",
        leaseMs: 60_000,
      });
      expect(claimed.map((j) => j.id)).toEqual([result.jobs[0]!.id]);
    });

    it("createMemoryWithOutbox が作った行は liveRowForTest で書き換えられ、後の get に見える（保存する行と返す行が別）", async () => {
      const stores = createFakeRuntimeStores();
      const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), []);
      stores.memoryStore.liveRowForTest(ctx, memory.id)!.tags.push("written-to-live-row");
      expect((await stores.memoryStore.get(ctx, memory.id))?.tags).toEqual([
        "tag-a",
        "tag-b",
        "written-to-live-row",
      ]);
      expect(memory.tags).toEqual(["tag-a", "tag-b"]);
    });
  });
});

describe("listBySourceObservation(AllVersions) は、返り値の書き換えから行を守る（ADR 0578）", () => {
  async function setup() {
    const stores = createFakeRuntimeStores();
    const obs = await stores.memoryStore.createObservation(ctx, newObservation());
    const m1 = await seed(stores, { sourceObservationId: obs.id, extractorVersion: "v1" });
    const m2 = await seed(stores, { sourceObservationId: obs.id, extractorVersion: "v2" });
    return { stores, obs, m1, m2 };
  }

  it("listBySourceObservation: 返した要素を書き換えても、store は変わらない", async () => {
    const { stores, obs, m1 } = await setup();
    const baseline = liveClone(stores, m1.id);
    const listed = await stores.memoryStore.listBySourceObservation(ctx, obs.id, "v1");
    expect(listed.map((m) => m.id)).toEqual([m1.id]);
    scribble(listed);
    await expectRowUnchanged(stores, m1.id, baseline);
    expect(await stores.memoryStore.listBySourceObservation(ctx, obs.id, "v1")).toEqual([baseline]);
  });

  it("listBySourceObservationAllVersions: 返した要素を書き換えても、store は変わらない", async () => {
    const { stores, obs, m1, m2 } = await setup();
    const b1 = liveClone(stores, m1.id);
    const b2 = liveClone(stores, m2.id);
    const listed = await stores.memoryStore.listBySourceObservationAllVersions(ctx, obs.id);
    expect(listed).toHaveLength(2);
    scribble(listed);
    await expectRowUnchanged(stores, m1.id, b1);
    await expectRowUnchanged(stores, m2.id, b2);
  });

  describe("対照", () => {
    it("返り値は get と同じ中身で、liveRowForTest への書き込みが次の list に見える", async () => {
      const { stores, obs, m1 } = await setup();
      const [listed] = await stores.memoryStore.listBySourceObservation(ctx, obs.id, "v1");
      expect(listed).toEqual(await stores.memoryStore.get(ctx, m1.id));
      expect(listed?.recordedAt).toBeInstanceOf(Date);
      expect(Object.isFrozen(listed)).toBe(false);
      stores.memoryStore.liveRowForTest(ctx, m1.id)!.content = "written-to-live-row";
      const [after] = await stores.memoryStore.listBySourceObservationAllVersions(ctx, obs.id);
      expect(after?.content).toBe("written-to-live-row");
    });
  });
});

describe("状態を書く口（updateStatus ほか）は、返り値の書き換えから行を守る（ADR 0578）", () => {
  it("updateStatus: 返り値を書き換えても、store は変わらない（更新は届いている）", async () => {
    const stores = createFakeRuntimeStores();
    const created = await seed(stores);
    const returned = await stores.memoryStore.updateStatus(ctx, created.id, "archived");
    const baseline = liveClone(stores, created.id);
    expect(baseline.status).toBe("archived");
    scribble(returned);
    await expectRowUnchanged(stores, created.id, baseline);
  });

  it("updateStatusWithEvent: memory と event を書き換えても、store・eventStore は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const created = await seed(stores);
    const { memory, event } = await stores.memoryStore.updateStatusWithEvent(
      ctx,
      created.id,
      "archived",
      {},
      eventInput(created.id, { kind: "archived" }),
    );
    const baseline = liveClone(stores, created.id);
    const eventBaseline = structuredClone((await stores.eventStore.get(ctx, event.id))!);
    scribble(memory);
    scribble(event);
    await expectRowUnchanged(stores, created.id, baseline);
    expect(await stores.eventStore.get(ctx, event.id)).toEqual(eventBaseline);
  });

  it("setEmbeddingStatus: 書いた返り値・巻き戻しを断った（no-op）返り値のどちらを書き換えても、store は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const created = await seed(stores);
    const written = await stores.memoryStore.setEmbeddingStatus(ctx, created.id, "ready");
    const baseline = liveClone(stores, created.id);
    expect(baseline.embeddingStatus).toBe("ready");
    scribble(written);
    await expectRowUnchanged(stores, created.id, baseline);

    // ready → failed は巻き戻しなので no-op（ADR 0048 と同じ理由）。現在の行の写しが返る。
    const noop = await stores.memoryStore.setEmbeddingStatus(ctx, created.id, "failed");
    expect(noop.embeddingStatus).toBe("ready");
    scribble(noop);
    await expectRowUnchanged(stores, created.id, baseline);
  });

  it("reinforce: 書いた返り値・no-op の返り値のどちらを書き換えても、store は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const created = await seed(stores);
    const reinforced = await stores.memoryStore.reinforce(ctx, created.id, new Date(T1));
    const baseline = liveClone(stores, created.id);
    expect(baseline.lastReinforcedAt?.toISOString()).toBe(T1);
    scribble(reinforced);
    await expectRowUnchanged(stores, created.id, baseline);

    const noop = await stores.memoryStore.reinforce(ctx, created.id, new Date(T0));
    scribble(noop);
    await expectRowUnchanged(stores, created.id, baseline);
  });

  it("reinforce: 渡した at を後から書き換えても、lastReinforcedAt は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const created = await seed(stores);
    const at = new Date(T1);
    await stores.memoryStore.reinforce(ctx, created.id, at);
    at.setTime(0);
    expect(
      stores.memoryStore.liveRowForTest(ctx, created.id)?.lastReinforcedAt?.toISOString(),
    ).toBe(T1);
  });

  it("reinforceMany: 返した要素を書き換えても、store は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const a = await seed(stores);
    const b = await seed(stores);
    const returned = await stores.memoryStore.reinforceMany!(ctx, [a.id, b.id], new Date(T1));
    const ba = liveClone(stores, a.id);
    const bb = liveClone(stores, b.id);
    scribble(returned);
    await expectRowUnchanged(stores, a.id, ba);
    await expectRowUnchanged(stores, b.id, bb);
  });

  it("purgeMemory: memory と event を書き換えても、store・eventStore は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const created = await seed(stores);
    await stores.memoryStore.updateStatus(ctx, created.id, "forgotten");
    const { memory, event } = await stores.memoryStore.purgeMemory!(
      ctx,
      created.id,
      { content: "[purged]", digest: "[purged]" },
      eventInput(created.id, { kind: "purged" }),
    );
    const baseline = liveClone(stores, created.id);
    const eventBaseline = structuredClone((await stores.eventStore.get(ctx, event.id))!);
    expect(baseline.content).toBe("[purged]");
    scribble(memory);
    scribble(event);
    await expectRowUnchanged(stores, created.id, baseline);
    expect(await stores.eventStore.get(ctx, event.id)).toEqual(eventBaseline);
  });

  describe("対照", () => {
    it("updateStatus が書いたことは、後の get・liveRowForTest・list に届いている（返り値は新しい status・supersededById）", async () => {
      const stores = createFakeRuntimeStores();
      const obs = await stores.memoryStore.createObservation(ctx, newObservation());
      const old = await seed(stores, { sourceObservationId: obs.id });
      const next = await seed(stores);
      const returned = await stores.memoryStore.updateStatus(ctx, old.id, "superseded", {
        supersededById: next.id,
      });
      expect(returned.status).toBe("superseded");
      expect(returned.supersededById).toBe(next.id);
      expect(returned.updatedAt).toBeInstanceOf(Date);
      const got = (await stores.memoryStore.get(ctx, old.id))!;
      expect(got.status).toBe("superseded");
      expect(got.supersededById).toBe(next.id);
      expect(stores.memoryStore.liveRowForTest(ctx, old.id)?.status).toBe("superseded");
      expect(
        (await stores.memoryStore.listBySourceObservationAllVersions(ctx, obs.id))[0]?.status,
      ).toBe("superseded");
      expect(returned).toEqual(got);
      expect(Object.isFrozen(returned)).toBe(false);
      expect(Object.isFrozen(returned.tags)).toBe(false);
    });

    it("updateStatus の返り値は呼ぶたびに別の複製で、store の行そのものではない", async () => {
      const stores = createFakeRuntimeStores();
      const created = await seed(stores);
      const first = await stores.memoryStore.updateStatus(ctx, created.id, "archived");
      const second = await stores.memoryStore.updateStatus(ctx, created.id, "active");
      expect(first).not.toBe(second);
      expect(first.status).toBe("archived");
      expect(second.status).toBe("active");
      expect(first).not.toBe(stores.memoryStore.liveRowForTest(ctx, created.id));
    });

    it("liveRowForTest で取った行への書き込みは、後の get に見える", async () => {
      const stores = createFakeRuntimeStores();
      const created = await seed(stores);
      const row = stores.memoryStore.liveRowForTest(ctx, created.id)!;
      row.status = "forgotten";
      row.tags.push("written-to-live-row");
      row.recordedAt.setTime(0);
      const got = (await stores.memoryStore.get(ctx, created.id))!;
      expect(got.status).toBe("forgotten");
      expect(got.tags).toEqual(["tag-a", "tag-b", "written-to-live-row"]);
      expect(got.recordedAt.getTime()).toBe(0);
    });

    it("updateStatusWithEvent の event は eventStore の event と同じ中身（at は Date のまま）", async () => {
      const stores = createFakeRuntimeStores();
      const created = await seed(stores);
      const { memory, event } = await stores.memoryStore.updateStatusWithEvent(
        ctx,
        created.id,
        "archived",
        {},
        eventInput(created.id, { kind: "archived" }),
      );
      expect(memory.status).toBe("archived");
      expect(await stores.eventStore.get(ctx, event.id)).toEqual(event);
      expect(event.at).toBeInstanceOf(Date);
      expect(event.meta).toEqual(eventInput(created.id).meta);
      expect(Object.isFrozen(event.meta)).toBe(false);
    });

    it("setEmbeddingStatus・reinforce が書いたことは、後の get に届いている", async () => {
      const stores = createFakeRuntimeStores();
      const created = await seed(stores);
      const embedded = await stores.memoryStore.setEmbeddingStatus(ctx, created.id, "ready");
      expect(embedded.embeddingStatus).toBe("ready");
      const reinforced = await stores.memoryStore.reinforce(ctx, created.id, new Date(T1));
      expect(reinforced.lastReinforcedAt).toBeInstanceOf(Date);
      const got = (await stores.memoryStore.get(ctx, created.id))!;
      expect(got.embeddingStatus).toBe("ready");
      expect(got.lastReinforcedAt?.toISOString()).toBe(T1);
      expect(got).toEqual(reinforced);
    });

    it("purgeMemory が書いたことは get に届いている（返り値も同じ中身）", async () => {
      const stores = createFakeRuntimeStores();
      const created = await seed(stores);
      await stores.memoryStore.updateStatus(ctx, created.id, "forgotten");
      const { memory } = await stores.memoryStore.purgeMemory!(
        ctx,
        created.id,
        { content: "[purged]", digest: "[purged]" },
        eventInput(created.id, { kind: "purged" }),
      );
      const got = (await stores.memoryStore.get(ctx, created.id))!;
      expect(got.content).toBe("[purged]");
      expect(got.tags).toEqual([]);
      expect(got.claimKey).toBeNull();
      expect(got.purgedAt).toBeInstanceOf(Date);
      expect(got).toEqual(memory);
    });
  });
});

describe("contested の口は、返り値の書き換えから行を守る（ADR 0578）", () => {
  async function pair() {
    const stores = createFakeRuntimeStores();
    const a = await seed(stores);
    const b = await seed(stores);
    return { stores, a, b };
  }
  async function trio() {
    const stores = createFakeRuntimeStores();
    const a = await seed(stores);
    const b = await seed(stores);
    const c = await seed(stores);
    return { stores, a, b, c };
  }

  it("markContestedPair: first・second・events を書き換えても、store・eventStore は変わらない", async () => {
    const { stores, a, b } = await pair();
    const result = await stores.memoryStore.markContestedPair!(
      ctx,
      { id: a.id, event: eventInput(a.id, { kind: "updated" }) },
      { id: b.id, event: eventInput(b.id, { kind: "updated" }) },
    );
    const ba = liveClone(stores, a.id);
    const bb = liveClone(stores, b.id);
    const be = structuredClone(await stores.eventStore.list(ctx, {}));
    expect(ba.status).toBe("contested");
    scribble(result.first);
    scribble(result.second);
    scribble(result.events);
    await expectRowUnchanged(stores, a.id, ba);
    await expectRowUnchanged(stores, b.id, bb);
    expect(await stores.eventStore.list(ctx, {})).toEqual(be);
  });

  it("resolveContestedPair: first・second・events を書き換えても、store・eventStore は変わらない", async () => {
    const { stores, a, b } = await pair();
    await stores.memoryStore.markContestedPair!(
      ctx,
      { id: a.id, event: eventInput(a.id, { kind: "updated" }) },
      { id: b.id, event: eventInput(b.id, { kind: "updated" }) },
    );
    const result = await stores.memoryStore.resolveContestedPair!(
      ctx,
      { id: a.id, status: "active", event: eventInput(a.id, { kind: "updated" }) },
      {
        id: b.id,
        status: "superseded",
        supersededById: a.id,
        event: eventInput(b.id, { kind: "updated" }),
      },
    );
    const ba = liveClone(stores, a.id);
    const bb = liveClone(stores, b.id);
    const be = structuredClone(await stores.eventStore.list(ctx, {}));
    expect(bb.status).toBe("superseded");
    scribble(result.first);
    scribble(result.second);
    scribble(result.events);
    await expectRowUnchanged(stores, a.id, ba);
    await expectRowUnchanged(stores, b.id, bb);
    expect(await stores.eventStore.list(ctx, {})).toEqual(be);
  });

  it("markContestedGroup: members・events を書き換えても、store・eventStore は変わらない", async () => {
    const { stores, a, b, c } = await trio();
    const result = await stores.memoryStore.markContestedGroup!(
      ctx,
      [a, b, c].map((m) => ({ id: m.id, event: eventInput(m.id, { kind: "updated" }) })),
    );
    const baselines = [a, b, c].map((m) => liveClone(stores, m.id));
    const be = structuredClone(await stores.eventStore.list(ctx, {}));
    expect(baselines[0]?.status).toBe("contested");
    scribble(result.members);
    scribble(result.events);
    for (const [i, m] of [a, b, c].entries()) {
      await expectRowUnchanged(stores, m.id, baselines[i]);
    }
    expect(await stores.eventStore.list(ctx, {})).toEqual(be);
  });

  it("resolveContestedGroup: members・events を書き換えても、store・eventStore は変わらない", async () => {
    const { stores, a, b, c } = await trio();
    await stores.memoryStore.markContestedGroup!(
      ctx,
      [a, b, c].map((m) => ({ id: m.id, event: eventInput(m.id, { kind: "updated" }) })),
    );
    const result = await stores.memoryStore.resolveContestedGroup!(ctx, [
      { id: a.id, status: "active", event: eventInput(a.id, { kind: "updated" }) },
      {
        id: b.id,
        status: "superseded",
        supersededById: a.id,
        event: eventInput(b.id, { kind: "updated" }),
      },
      {
        id: c.id,
        status: "superseded",
        supersededById: a.id,
        event: eventInput(c.id, { kind: "updated" }),
      },
    ]);
    const baselines = [a, b, c].map((m) => liveClone(stores, m.id));
    const be = structuredClone(await stores.eventStore.list(ctx, {}));
    expect(baselines[1]?.status).toBe("superseded");
    scribble(result.members);
    scribble(result.events);
    for (const [i, m] of [a, b, c].entries()) {
      await expectRowUnchanged(stores, m.id, baselines[i]);
    }
    expect(await stores.eventStore.list(ctx, {})).toEqual(be);
  });

  it("resolveOrphanedContested: memory・event を書き換えても、store・eventStore は変わらない", async () => {
    const { stores, a, b } = await pair();
    await stores.memoryStore.markContestedPair!(
      ctx,
      { id: a.id, event: eventInput(a.id, { kind: "updated" }) },
      { id: b.id, event: eventInput(b.id, { kind: "updated" }) },
    );
    const { memory, event } = await stores.memoryStore.resolveOrphanedContested!(ctx, {
      id: a.id,
      contestedWithId: b.id,
      event: eventInput(a.id, { kind: "updated" }),
    });
    const baseline = liveClone(stores, a.id);
    const eventBaseline = structuredClone((await stores.eventStore.get(ctx, event.id))!);
    expect(baseline.status).toBe("active");
    scribble(memory);
    scribble(event);
    await expectRowUnchanged(stores, a.id, baseline);
    expect(await stores.eventStore.get(ctx, event.id)).toEqual(eventBaseline);
  });

  it("restoreSupersededBy: restored の要素を書き換えても、store は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const old = await seed(stores);
    const next = await seed(stores);
    await stores.memoryStore.updateStatus(ctx, old.id, "superseded", { supersededById: next.id });
    const { restored } = await stores.memoryStore.restoreSupersededBy!(ctx, next.id, {
      reason: "r",
      at: new Date(T1),
    });
    expect(restored.map((m) => m.id)).toEqual([old.id]);
    const baseline = liveClone(stores, old.id);
    expect(baseline.status).toBe("active");
    scribble(restored);
    await expectRowUnchanged(stores, old.id, baseline);
  });

  const query = (excludeMemoryId: string) => ({
    subjectId: null,
    claimKey: { subject: "s", predicate: "p" },
    excludeMemoryId,
    contentHash: "other-hash",
    validFrom: null,
    validUntil: null,
  });

  it("findActiveByClaimKey: 返した要素を書き換えても、store は変わらない", async () => {
    const { stores, a, b } = await pair();
    const baseline = liveClone(stores, b.id);
    const found = await stores.memoryStore.findActiveByClaimKey!(ctx, query(a.id));
    expect(found.map((m) => m.id)).toEqual([b.id]);
    scribble(found);
    await expectRowUnchanged(stores, b.id, baseline);
  });

  it("findContestedByClaimKey: 返した要素を書き換えても、store は変わらない", async () => {
    const { stores, a, b } = await pair();
    await stores.memoryStore.markContestedPair!(
      ctx,
      { id: a.id, event: eventInput(a.id, { kind: "updated" }) },
      { id: b.id, event: eventInput(b.id, { kind: "updated" }) },
    );
    const baseline = liveClone(stores, b.id);
    const found = await stores.memoryStore.findContestedByClaimKey!(ctx, query(a.id));
    expect(found.map((m) => m.id)).toEqual([b.id]);
    scribble(found);
    await expectRowUnchanged(stores, b.id, baseline);
  });

  describe("対照", () => {
    it("markContestedPair が書いたことは get に届いていて、返り値と同じ中身（相互参照・Date のまま）", async () => {
      const { stores, a, b } = await pair();
      const { first, second, events } = await stores.memoryStore.markContestedPair!(
        ctx,
        { id: a.id, event: eventInput(a.id, { kind: "updated" }) },
        { id: b.id, event: eventInput(b.id, { kind: "updated" }) },
      );
      const ga = (await stores.memoryStore.get(ctx, a.id))!;
      const gb = (await stores.memoryStore.get(ctx, b.id))!;
      expect(ga.status).toBe("contested");
      expect(ga.contestedWithId).toBe(b.id);
      expect(gb.contestedWithId).toBe(a.id);
      expect(first).toEqual(ga);
      expect(second).toEqual(gb);
      expect(events.map((e) => e.id)).toEqual(
        (await stores.eventStore.list(ctx, {})).map((e) => e.id),
      );
      expect(events[0]?.at).toBeInstanceOf(Date);
      expect(Object.isFrozen(first)).toBe(false);
    });

    it("resolveContestedPair・resolveOrphanedContested・restoreSupersededBy が書いたことは get に届いている", async () => {
      const { stores, a, b } = await pair();
      await stores.memoryStore.markContestedPair!(
        ctx,
        { id: a.id, event: eventInput(a.id, { kind: "updated" }) },
        { id: b.id, event: eventInput(b.id, { kind: "updated" }) },
      );
      await stores.memoryStore.resolveContestedPair!(
        ctx,
        { id: a.id, status: "active", event: eventInput(a.id) },
        { id: b.id, status: "superseded", supersededById: a.id, event: eventInput(b.id) },
      );
      expect((await stores.memoryStore.get(ctx, a.id))?.status).toBe("active");
      expect((await stores.memoryStore.get(ctx, a.id))?.contestedWithId).toBeNull();
      expect((await stores.memoryStore.get(ctx, b.id))?.status).toBe("superseded");

      const { restored } = await stores.memoryStore.restoreSupersededBy!(ctx, a.id, {
        at: new Date(T1),
      });
      expect(restored[0]).toEqual(await stores.memoryStore.get(ctx, b.id));
      expect((await stores.memoryStore.get(ctx, b.id))?.status).toBe("active");

      await stores.memoryStore.markContestedPair!(
        ctx,
        { id: a.id, event: eventInput(a.id, { kind: "updated" }) },
        { id: b.id, event: eventInput(b.id, { kind: "updated" }) },
      );
      const { memory } = await stores.memoryStore.resolveOrphanedContested!(ctx, {
        id: a.id,
        contestedWithId: b.id,
        event: eventInput(a.id),
      });
      expect(memory.status).toBe("active");
      expect(await stores.memoryStore.get(ctx, a.id)).toEqual(memory);
    });

    it("markContestedGroup・resolveContestedGroup が書いたことは get に届いている", async () => {
      const { stores, a, b, c } = await trio();
      const marked = await stores.memoryStore.markContestedGroup!(
        ctx,
        [a, b, c].map((m) => ({ id: m.id, event: eventInput(m.id, { kind: "updated" }) })),
      );
      for (const m of marked.members) {
        expect(m.status).toBe("contested");
        expect(await stores.memoryStore.get(ctx, m.id)).toEqual(m);
      }
      const resolved = await stores.memoryStore.resolveContestedGroup!(ctx, [
        { id: a.id, status: "active", event: eventInput(a.id) },
        { id: b.id, status: "active", event: eventInput(b.id) },
        { id: c.id, status: "active", event: eventInput(c.id) },
      ]);
      for (const m of resolved.members) {
        expect(m.status).toBe("active");
        expect(await stores.memoryStore.get(ctx, m.id)).toEqual(m);
      }
    });

    it("find*ByClaimKey の返り値は get と同じ中身（claimKey・Date を含む）", async () => {
      const { stores, a, b } = await pair();
      const [found] = await stores.memoryStore.findActiveByClaimKey!(ctx, query(a.id));
      expect(found).toEqual(await stores.memoryStore.get(ctx, b.id));
      expect(found?.claimKey).toEqual({ subject: "s", predicate: "p" });
      expect(found?.validFrom).toBeInstanceOf(Date);
      expect(Object.isFrozen(found)).toBe(false);
    });
  });
});

describe("FakeEventStore の append・list は、返り値の書き換えから行を守る（ADR 0578）", () => {
  async function setup() {
    const stores = createFakeRuntimeStores();
    const created = await seed(stores);
    return { stores, created };
  }

  it("append: 返り値を書き換えても、get・list は変わらない", async () => {
    const { stores, created } = await setup();
    const appended = await stores.eventStore.append(ctx, eventInput(created.id));
    const baseline = structuredClone((await stores.eventStore.get(ctx, appended.id))!);
    scribble(appended);
    expect(await stores.eventStore.get(ctx, appended.id)).toEqual(baseline);
    expect(await stores.eventStore.list(ctx, {})).toEqual([baseline]);
  });

  it("list: 返した要素を書き換えても、次の list・get は変わらない", async () => {
    const { stores, created } = await setup();
    const e1 = await stores.eventStore.append(ctx, eventInput(created.id));
    await stores.eventStore.append(
      ctx,
      eventInput(created.id, { at: new Date(T1), meta: { reason: "second", ids: ["x"] } }),
    );
    const baseline = structuredClone(await stores.eventStore.list(ctx, {}));
    expect(baseline).toHaveLength(2);
    scribble(await stores.eventStore.list(ctx, {}));
    expect(await stores.eventStore.list(ctx, {})).toEqual(baseline);
    expect(await stores.eventStore.get(ctx, e1.id)).toEqual(baseline[0]);
  });

  it("list: limit で切った結果を書き換えても、store は変わらない", async () => {
    const { stores, created } = await setup();
    await stores.eventStore.append(ctx, eventInput(created.id));
    await stores.eventStore.append(ctx, eventInput(created.id, { at: new Date(T1) }));
    const baseline = structuredClone(await stores.eventStore.list(ctx, {}));
    scribble(await stores.eventStore.list(ctx, { limit: 1 }));
    expect(await stores.eventStore.list(ctx, {})).toEqual(baseline);
  });

  describe("対照", () => {
    it("append が書いたことは get・list に届いていて、返り値と同じ中身（at は Date のまま、list は at 昇順）", async () => {
      const { stores, created } = await setup();
      const late = await stores.eventStore.append(
        ctx,
        eventInput(created.id, { at: new Date(T1), meta: { reason: "late" } }),
      );
      const early = await stores.eventStore.append(ctx, eventInput(created.id));
      expect(await stores.eventStore.get(ctx, early.id)).toEqual(early);
      const listed = await stores.eventStore.list(ctx, {});
      expect(listed).toEqual([early, late]);
      expect(listed[0]?.at).toBeInstanceOf(Date);
      expect(listed[0]?.meta).toEqual(eventInput(created.id).meta);
      expect(Object.isFrozen(listed[0])).toBe(false);
      expect(Object.isFrozen(listed[0]?.meta)).toBe(false);
    });

    it("list の filter（memoryId・kind）は書き換えた後も効く／events getter は行そのもの（検査用の口）", async () => {
      const { stores, created } = await setup();
      const other = await seed(stores);
      await stores.eventStore.append(ctx, eventInput(created.id));
      await stores.eventStore.append(ctx, eventInput(other.id, { kind: "archived" }));
      expect(await stores.eventStore.list(ctx, { memoryId: other.id })).toHaveLength(1);
      expect(await stores.eventStore.list(ctx, { kind: "archived" })).toHaveLength(1);
      expect(stores.eventStore.events).toHaveLength(2);
    });
  });
});

describe("入力の claimKey も、保存するときに写される（ADR 0578）", () => {
  it("createMemory: 渡した claimKey を後から書き換えても、保存した値は変わらない", async () => {
    const stores = createFakeRuntimeStores();
    const claimKey = { subject: "s", predicate: "p" };
    const created = await stores.memoryStore.createMemory(ctx, newMemory({ claimKey }));
    claimKey.predicate = "mutated-by-caller";
    expect((await stores.memoryStore.get(ctx, created.id))?.claimKey).toEqual({
      subject: "s",
      predicate: "p",
    });
  });
});

describe("supersedeWithNewMemories の created[].jobs と superseded の event も、返り値の書き換えから行を守る（ADR 0583）", () => {
  async function setup() {
    const stores = createFakeRuntimeStores();
    const old = await seed(stores, { content: "old" });
    const result = await stores.memoryStore.supersedeWithNewMemories!(
      ctx,
      [{ input: newMemory({ content: "new", claimKey: null }), jobKinds: ["embed", "extract"] }],
      [{ id: old.id, supersededByIndex: 0, event: eventInput(old.id) }],
    );
    return { stores, old, result };
  }

  const claimAll = (stores: Stores) =>
    stores.outboxStore.claimBatch(ctx, {
      limit: 10,
      now: new Date(Date.now() + 1000),
      claimedBy: "w",
      leaseMs: 60_000,
    });

  it("created[].jobs を書き換えても、listJobs・claimBatch は変わらない", async () => {
    const { stores, result } = await setup();
    const jobsBaseline = structuredClone(stores.outboxStore.listJobs(ctx));
    expect(jobsBaseline).toHaveLength(2);
    scribble(result.created);
    expect(stores.outboxStore.listJobs(ctx)).toEqual(jobsBaseline);
    const claimed = await claimAll(stores);
    expect(claimed.map((j) => j.payload)).toEqual(jobsBaseline.map((j) => j.payload));
    expect(claimed.map((j) => j.availableAt)).toEqual(jobsBaseline.map((j) => j.availableAt));
    expect(claimed.every((j) => j.availableAt.getTime() !== 0)).toBe(true);
  });

  it("superseded の event を書き換えても、eventStore の get・list は変わらない", async () => {
    const { stores, result } = await setup();
    expect(result.superseded).toHaveLength(1);
    const eventId = result.superseded[0]!.id;
    const baseline = structuredClone((await stores.eventStore.get(ctx, eventId))!);
    scribble(result.superseded);
    expect(await stores.eventStore.get(ctx, eventId)).toEqual(baseline);
    expect(await stores.eventStore.list(ctx, {})).toEqual([baseline]);
    expect(stores.eventStore.events).toEqual([baseline]);
  });

  describe("対照", () => {
    it("jobs は store の job と同じ id・中身で（Date は Date のまま）、claimBatch に見える。凍結されていない", async () => {
      const { stores, result } = await setup();
      const jobs = result.created[0]!.jobs;
      expect(jobs).toHaveLength(2);
      expect(stores.outboxStore.listJobs(ctx)).toEqual(jobs);
      expect(jobs[0]?.payload).toEqual({ memoryId: result.created[0]!.memory.id });
      expect(jobs[0]?.availableAt).toBeInstanceOf(Date);
      expect(jobs[0]?.createdAt).toBeInstanceOf(Date);
      expect(Object.isFrozen(jobs[0])).toBe(false);
      const claimed = await claimAll(stores);
      expect(claimed.map((j) => j.id).sort()).toEqual(jobs.map((j) => j.id).sort());
    });

    it("event は eventStore と同じ中身（at は Date のまま、meta.supersededById は作った記憶の id）で、superseded 側の行は get で superseded", async () => {
      const { stores, old, result } = await setup();
      const event = result.superseded[0]!;
      expect(await stores.eventStore.get(ctx, event.id)).toEqual(event);
      expect(event.at).toBeInstanceOf(Date);
      expect(event.meta["supersededById"]).toBe(result.created[0]!.memory.id);
      expect(event.memoryId).toBe(old.id);
      expect(Object.isFrozen(event)).toBe(false);
      expect(Object.isFrozen(event.meta)).toBe(false);
      const oldRow = await stores.memoryStore.get(ctx, old.id);
      expect(oldRow?.status).toBe("superseded");
      expect(oldRow?.supersededById).toBe(result.created[0]!.memory.id);
    });
  });
});
