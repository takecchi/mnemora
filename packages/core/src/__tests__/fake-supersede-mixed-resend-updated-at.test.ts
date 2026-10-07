import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const PAST = new Date("2020-01-01T00:00:00.000Z");
const WALL = new Date("2026-06-01T12:34:56.789Z");
const NUL_KIND = "embed\u0000" as never;

let hashCounter = 0;
function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `mixed-hash-${hashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: PAST,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

function supersedeEvent(memoryId: string): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "superseded",
    actor: { type: "system" },
    digestSnapshot: "digest",
    sizeBeforeBytes: null,
    meta: { reason: "test" },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FakeMemoryStore.supersedeWithNewMemories: 再送と新規が混ざったバッチ（ADR 0577・ADR 0493。変異 M7）", () => {
  it("再送の news の jobKinds に NUL があっても断らない。再送は created:false、新規は created:true で積む", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    const observation = await memoryStore.createObservation(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      externalId: "ext-mixed",
      kind: "utterance",
      payload: {},
    });
    // 冪等キーは sourceObservationId が非 null のときだけ効く。
    const resendInput = newMemory({
      sourceObservationId: observation.id,
      extractorVersion: "v1",
      provenance: {
        kind: "stated",
        sourceObservationId: observation.id,
        at: "2026-01-01T00:00:00.000Z",
      },
    });
    const first = await memoryStore.createMemory(ctx, resendInput);

    const result = await memoryStore.supersedeWithNewMemories(
      ctx,
      [
        { input: resendInput, jobKinds: [NUL_KIND] }, // 再送: 既存の行に当たるので jobKinds は見ない
        { input: newMemory(), jobKinds: ["embed"] }, // 新規: 見る（正当）
      ],
      [],
    );

    expect(result.created.map((c) => c.created)).toEqual([false, true]);
    expect(result.created[0]!.memory.id).toBe(first.id);
    expect(result.created[0]!.jobs).toEqual([]);
    expect(result.created[1]!.jobs.map((j) => j.kind)).toEqual(["embed"]);
    // 新規の分だけ outbox に積む（再送の NUL の job は積まれない）。
    expect(outboxStore.listJobs(ctx).map((j) => j.kind)).toEqual(["embed"]);
  });
});

describe("FakeMemoryStore.supersedeWithNewMemories: 古い記憶の updatedAt は壁時計（ADR 0566 A。変異 M24）", () => {
  it("opts.now を過去に固定しても、置き換えられた記憶の updatedAt は壁時計（opts.now ではない）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const old = await memoryStore.createMemory(ctx, newMemory());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WALL);

    const result = await memoryStore.supersedeWithNewMemories(
      ctx,
      [{ input: newMemory(), jobKinds: ["embed"] }],
      [
        {
          id: old.id,
          supersededByIndex: 0,
          expectedStatus: "active",
          event: supersedeEvent(old.id),
        },
      ],
      { now: PAST },
    );

    expect(result.superseded).toHaveLength(1);
    const after = (await memoryStore.get(ctx, old.id))!;
    expect(after.status).toBe("superseded");
    expect(after.updatedAt).toEqual(WALL);
    // outbox 行の時刻は opts.now のまま（約束の取り違えを防ぐ陽性対照）。
    expect(result.created[0]!.jobs[0]!.createdAt).toEqual(PAST);
  });
});

describe("FakeMemoryStore.supersedeWithNewMemories: 古い記憶の createdAt は変わらない（ADR 0592。クローンの判断で不変条件として縛る）", () => {
  it("置き換えで updatedAt は壁時計へ進むが、createdAt は作ったときのまま（後から書き換わらない）", async () => {
    // 作成時刻が後から書き換わらないことを縛る: `updatedAt` と一緒に `createdAt` も `new Date()` で書き換える実装は、他の歯では捕まらない。
    const CREATED = new Date("2026-05-01T00:00:00.000Z");
    const { memoryStore } = createFakeRuntimeStores();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CREATED);
    const old = await memoryStore.createMemory(ctx, newMemory());
    expect(old.createdAt).toEqual(CREATED);
    vi.setSystemTime(WALL);

    const result = await memoryStore.supersedeWithNewMemories(
      ctx,
      [{ input: newMemory(), jobKinds: ["embed"] }],
      [
        {
          id: old.id,
          supersededByIndex: 0,
          expectedStatus: "active",
          event: supersedeEvent(old.id),
        },
      ],
    );

    expect(result.superseded).toHaveLength(1);
    const after = (await memoryStore.get(ctx, old.id))!;
    expect(after.status).toBe("superseded");
    expect(after.updatedAt).toEqual(WALL); // 陽性対照: 置き換えは updatedAt を進める
    expect(after.createdAt).toEqual(CREATED);
  });
});

describe("FakeMemoryStore.supersedeWithNewMemories: CAS で弾かれた行は updatedAt も createdAt も書き換わらない（ADR 0592。クローンの判断で不変条件として縛る）", () => {
  it("expectedStatus が合わず conflicted に積まれた古い記憶は、置き換えの前後で updatedAt・createdAt が同じ", async () => {
    // 弾かれた行には何も書かないことを縛る。
    const CREATED = new Date("2026-05-01T00:00:00.000Z");
    const MID = new Date("2026-05-15T00:00:00.000Z");
    const { memoryStore } = createFakeRuntimeStores();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CREATED);
    const old = await memoryStore.createMemory(ctx, newMemory());
    vi.setSystemTime(MID);
    await memoryStore.updateStatus(ctx, old.id, "archived");
    const before = (await memoryStore.get(ctx, old.id))!;
    expect(before.status).toBe("archived");
    expect(before.updatedAt).toEqual(MID);
    vi.setSystemTime(WALL);

    const result = await memoryStore.supersedeWithNewMemories(
      ctx,
      [{ input: newMemory(), jobKinds: ["embed"] }],
      [
        {
          id: old.id,
          supersededByIndex: 0,
          expectedStatus: "active", // 実際は archived なので弾かれる
          event: supersedeEvent(old.id),
        },
      ],
    );

    expect(result.superseded).toEqual([]);
    expect(result.conflicted).toEqual([{ id: old.id, observedStatus: "archived" }]);
    const after = (await memoryStore.get(ctx, old.id))!;
    expect(after.status).toBe("archived");
    expect(after.updatedAt).toEqual(MID);
    expect(after.createdAt).toEqual(CREATED);
  });
});
