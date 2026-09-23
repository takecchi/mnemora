import { describe, expect, it } from "vitest";
import {
  buildComparisonSummaryMarkdown,
  compareFingerprints,
} from "../compare-embedding-output-fingerprints-lib.mjs";

/**
 * `scripts/compare-embedding-output-fingerprints-lib.mjs` の歯（Issue #565）。
 *
 * ⛔ **本物のモデルは一度も呼ばない。** 固定の測定 JSON（偽の測定結果）を直接渡して、
 * 一致/不一致/比較できなかったの判定だけを測る。
 *
 * 🔴 **歯2（マネージャー指示）**: 2つの結果が一致 →「一致」、不一致 →「不一致」と
 * 両方の lscpu の差が並ぶ。**この pure 関数自体は exit code を持たない**——
 * 「どちらでも終了コードは0」は CLI 側の契約であり、その固定は
 * `compare-embedding-output-fingerprints-cli.test.mjs`（別ファイル）が持つ。
 *
 * 🔴 **歯3（陽性対照）**: 片方の artifact が無いときは「比較できなかった」と名乗る
 * ——一致とも不一致とも言わない。
 */

const cpuInfoA = { source: "lscpu", "Model name": "cpu-a", Flags: "avx2 sse4_2" };
const cpuInfoB = { source: "lscpu", "Model name": "cpu-b", Flags: "avx2 sse4_2" };

function okLeg(id, { sha256, dimensions, cpuInfo }) {
  return {
    id,
    present: true,
    record: { status: "ok", sha256, dimensions, cpuInfo, vectorCount: 1 },
  };
}

describe("compareFingerprints（歯2: 一致/不一致）", () => {
  it("sha256・dimensions が同じなら match になる", () => {
    const legA = okLeg("example-chat", { sha256: "abc123", dimensions: 256, cpuInfo: cpuInfoA });
    const legB = okLeg("root-gate-db-stage", {
      sha256: "abc123",
      dimensions: 256,
      cpuInfo: cpuInfoA,
    });
    const result = compareFingerprints(legA, legB);
    expect(result.status).toBe("match");
  });

  it("sha256 が食い違うと mismatch になり、両方の CPU 情報の差が並ぶ", () => {
    const legA = okLeg("example-chat", { sha256: "abc123", dimensions: 256, cpuInfo: cpuInfoA });
    const legB = okLeg("root-gate-db-stage", {
      sha256: "def456",
      dimensions: 256,
      cpuInfo: cpuInfoB,
    });
    const result = compareFingerprints(legA, legB);
    expect(result.status).toBe("mismatch");
    expect(result.sha256).toEqual({ "example-chat": "abc123", "root-gate-db-stage": "def456" });
    const modelDiff = result.cpuDiff.find((d) => d.field === "Model name");
    expect(modelDiff).toEqual({ field: "Model name", a: "cpu-a", b: "cpu-b" });
  });

  it("dimensions だけが食い違っても mismatch になる", () => {
    const legA = okLeg("example-chat", { sha256: "abc123", dimensions: 256, cpuInfo: cpuInfoA });
    const legB = okLeg("root-gate-db-stage", {
      sha256: "abc123",
      dimensions: 128,
      cpuInfo: cpuInfoA,
    });
    const result = compareFingerprints(legA, legB);
    expect(result.status).toBe("mismatch");
  });

  it("CPU 情報が完全に同じなら mismatch でも cpuDiff は空配列", () => {
    const legA = okLeg("example-chat", { sha256: "abc123", dimensions: 256, cpuInfo: cpuInfoA });
    const legB = okLeg("root-gate-db-stage", {
      sha256: "def456",
      dimensions: 256,
      cpuInfo: cpuInfoA,
    });
    const result = compareFingerprints(legA, legB);
    expect(result.status).toBe("mismatch");
    expect(result.cpuDiff).toEqual([]);
  });
});

describe("compareFingerprints（歯3: 陽性対照——片方が無いとき）", () => {
  it("片方の artifact が present:false なら incomparable になる（match でも mismatch でもない）", () => {
    const legA = okLeg("example-chat", { sha256: "abc123", dimensions: 256, cpuInfo: cpuInfoA });
    const legB = { id: "root-gate-db-stage", present: false };
    const result = compareFingerprints(legA, legB);
    expect(result.status).toBe("incomparable");
    expect(result.status).not.toBe("match");
    expect(result.status).not.toBe("mismatch");
    expect(result.reason).toContain("root-gate-db-stage");
  });

  it("両方の artifact が present:false でも incomparable になる", () => {
    const legA = { id: "example-chat", present: false };
    const legB = { id: "root-gate-db-stage", present: false };
    const result = compareFingerprints(legA, legB);
    expect(result.status).toBe("incomparable");
  });

  it("測定 JSON が壊れている(error)場合も incomparable になる", () => {
    const legA = okLeg("example-chat", { sha256: "abc123", dimensions: 256, cpuInfo: cpuInfoA });
    const legB = { id: "root-gate-db-stage", present: true, error: "Unexpected token in JSON" };
    const result = compareFingerprints(legA, legB);
    expect(result.status).toBe("incomparable");
  });

  it("片方が weights_unavailable の場合も incomparable になる", () => {
    const legA = okLeg("example-chat", { sha256: "abc123", dimensions: 256, cpuInfo: cpuInfoA });
    const legB = {
      id: "root-gate-db-stage",
      present: true,
      record: { status: "weights_unavailable", detail: "重みを取得できなかった" },
    };
    const result = compareFingerprints(legA, legB);
    expect(result.status).toBe("incomparable");
  });
});

describe("buildComparisonSummaryMarkdown", () => {
  it("match のときは「一致」を含む Markdown を返す", () => {
    const legA = okLeg("example-chat", { sha256: "abc123", dimensions: 256, cpuInfo: cpuInfoA });
    const legB = okLeg("root-gate-db-stage", {
      sha256: "abc123",
      dimensions: 256,
      cpuInfo: cpuInfoA,
    });
    const result = compareFingerprints(legA, legB);
    const markdown = buildComparisonSummaryMarkdown([legA, legB], result);
    expect(markdown).toContain("✅ 一致");
    // ⚠ 冒頭の注意書きは定型文として「不一致」という語を含むため(門にしていない
    // ことの説明)、判定そのものを表す強調付きの表記だけを見る。
    expect(markdown).not.toContain("⚠ **不一致**");
  });

  it("mismatch のときは「不一致」と CPU 情報の差を含む Markdown を返す", () => {
    const legA = okLeg("example-chat", { sha256: "abc123", dimensions: 256, cpuInfo: cpuInfoA });
    const legB = okLeg("root-gate-db-stage", {
      sha256: "def456",
      dimensions: 256,
      cpuInfo: cpuInfoB,
    });
    const result = compareFingerprints(legA, legB);
    const markdown = buildComparisonSummaryMarkdown([legA, legB], result);
    expect(markdown).toContain("不一致");
    expect(markdown).toContain("cpu-a");
    expect(markdown).toContain("cpu-b");
  });

  it("incomparable のときは「比較できなかった」を含み、一致/不一致を含まない", () => {
    const legA = okLeg("example-chat", { sha256: "abc123", dimensions: 256, cpuInfo: cpuInfoA });
    const legB = { id: "root-gate-db-stage", present: false };
    const result = compareFingerprints(legA, legB);
    const markdown = buildComparisonSummaryMarkdown([legA, legB], result);
    expect(markdown).toContain("比較できなかった");
    expect(markdown).not.toContain("✅ 一致");
    expect(markdown).not.toContain("⚠ **不一致**");
  });
});
