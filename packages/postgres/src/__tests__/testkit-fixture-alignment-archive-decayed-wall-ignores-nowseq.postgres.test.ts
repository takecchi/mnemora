import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * PR #1753 の約束: `archiveDecayed` の `nowSeq` の検査は、clock が `wall`（省略を含む）のときは外す（`wall` は `nowSeq` を SQL に入れない）。
 * `activity`・`either` は、整数でない値も範囲外も断る。PR の歯は `nowSeq: 1.5` の1値だけで、`wall` に「整数だけ見ない」のではなく
 * 「範囲を見る」検査が残る変異（`-1`・`NaN`・`2 ** 63` を `wall` で断る）が、testkit の歯も2実装並べの歯も赤にしなかった。
 * ここで、同じ値を2実装へ流し、`wall` は通る・`activity`/`either` は断る、を値ごとに縛る。
 */
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
    // wall（省略を含む）は nowSeq を SQL に入れないので、どの値でも返る。
    expect(seen.postgres).toMatchObject({ wall: "returned", 省略: "returned" });
    expect(seen.fixture).toMatchObject({ wall: "returned", 省略: "returned" });
    // activity・either は、断るかどうかが2実装で同じ。
    expect(seen.fixture).toEqual(seen.postgres);
  });
});
