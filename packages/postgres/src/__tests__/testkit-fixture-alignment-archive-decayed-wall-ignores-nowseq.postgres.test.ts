import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const ctx: Ctx = { tenantId: "fixture-align-archive-wall-nowseq" };

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function build(
  impl: "postgres" | "fixture",
): Promise<PostgresMemoryStore | InMemoryMemoryStore> {
  if (impl === "postgres") {
    const { db } = await getTestClient();
    return new PostgresMemoryStore(db);
  }
  return new InMemoryMemoryStore();
}

async function outcome(run: () => Promise<unknown>): Promise<"returned" | "threw"> {
  try {
    await run();
    return "returned";
  } catch {
    return "threw";
  }
}

const NOW_SEQS: Array<[string, number]> = [
  ["1.5", 1.5],
  ["-1", -1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["2 ** 63", 2 ** 63],
  ["1e30", 1e30],
];

describe("archiveDecayed の nowSeq: wall は見ない。activity・either は2実装で同じ結果（fixture も Postgres と同じ）", () => {
  it.each(NOW_SEQS)("nowSeq が %s", async (_label, nowSeq) => {
    const seen: Record<string, Record<string, "returned" | "threw">> = {};
    for (const impl of ["postgres", "fixture"] as const) {
      await resetTestDatabase();
      const store = await build(impl);
      const run = (clock?: "wall" | "activity" | "either") => () =>
        store.archiveDecayed!(ctx, {
          now: new Date(),
          limit: 10,
          nowSeq,
          ...(clock === undefined ? {} : { clock }),
        });
      seen[impl] = {
        wall: await outcome(run("wall")),
        省略: await outcome(run()),
        activity: await outcome(run("activity")),
        either: await outcome(run("either")),
      };
    }
    expect(seen.postgres).toMatchObject({ wall: "returned", 省略: "returned" });
    expect(seen.fixture).toMatchObject({ wall: "returned", 省略: "returned" });
    expect(seen.fixture).toEqual(seen.postgres);
  });
});
