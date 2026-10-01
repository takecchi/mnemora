import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  FindCorrectionCandidatesResult,
  MemoryStore,
  Runtime,
} from "@mnemora/core";
import { buildCorrectionReason, createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture, DeterministicLLMProvider } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `Runtime.applyCorrection`・`buildCorrectionReason` の2つの穴（ADR 0446、穴探し21巡目）の歯。
 *
 * 1. `supersede` の `winnerId` が2つの id のどちらでもないとき、`resolveContested` の `RangeError` は
 *    `markContested` が書いた**後**に投げられ、例外で終わったのに対（`contested` 2件 + `updated` 2件）が残っていた。
 *    ⟹ 書き込む前に落とす。
 * 2. `correctedId` が候補の id と大文字小文字だけ違うとき、`@mnemora/postgres` では `markContested` は受け付けるのに
 *    `applyCorrection` だけが `not_a_candidate` にしていた（文字列の完全一致）。⟹ store が同じ記憶と言えば候補として扱う。
 * 3. `buildCorrectionReason` は `winnerId === correctingId` の完全一致だけで `winner=correcting` を決めていた。
 *    大文字の `winnerId`（`@mnemora/postgres` の `resolveContested` は勝者として受け付ける）では、実際に勝ったのが訂正する側でも
 *    `winner=corrected` と書いていた。
 *
 * testkit の fixture の id は大文字小文字を区別するので、2 は fixture では今どおり `not_a_candidate`。
 */
afterAll(async () => {
  await closeTestClient();
});

const upper = (id: string) => id.toUpperCase();

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
  caseInsensitive: boolean;
}

const shared = {
  llmProvider: new DeterministicLLMProvider(),
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の fixture",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        caseInsensitive: false,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        eventStore,
        caseInsensitive: true,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore: new PostgresVectorStore(db),
          eventStore,
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "tenant-apply-correction-case" };

function discoveryOf(ids: string[]): FindCorrectionCandidatesResult {
  return {
    recallId: "recall-1" as FindCorrectionCandidatesResult["recallId"],
    candidates: ids.map((memoryId, i) => ({
      memoryId,
      digest: "d",
      recallRank: i + 1,
      score: {} as never,
      retrievedVia: "ann" as never,
    })),
    omitted: [],
    explain: { stages: [] },
    outcome: ids.length > 0 ? "candidates" : "no_candidates",
    recalledCount: ids.length,
    excludedCount: 0,
  };
}

describe.each(KITS)("applyCorrection の大文字の id と書き込み前の検査（%s）", (_name, makeKit) => {
  const create = (kit: Kit, contentHash: string) =>
    kit.memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash }),
    );
  const snapshot = async (kit: Kit, ids: string[]) =>
    Promise.all(
      ids.map(async (id) => ({
        status: (await kit.memoryStore.get(ctx, id))?.status,
        events: (await kit.eventStore.list(ctx, { memoryId: id })).length,
      })),
    );

  it("supersede の winnerId がどちらの id でもなければ、RangeError で落ち、何も書かない（mark の後に落ちて対が残らない）", async () => {
    const kit = await makeKit();
    const a = await create(kit, "w-a");
    const b = await create(kit, "w-b");
    const c = await create(kit, "w-c");

    await expect(
      kit.runtime.applyCorrection(ctx, {
        discovery: discoveryOf([a.id]),
        correctedId: a.id,
        correctingId: b.id,
        resolution: { kind: "supersede", winnerId: c.id },
      }),
    ).rejects.toThrow(RangeError);

    expect(await snapshot(kit, [a.id, b.id, c.id])).toEqual([
      { status: "active", events: 0 },
      { status: "active", events: 0 },
      { status: "active", events: 0 },
    ]);
  });

  it("correctedId が候補の id と大文字小文字だけ違うとき、store が同じ記憶と言えば候補として扱い、対にして解決する（言わなければ今どおり not_a_candidate）", async () => {
    const kit = await makeKit();
    const a = await create(kit, "u-a");
    const b = await create(kit, "u-b");

    const result = await kit.runtime.applyCorrection(ctx, {
      discovery: discoveryOf([a.id]),
      correctedId: upper(a.id),
      correctingId: b.id,
      resolution: { kind: "supersede", winnerId: b.id },
    });

    if (kit.caseInsensitive) {
      expect(result.kind).toBe("resolved");
      expect(await snapshot(kit, [a.id, b.id])).toEqual([
        { status: "superseded", events: 2 },
        { status: "active", events: 2 },
      ]);
    } else {
      expect(result).toEqual({ kind: "not_a_candidate", correctedId: upper(a.id) });
      expect(await snapshot(kit, [a.id, b.id])).toEqual([
        { status: "active", events: 0 },
        { status: "active", events: 0 },
      ]);
    }
  });

  it("大文字小文字を無視して一致する候補が別の記憶なら、候補として扱わない（存在しない id・別の記憶）", async () => {
    const kit = await makeKit();
    const a = await create(kit, "n-a");
    const b = await create(kit, "n-b");
    const ghost = a.id.replace(/^./, (ch) => (ch === "0" ? "1" : "0")).toUpperCase();

    const result = await kit.runtime.applyCorrection(ctx, {
      discovery: discoveryOf([a.id]),
      correctedId: ghost,
      correctingId: b.id,
    });

    expect(result).toEqual({ kind: "not_a_candidate", correctedId: ghost });
    expect(await snapshot(kit, [a.id, b.id])).toEqual([
      { status: "active", events: 0 },
      { status: "active", events: 0 },
    ]);
  });
});

describe("buildCorrectionReason: supersede の winner は大文字小文字だけ違う id でも実際の勝者を指す", () => {
  const discovery = discoveryOf(["aaaaaaaa-0000-4000-8000-000000000001"]);
  const corrected = "aaaaaaaa-0000-4000-8000-000000000001";
  const correcting = "bbbbbbbb-0000-4000-8000-000000000002";
  const reasonFor = (correctedId: string, correctingId: string, winnerId: string) =>
    buildCorrectionReason({
      discovery,
      chosenRecallRank: 1,
      correctedId,
      correctingId,
      resolution: { kind: "supersede", winnerId },
    });

  it("winnerId が correctingId の大文字なら winner=correcting", () => {
    expect(reasonFor(corrected, correcting, upper(correcting))).toMatch(/winner=correcting$/);
  });
  it("correctingId が大文字で winnerId が小文字でも winner=correcting", () => {
    expect(reasonFor(corrected, upper(correcting), correcting)).toMatch(/winner=correcting$/);
  });
  it("winnerId が correctedId の大文字なら winner=corrected", () => {
    expect(reasonFor(corrected, correcting, upper(corrected))).toMatch(/winner=corrected$/);
  });
  it("文字列が完全に一致する側を、大文字小文字の一致より先に採る（両側が大文字小文字だけ違う id のとき）", () => {
    expect(reasonFor("Abc", "abc", "abc")).toMatch(/winner=correcting$/);
    expect(reasonFor("Abc", "abc", "Abc")).toMatch(/winner=corrected$/);
  });
  it("どちらとも合わない・両方に合うときは今までどおり winner=corrected", () => {
    expect(reasonFor(corrected, correcting, "cccccccc-0000-4000-8000-000000000003")).toMatch(
      /winner=corrected$/,
    );
    expect(reasonFor("Abc", "aBC", "abc")).toMatch(/winner=corrected$/);
  });
});
