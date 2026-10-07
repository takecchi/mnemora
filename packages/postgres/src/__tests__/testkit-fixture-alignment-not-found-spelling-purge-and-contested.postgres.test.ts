import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemory, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

// 比べるのは `<id>` の綴りだけ。例外の種類・message の頭は2実装で違う。
const ctx: Ctx = { tenantId: "fixture-align-spelling-purge-contested" };
const U = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" as MemoryId;

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

async function notFoundId(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const m = /memory not found for tenant: (\S+)/.exec((e as Error).message);
    return m ? m[1]! : `other: ${(e as Error).message.slice(0, 80)}`;
  }
}

const ev = (id: MemoryId, kind: string): NewMemoryEvent =>
  ({ memoryId: id, kind, actor: { type: "system" }, meta: {} }) as unknown as NewMemoryEvent;
const fixture = (hash: string): NewMemory =>
  buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: hash, content: hash });

type Mouth = [string, (s: Store, x: { id: MemoryId }, y: { id: MemoryId }) => Promise<unknown>];

const MOUTHS: Mouth[] = [
  ["purgeMemory", (s) => s.purgeMemory(ctx, U, { content: "x", digest: "y" }, ev(U, "purged"))],
  [
    "markContestedPair（1つ目が無い）",
    (s, x) =>
      s.markContestedPair(
        ctx,
        { id: U, event: ev(U, "contested") },
        { id: x.id, event: ev(x.id, "contested") },
      ),
  ],
  [
    "markContestedPair（2つ目が無い）",
    (s, x) =>
      s.markContestedPair(
        ctx,
        { id: x.id, event: ev(x.id, "contested") },
        { id: U, event: ev(U, "contested") },
      ),
  ],
  [
    "resolveContestedPair（1つ目が無い）",
    (s, x) =>
      s.resolveContestedPair(
        ctx,
        { id: U, status: "active", event: ev(U, "resolved") },
        { id: x.id, status: "active", event: ev(x.id, "resolved") },
      ),
  ],
  [
    "resolveContestedPair（2つ目が無い）",
    (s, x) =>
      s.resolveContestedPair(
        ctx,
        { id: x.id, status: "active", event: ev(x.id, "resolved") },
        { id: U, status: "active", event: ev(U, "resolved") },
      ),
  ],
  [
    "markContestedGroup",
    (s, x, y) =>
      s.markContestedGroup!(ctx, [
        { id: x.id, event: ev(x.id, "contested") },
        { id: y.id, event: ev(y.id, "contested") },
        { id: U, event: ev(U, "contested") },
      ]),
  ],
  [
    "resolveContestedGroup",
    (s, x, y) =>
      s.resolveContestedGroup!(ctx, [
        { id: x.id, status: "active", event: ev(x.id, "resolved") },
        { id: y.id, status: "active", event: ev(y.id, "resolved") },
        { id: U, status: "active", event: ev(U, "resolved") },
      ]),
  ],
  [
    "resolveOrphanedContested",
    (s, x) =>
      s.resolveOrphanedContested!(ctx, {
        id: U,
        contestedWithId: x.id,
        event: ev(U, "resolved"),
      }),
  ],
];

describe("purgeMemory と contested の口が、どこにも無い id を断る message の綴りは、fixture も Postgres と同じ（小文字）", () => {
  it.each(MOUTHS)("%s", async (_name, call) => {
    const seen: Record<string, string | null> = {};
    for (const impl of ["postgres", "fixture"] as const) {
      await resetTestDatabase();
      const store = await build(impl);
      const x = await store.createMemory(ctx, fixture("x"));
      const y = await store.createMemory(ctx, fixture("y"));
      seen[impl] = await notFoundId(() => call(store, x, y));
    }
    expect(seen.postgres).toBe(U.toLowerCase());
    expect(seen.fixture).toBe(seen.postgres);
  });
});
