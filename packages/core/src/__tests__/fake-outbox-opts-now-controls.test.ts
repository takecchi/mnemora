import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import type { NewObservation } from "../observation.js";
import type { OutboxJobRecord } from "../outbox.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0565: `fake-outbox-opts-now.test.ts`（ADR 0555）が縛らなかった「やりすぎ」と「外す」の側を縛る歯。
 * 既存のファイルは「`opts.now` を渡したら outbox 行の時刻がその値になる」側だけを見ていたので、
 * 次の誤りを入れても緑のままだった（変異試験で実測。表は ADR 0565）。
 *
 *  - A: `opts.now` が outbox 行の時刻を越えて `memory.updatedAt` にまで効く（約束では `updatedAt` は壁時計のまま）
 *  - I: `opts.now` が記憶・observation の `recordedAt` の既定にまで効く（約束が従わせるのは outbox 行の時刻だけ）
 *  - F: 冪等な再送（`created: false`）でも、`opts` を先に検査して断る（ADR 0493: 行を実際に書くときだけ見る）
 *  - D: `supersedeWithNewMemories` が、先頭の news だけを検査する
 *  - H: `enqueueJob` が、行ごとの `Date` の複製を持たず、`opts.now` や他の行と同じ参照を共有する
 *  - C: `jobKinds` が空なら `opts` を見ない、を `createObservationWithOutbox`・`supersedeWithNewMemories` でも
 *
 * 期待値は testkit の `InMemoryMemoryStore` と `PostgresMemoryStore` の振る舞い（約束）に合わせてある。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const PAST = new Date("2020-01-01T00:00:00.000Z");
const INPUT_RECORDED_AT = new Date("2019-05-05T00:00:00.000Z");
const invalid = new Date(Number.NaN);

let hashCounter = 0;
function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `controls-hash-${hashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: INPUT_RECORDED_AT,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

/** 冪等キーは `sourceObservationId` が非 null のときだけ効く（null は衝突しない）。実在の observation を指す記憶を作る。 */
async function resendableMemory(memoryStore: Stores["memoryStore"]): Promise<NewMemory> {
  const observation = await memoryStore.createObservation(ctx, newObservation("ext-for-mem"));
  return newMemory({
    sourceObservationId: observation.id,
    extractorVersion: "v1",
    provenance: {
      kind: "stated",
      sourceObservationId: observation.id,
      at: "2026-01-01T00:00:00.000Z",
    },
  });
}

function newObservation(externalId: string | null = null): NewObservation {
  return { tenantId: ctx.tenantId, subjectId: null, externalId, kind: "utterance", payload: {} };
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

type Stores = ReturnType<typeof createFakeRuntimeStores>;

const NUL_KIND = "embed\u0000" as never;

describe("FakeMemoryStore: opts.now は outbox 行の時刻だけに効く（ADR 0565。変異 A・I）", () => {
  it("requeueEmbedJobs は、writeOpts.now を渡しても memory.updatedAt を壁時計のままにする（Postgres は now()）", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory());
    const before = Date.now();
    await memoryStore.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 10 }, { now: PAST });
    const after = Date.now();
    const updatedAt = (await memoryStore.get(ctx, memory.id))!.updatedAt.getTime();
    expect(updatedAt).toBeGreaterThanOrEqual(before);
    expect(updatedAt).toBeLessThanOrEqual(after);
  });

  it("createObservationWithOutbox は、recordedAt が無ければ opts.now ではなく壁時計を使う", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const before = Date.now();
    const { observation } = await memoryStore.createObservationWithOutbox(
      ctx,
      newObservation(),
      ["extract"],
      { now: PAST },
    );
    const after = Date.now();
    expect(observation.recordedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(observation.recordedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("createObservationWithOutbox は、渡された recordedAt をそのまま使う", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const { observation } = await memoryStore.createObservationWithOutbox(
      ctx,
      { ...newObservation(), recordedAt: INPUT_RECORDED_AT },
      ["extract"],
      { now: PAST },
    );
    expect(observation.recordedAt).toEqual(INPUT_RECORDED_AT);
  });

  it("createMemoryWithOutbox は、記憶の recordedAt に opts.now を使わない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const { memory } = await memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"], {
      now: PAST,
    });
    expect(memory.recordedAt).toEqual(INPUT_RECORDED_AT);
  });

  it("supersedeWithNewMemories は、作る記憶の recordedAt に opts.now を使わない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const { created } = await memoryStore.supersedeWithNewMemories(
      ctx,
      [{ input: newMemory(), jobKinds: ["embed"] }],
      [],
      { now: PAST },
    );
    expect(created[0]!.memory.recordedAt).toEqual(INPUT_RECORDED_AT);
  });
});

describe("FakeMemoryStore: 冪等な再送（created: false）は opts を検査しない（ADR 0493。変異 F）", () => {
  it("createMemoryWithOutbox: Invalid Date の opts.now でも再送は断らない", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    const input = await resendableMemory(memoryStore);
    await memoryStore.createMemoryWithOutbox(ctx, input, ["embed"], { now: PAST });
    const r = await memoryStore.createMemoryWithOutbox(ctx, input, ["embed"], { now: invalid });
    expect(r.created).toBe(false);
    expect(r.jobs).toEqual([]);
    expect(outboxStore.listJobs(ctx)).toHaveLength(1);
  });

  it("createMemoryWithOutbox: jobKinds に NUL があっても再送は断らない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const input = await resendableMemory(memoryStore);
    await memoryStore.createMemoryWithOutbox(ctx, input, ["embed"]);
    const r = await memoryStore.createMemoryWithOutbox(ctx, input, [NUL_KIND]);
    expect(r.created).toBe(false);
  });

  it("createObservationWithOutbox: externalId が衝突する再送は、Invalid Date・NUL・claimedBy の NUL でも断らない", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    const input = newObservation("ext-resend");
    await memoryStore.createObservationWithOutbox(ctx, input, ["extract"], { now: PAST });
    for (const [kinds, opts] of [
      [["extract"], { now: invalid }],
      [[NUL_KIND], undefined],
      [["extract"], { claimedBy: "w\u0000" }],
    ] as const) {
      const r = await memoryStore.createObservationWithOutbox(ctx, input, [...kinds], opts);
      expect(r.created).toBe(false);
      expect(r.jobs).toEqual([]);
    }
    expect(outboxStore.listJobs(ctx)).toHaveLength(1);
  });
});

describe("FakeMemoryStore.supersedeWithNewMemories: 冪等な再送の news は opts を検査しない（ADR 0493）", () => {
  // 実測で、今の Fake は赤（本物のずれ）: 全部の news が既存の行に当たる再送でも、Invalid Date の opts.now・
  // jobKinds の NUL を先に断る（`InMemoryMemoryStore`・`PostgresMemoryStore` は行を書くときだけ見る）。
  // 直しは news を作る loop（#1674・ADR 0564 が原子化で書き換えている箇所）に入るので、この PR では直さない（ADR 0565）。
  it.todo(
    "全部の news が既存の行に当たるなら、Invalid Date の opts.now・jobKinds の NUL でも断らない（ADR 0565 の未解決）",
  );
});

describe("FakeMemoryStore.supersedeWithNewMemories: 先頭以外の news も検査する（ADR 0555 決定3。変異 D）", () => {
  it("2件目の jobKinds に NUL があれば、1件目も書かずに断る", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    const first = newMemory();
    await expect(
      memoryStore.supersedeWithNewMemories(
        ctx,
        [
          { input: first, jobKinds: ["embed"] },
          { input: newMemory(), jobKinds: [NUL_KIND] },
        ],
        [],
      ),
    ).rejects.toThrow(/NUL/);
    expect(outboxStore.listJobs(ctx)).toEqual([]);
    // 1件目の記憶も作られていない（同じ入力を送ると、新しく作られる）。
    const again = await memoryStore.createMemoryWithOutbox(ctx, first, ["embed"]);
    expect(again.created).toBe(true);
  });

  it("1件目の jobKinds が空でも、2件目が行を積むなら Invalid Date の opts.now を断る", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    await expect(
      memoryStore.supersedeWithNewMemories(
        ctx,
        [
          { input: newMemory(), jobKinds: [] },
          { input: newMemory(), jobKinds: ["embed"] },
        ],
        [],
        { now: invalid },
      ),
    ).rejects.toThrow(/opts\.now/);
    expect(outboxStore.listJobs(ctx)).toEqual([]);
  });
});

describe("FakeMemoryStore: jobKinds が空なら opts を見ない（ADR 0493。欠け C）", () => {
  it("createObservationWithOutbox は、Invalid Date の opts.now・claimedBy の NUL でも書く", async () => {
    const { memoryStore, outboxStore } = createFakeRuntimeStores();
    const r = await memoryStore.createObservationWithOutbox(ctx, newObservation(), [], {
      now: invalid,
      claimedBy: "w\u0000",
    });
    expect(r.created).toBe(true);
    expect(r.jobs).toEqual([]);
    expect(outboxStore.listJobs(ctx)).toEqual([]);
  });

  it("supersedeWithNewMemories は、全部の news の jobKinds が空なら Invalid Date の opts.now でも書く", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const r = await memoryStore.supersedeWithNewMemories(
      ctx,
      [
        { input: newMemory(), jobKinds: [] },
        { input: newMemory(), jobKinds: [] },
      ],
      [],
      { now: invalid },
    );
    expect(r.created.map((c) => c.created)).toEqual([true, true]);
  });
});

/** 4つの口。`now` を渡して2本以上の outbox 行を積み、`listJobs` で返す。 */
const ports: Array<{
  name: string;
  run: (stores: Stores, now: Date) => Promise<OutboxJobRecord[]>;
}> = [
  {
    name: "createObservationWithOutbox",
    run: async ({ memoryStore, outboxStore }, now) => {
      await memoryStore.createObservationWithOutbox(ctx, newObservation(), ["extract", "embed"], {
        now,
      });
      return outboxStore.listJobs(ctx);
    },
  },
  {
    name: "createMemoryWithOutbox",
    run: async ({ memoryStore, outboxStore }, now) => {
      await memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed", "extract"], { now });
      return outboxStore.listJobs(ctx);
    },
  },
  {
    name: "supersedeWithNewMemories",
    run: async ({ memoryStore, outboxStore }, now) => {
      const old = await memoryStore.createMemory(ctx, newMemory());
      await memoryStore.supersedeWithNewMemories(
        ctx,
        [
          { input: newMemory(), jobKinds: ["embed", "extract"] },
          { input: newMemory(), jobKinds: ["embed"] },
        ],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            expectedStatus: "active",
            event: supersedeEvent(old.id),
          },
        ],
        { now },
      );
      return outboxStore.listJobs(ctx);
    },
  },
  {
    name: "requeueEmbedJobs",
    run: async ({ memoryStore, outboxStore }, now) => {
      await memoryStore.createMemory(ctx, newMemory());
      await memoryStore.createMemory(ctx, newMemory());
      await memoryStore.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 10 }, { now });
      return outboxStore.listJobs(ctx);
    },
  },
];

describe.each(ports)(
  "FakeMemoryStore.$name: 行ごとに Date の複製を持つ（ADR 0555 決定1。変異 H）",
  ({ run }) => {
    it("availableAt・createdAt は、opts.now とも、互いにも、他の行とも別の Date である", async () => {
      const now = new Date(PAST.getTime());
      const jobs = await run(createFakeRuntimeStores(), now);
      expect(jobs.length).toBeGreaterThanOrEqual(2);
      const dates = jobs.flatMap((j) => [j.availableAt, j.createdAt]);
      for (const d of dates) expect(d).not.toBe(now);
      expect(new Set(dates).size).toBe(dates.length);
    });

    it("返された job の Date を書き換えても、opts.now にも他の行にも響かない", async () => {
      const now = new Date(PAST.getTime());
      const jobs = await run(createFakeRuntimeStores(), now);
      jobs[0]!.availableAt.setTime(0);
      jobs[0]!.createdAt.setTime(0);
      expect(now.getTime()).toBe(PAST.getTime());
      for (const other of jobs.slice(1)) {
        expect(other.availableAt.getTime()).toBe(PAST.getTime());
        expect(other.createdAt.getTime()).toBe(PAST.getTime());
      }
    });
  },
);
