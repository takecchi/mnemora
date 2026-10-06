import { describe, expect, it, vi } from "vitest";
import { type FuzzBackend, type Op, runOps } from "./recall-invariant-fuzz-harness.js";

/**
 * fuzz の `relations` profile（ADR 0494）が見つけた 2 つの割れの、最小化した操作列を固定した歯。
 * 検査器（`recall-invariant-fuzz-harness.ts`）の不変条件 I1〜I12 を、この操作列で 1 回だけ走らせる。
 * 3 実装（Fake・testkit の InMemory・Postgres）が共有する core の recall 本体の割れなので、Fake で足りる。
 */

const fakeBackend: FuzzBackend = {
  async setup() {
    vi.resetModules();
    const { createFakeRuntimeStores } = await import("./runtime-fakes.js");
    const { createRuntime } = await import("../runtime.js");
    return { stores: createFakeRuntimeStores(), createRuntime };
  },
  vector: (v) => [...v],
};

const create = (v: number, tags: string[], subj: boolean, hl: number, ready = true): Op => ({
  k: "create",
  v,
  tags,
  ready,
  zero: false,
  subj,
  hl,
});

describe("fuzz の relations profile が見つけた割れ（ADR 0494）", () => {
  it("relationMaxCount で切った群のメンバーを、段2・連想で重ねて数えない（seed 10。I10-upper）", async () => {
    // 群 {mem-1, mem-2, mem-4}。relationMaxCount=1 で mem-4 が `over_limit(relation)` に数えられたあと、
    // 連想が mem-4 を拾って `unit_assembly_dropped`（または below_threshold）にも数えていた。
    const ops: Op[] = [
      create(5, [], true, 1),
      create(5, ["a", "b", "c"], true, 8760),
      create(0, ["a"], false, 24),
      create(4, [], false, 8760),
      create(4, ["b"], true, 8760),
      { k: "group", i: 556, j: 388, l: 755 },
      {
        k: "recall",
        v: 0,
        limit: 4,
        off: 2,
        assoc: 2,
        budget: 25,
        thr: -1,
        lex: true,
        x: { tw: false, dbl: 0, qt: [], rmc: 1 },
      },
    ];
    const { violations } = await runOps(fakeBackend, ops, { relations: true });
    expect(violations).toEqual([]);
  });

  it("RelationStore.link で active な記憶へ辺を張っても、その記憶を2回返さない（seed 187。I2-unique）", async () => {
    // mem-2 → mem-1（一方向、mem-1 は active のまま）の辺を張ってから、{mem-2, mem-3, mem-4} を群にする。
    // 群の単位の組み立てが辺をたどって mem-1 まで群に入れ、mem-1 が自分の単位と群の両方で返っていた。
    const ops: Op[] = [
      create(1, ["b"], false, 8760),
      create(3, ["a"], true, 8760),
      create(1, ["a"], false, 24),
      create(4, ["a"], false, 24, false),
      { k: "link", i: 73, j: 724 },
      create(4, ["a"], false, 24),
      { k: "group", i: 463, j: 281, l: 517 },
      {
        k: "recall",
        v: 1,
        limit: 4,
        off: 1,
        assoc: 1,
        budget: 0,
        thr: -1,
        lex: false,
        x: { tw: false, dbl: 0, qt: [], rmc: 0 },
      },
    ];
    const { violations } = await runOps(fakeBackend, ops, { relations: true });
    expect(violations).toEqual([]);
  });

  it("relationMaxCount で切った群のメンバーを、段2の over_limit（rescore）でも重ねて数えない（seed 545。I10-upper、Issue #1759）", async () => {
    // ADR 0494 の直しは、切った群のメンバーを3つの数え（below_threshold・score_not_comparable・over_limit）から外す。
    // 上の seed 10 は1つ目しか踏まず、over_limit の側の除外を外す変異は、既定の本数の fuzz（20 シード）も
    // Postgres の fuzz も素通りした。relations profile を 2000 シード回して見つけた操作列を最小化したもの。
    const ops: Op[] = [
      create(4, [], false, 8760),
      create(3, [], false, 8760),
      create(5, ["a"], false, 1),
      create(3, ["c"], false, 8760),
      create(1, ["a"], true, 24),
      { k: "group", i: 293, j: 215, l: 971 },
      create(4, ["a"], false, 24),
      {
        k: "recall",
        v: 4,
        limit: 3,
        off: 3,
        assoc: 0,
        budget: 12,
        thr: 0,
        lex: false,
        x: { tw: false, dbl: 0, qt: [], rmc: 1 },
      },
    ];
    const { violations } = await runOps(fakeBackend, ops, { relations: true });
    expect(violations).toEqual([]);
  });
});
