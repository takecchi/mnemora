import { describe, expect, it } from "vitest";
import {
  buildSummaryMarkdown,
  diffProbes,
  probeKey,
  validateBaseline,
  validateMeasured,
} from "../long-horizon-summary-lib.mjs";

function probe(overrides = {}) {
  return {
    arm: "A",
    checkpointDay: 7,
    factId: "f1",
    role: "gold",
    outcome: "returned",
    ...overrides,
  };
}
const withProvenance = (probes) => ({ provenance: { runIds: ["1", "2"] }, probes });

describe("long-horizon の基準値との突き合わせ", () => {
  it("outcome が同じ probe は same、違う probe は changed に、鍵ごとに数える", () => {
    const d = diffProbes(
      { probes: [probe(), probe({ factId: "f2", outcome: "outranked" })] },
      withProvenance([probe(), probe({ factId: "f2", outcome: "returned" })]),
    );
    expect(d.same).toBe(1);
    expect(d.changed).toEqual([
      { key: probeKey(probe({ factId: "f2" })), baseline: "returned", measured: "outranked" },
    ]);
  });

  it("基準値に無い probe・実測に無い probe を別々に数える（黙って落とさない）", () => {
    const d = diffProbes(
      { probes: [probe(), probe({ checkpointDay: 30 })] },
      withProvenance([probe(), probe({ arm: "C" })]),
    );
    expect(d.extra).toEqual([probeKey(probe({ checkpointDay: 30 }))]);
    expect(d.missing).toEqual([probeKey(probe({ arm: "C" }))]);
  });

  it("順位など outcome 以外の値が違っても差にしない", () => {
    const d = diffProbes(
      { probes: [probe({ returnedRank: 3 })] },
      withProvenance([probe({ returnedRank: 1 })]),
    );
    expect(d.changed).toEqual([]);
    expect(d.same).toBe(1);
  });

  it("壊れた入力（probes が無い・鍵の重複・provenance の無い基準値）を断る", () => {
    expect(validateMeasured({}).ok).toBe(false);
    expect(validateMeasured({ probes: [probe(), probe()] }).ok).toBe(false);
    expect(validateMeasured({ probes: [probe({ checkpointDay: "7" })] }).ok).toBe(false);
    expect(validateBaseline({ probes: [probe()] }).ok).toBe(false);
    expect(validateBaseline(withProvenance([probe()])).ok).toBe(true);
  });

  it("Markdown は件数を出し、門ではないことを名乗る。基準値が無ければ差を出さない", () => {
    const md = buildSummaryMarkdown({
      measured: { probes: [probe({ outcome: "decayed" })] },
      baseline: withProvenance([probe()]),
    });
    expect(md).toContain("門ではない");
    expect(md).toContain("違う 1 件");
    expect(md).toContain("| A\\|7\\|f1\\|gold | returned | decayed |");
    expect(buildSummaryMarkdown({ measured: { probes: [probe()] } })).toContain(
      "基準値が渡されていない",
    );
  });

  it("基準値の provenance.unstableProbes に載った probe の差は、違う件数に数えず既知の揺れとして分けて出す", () => {
    const md = buildSummaryMarkdown({
      measured: {
        probes: [probe({ outcome: "decayed" }), probe({ factId: "f2", outcome: "decayed" })],
      },
      baseline: {
        provenance: { unstableProbes: [probeKey(probe())] },
        probes: [probe(), probe({ factId: "f2" })],
      },
    });
    expect(md).toContain("違う 1 件（ほかに既知の揺れ 1 件）");
    expect(md).toContain(
      `既知の揺れ（基準値を採った run の2回の間でも違った probe）: ${probeKey(probe())}`,
    );
    expect(md).toContain("| A\\|7\\|f2\\|gold | returned | decayed |");
    expect(md).not.toContain("| A\\|7\\|f1\\|gold |");
  });
});
