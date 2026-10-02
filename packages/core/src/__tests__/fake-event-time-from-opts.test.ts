import { afterEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import type { NewMemoryEvent } from "../event.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0563: `FakeMemoryStore` の `archiveDecayed` が積む `archived` イベントの `at` と、`purgeMemory` の `purgedAt` の時刻を、
 * `InMemoryMemoryStore`・`PostgresMemoryStore` と同じ値にする歯。
 *
 * - `archiveDecayed`: 積む `archived` イベントの `at` は `opts.now`（壁時計ではない）。
 * - `purgeMemory`: `event.at` を渡すと `purgedAt` にも同じ値を使う。省略すると、`purgedAt` と `event.at` は壁時計を1回だけ読んだ同じ値。
 * - 対照: `event.at` を省略しても断らない（渡されない時まで要求する実装は、ここで赤になる）。
 *
 * **testkit の適合テストの対象ではない**（Issue #768 コメント2: Fake は適合テストに通さず、直したものは専用の `fake-*.test.ts` で縛る）。
 * 対応する適合テストの名前は、各 `describe` の先頭に書いた。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
let hashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  hashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `event-time-from-opts-${hashCounter}`,
    digest: "要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

/** Date の引数なしコンストラクタが、読むたびに1ms進む壁時計（同じ呼び出しの中で読み直すと値が割れる）。 */
function stubTickingWallClock(startMs: number): void {
  const RealDate = Date;
  let n = 0;
  class TickingDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(startMs + n++);
      } else {
        super(...(args as [number]));
      }
    }
  }
  vi.stubGlobal("Date", TickingDate);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function purgeEvent(memoryId: string, digest: string, at?: Date): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "purged",
    ...(at !== undefined ? { at } : {}),
    actor: { type: "system" },
    digestSnapshot: digest,
    meta: {},
  };
}

describe("FakeMemoryStore.archiveDecayed が積む archived イベントの at（ADR 0563）", () => {
  // 適合テスト: 「archiveDecayed が積む archived イベントの at は opts.now と同じ値になる（壁時計ではない）」
  it("at は opts.now と同じ値になる（壁時計ではない）", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const now = new Date("2031-01-01T00:00:00.000Z");
    const decayed = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(now.getTime() - 1_000) }),
    );

    await memoryStore.archiveDecayed!(ctx, { now, limit: 10 });

    const events = await eventStore.list(ctx, { memoryId: decayed.id });
    expect(events.map((e) => ({ kind: e.kind, at: e.at }))).toEqual([
      { kind: "archived", at: now },
    ]);
  });

  it("複数件を一度に archive しても、全部の archived イベントの at が opts.now になる（壁時計が進んでも割れない）", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const now = new Date("2031-01-01T00:00:00.000Z");
    const a = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(now.getTime() - 2_000) }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(now.getTime() - 1_000) }),
    );
    stubTickingWallClock(Date.UTC(2020, 0, 1));

    await memoryStore.archiveDecayed!(ctx, { now, limit: 10 });

    for (const memory of [a, b]) {
      const events = await eventStore.list(ctx, { memoryId: memory.id });
      expect(events.map((e) => e.at)).toEqual([now]);
    }
  });

  it("対照: 掃く対象でない Memory には archived イベントを積まない（at の直しが選別に響かない）", async () => {
    const { memoryStore, eventStore } = createFakeRuntimeStores();
    const now = new Date("2031-01-01T00:00:00.000Z");
    const fresh = await memoryStore.createMemory(
      ctx,
      newMemory({ decayFloorAt: new Date(now.getTime() + 1_000) }),
    );

    const result = await memoryStore.archiveDecayed!(ctx, { now, limit: 10 });

    expect(result.archived).toEqual([]);
    expect(await eventStore.list(ctx, { memoryId: fresh.id })).toEqual([]);
  });
});

describe("FakeMemoryStore.purgeMemory の purgedAt（ADR 0563）", () => {
  // 適合テスト: 「purgeMemory は event.at を渡すと、purgedAt にも同じ値を使う」
  it("event.at を渡すと、purgedAt にも同じ値を使う", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const at = new Date("2020-01-01T00:00:00.000Z");

    const { memory: returned, event } = await memoryStore.purgeMemory!(
      ctx,
      memory.id,
      { content: "[purged]", digest: "[purged]" },
      purgeEvent(memory.id, memory.digest, at),
    );

    expect(event.at).toEqual(at);
    expect(returned.purgedAt).toEqual(at);
    expect((await memoryStore.get(ctx, memory.id))?.purgedAt).toEqual(at);
  });

  // 適合テスト: 「purgeMemory は event.at を省略すると、purgedAt と event.at は同じ壁時計の値になる」（Fake は元から通っていたが、直したあとも守る）
  it("対照: event.at を省略しても断らず、purgedAt と event.at は壁時計を1回だけ読んだ同じ値になる", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    // 読むたびに1ms進む壁時計。2回読むと purgedAt と event.at が割れる。
    const start = Date.UTC(2030, 5, 1);
    stubTickingWallClock(start);

    const { memory: returned, event } = await memoryStore.purgeMemory!(
      ctx,
      memory.id,
      { content: "[purged]", digest: "[purged]" },
      purgeEvent(memory.id, memory.digest),
    );

    expect(returned.purgedAt).toEqual(event.at);
    expect(event.at.getTime()).toBeGreaterThanOrEqual(start);
  });

  it("対照: event.at を省略すると、purgedAt は呼ぶ前と後の間の壁時計になる", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(ctx, newMemory({ status: "forgotten" }));
    const before = Date.now();

    const { memory: returned } = await memoryStore.purgeMemory!(
      ctx,
      memory.id,
      { content: "[purged]", digest: "[purged]" },
      purgeEvent(memory.id, memory.digest),
    );

    expect(returned.purgedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(returned.purgedAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("FakeMemoryStore.purgeMemory は recalls.index_band の digestBand から digest を伏せる（ADR 0375・0563）", () => {
  // 適合テスト: 「purgeMemory は recalls.index_band の digestBand から、この memoryId の digest を伏せる（ADR 0375 決定3・決定4）」
  // **この歯は直す前から緑である**（ADR 0563 に書いたとおり、適合テストの赤は伏せ方の欠落ではなく、
  // `createMemory` が返す `Memory` が store の中の行そのものだったこと〔ADR 0562 の範囲〕による）。
  // 適合テストが `memory.digest`（purge で書き換わる）を期待値に使うために赤になる。ここでは purge の前に digest の文字列を控えて比べる。
  it("同じテナントの digestBand の該当 memoryId だけを伏せ、他の memoryId・他テナントの行は変えない", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const otherCtx: Ctx = { tenantId: "tenant-other" };
    const secret = "秘密の目次帯要旨";
    const target = await memoryStore.createMemory(
      ctx,
      newMemory({ status: "forgotten", digest: secret }),
    );
    const untouched = await memoryStore.createMemory(ctx, newMemory({ digest: "触らない要旨" }));
    const targetId = target.id;
    const untouchedId = untouched.id;
    const usage = {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic" as const,
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    };
    const record = (tenantId: string, digestBand: Array<Record<string, unknown>>) => ({
      tenantId,
      subjectId: null,
      query: { text: "q" },
      budget: null,
      omitted: [],
      usage,
      indexBand: {
        groups: [],
        totalInScope: digestBand.length,
        countKind: "exact" as const,
        digestBand,
      },
      explain: { stages: [] },
      returnedMemories: [],
    });
    const recallId = await memoryStore.createRecall(
      ctx,
      record("tenant-1", [
        { memoryId: targetId, digest: secret },
        { memoryId: untouchedId, digest: "触らない要旨", truncated: true },
      ]) as never,
    );
    const otherRecallId = await memoryStore.createRecall(
      otherCtx,
      record("tenant-other", [{ memoryId: targetId, digest: secret }]) as never,
    );

    await memoryStore.purgeMemory!(
      ctx,
      targetId,
      { content: "[purged]", digest: "[purged]" },
      purgeEvent(targetId, secret),
    );

    expect((await memoryStore.getRecall(ctx, recallId))?.indexBand.digestBand).toEqual([
      { memoryId: targetId, digest: "[purged]" },
      { memoryId: untouchedId, digest: "触らない要旨", truncated: true },
    ]);
    expect((await memoryStore.getRecall(otherCtx, otherRecallId))?.indexBand.digestBand).toEqual([
      { memoryId: targetId, digest: secret },
    ]);
  });
});
