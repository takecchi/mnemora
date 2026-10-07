import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, Memory } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "written-floor-later-members" };
const T = ctx.tenantId;
const FLOOR_MS = Date.UTC(-4713, 10, 24);
const EARLY = new Date(FLOOR_MS - 1);
const FAR = new Date(Date.UTC(-9000, 0, 1));
const GOOD = new Date("2030-01-01T00:00:00Z");

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

type Store = PostgresMemoryStore | InMemoryMemoryStore;

async function build(impl: "postgres" | "fixture"): Promise<Store> {
  if (impl === "postgres") {
    const { db } = await getTestClient();
    return new PostgresMemoryStore(db);
  }
  return new InMemoryMemoryStore();
}

async function classify(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const message = `${err.message} ${err.cause?.message ?? ""}`;
    if (err.cause?.code === "22008" || /must not be earlier than 4714-11-24 BC/.test(message)) {
      return "range";
    }
    return `other: ${message.split("\n")[0]!.slice(0, 90)}`;
  }
}

const ev = (memoryId: string, at: Date) =>
  buildNewMemoryEventFixture({ tenantId: T, memoryId: memoryId as never, kind: "updated", at });

const mk = (s: Store, contentHash: string): Promise<Memory> =>
  s.createMemory(ctx, buildNewMemoryFixture({ tenantId: T, contentHash }));

interface Case {
  name: string;
  prepare: (
    s: Store,
    at: Date,
  ) => Promise<{ act: () => Promise<unknown>; ids: string[]; status: string }>;
}

const CASES: Case[] = [
  {
    name: "resolveContestedPair の2つ目の event.at",
    prepare: async (s, at) => {
      const a = await mk(s, "a");
      const b = await mk(s, "b");
      await s.markContestedPair(
        ctx,
        { id: a.id, event: ev(a.id, GOOD) },
        { id: b.id, event: ev(b.id, GOOD) },
      );
      return {
        act: () =>
          s.resolveContestedPair(
            ctx,
            { id: a.id, status: "active", event: ev(a.id, GOOD) },
            { id: b.id, status: "active", event: ev(b.id, at) },
          ),
        ids: [a.id, b.id],
        status: "contested",
      };
    },
  },
  ...[1, 2].map((index): Case => ({
    name: `markContestedGroup の${index + 1}件目の event.at`,
    prepare: async (s, at) => {
      const ms = [await mk(s, "a"), await mk(s, "b"), await mk(s, "c")];
      return {
        act: () =>
          s.markContestedGroup!(
            ctx,
            ms.map((m, i) => ({ id: m.id, event: ev(m.id, i === index ? at : GOOD) })),
          ),
        ids: ms.map((m) => m.id),
        status: "active",
      };
    },
  })),
  ...[1, 2].map((index): Case => ({
    name: `resolveContestedGroup の${index + 1}件目の event.at`,
    prepare: async (s, at) => {
      const ms = [await mk(s, "a"), await mk(s, "b"), await mk(s, "c")];
      await s.markContestedGroup!(
        ctx,
        ms.map((m) => ({ id: m.id, event: ev(m.id, GOOD) })),
      );
      return {
        act: () =>
          s.resolveContestedGroup!(
            ctx,
            ms.map((m, i) => ({
              id: m.id,
              status: "active" as const,
              event: ev(m.id, i === index ? at : GOOD),
            })),
          ),
        ids: ms.map((m) => m.id),
        status: "contested",
      };
    },
  })),
];

describe("複数のイベントを受ける口: どの位置の event.at が下限より前でも、fixture も Postgres と同じく断り、状態を動かさない", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    for (const at of [EARLY, FAR]) {
      for (const impl of ["postgres", "fixture"] as const) {
        await resetTestDatabase();
        const store = await build(impl);
        const { act, ids, status } = await c.prepare(store, at);
        expect(await classify(act), `${impl} ${at.toISOString()}`).toBe("range");
        for (const id of ids) {
          expect((await store.get(ctx, id as never))?.status, `${impl} 状態`).toBe(status);
        }
      }
    }
  });
});
