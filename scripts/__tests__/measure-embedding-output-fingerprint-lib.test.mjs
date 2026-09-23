import { describe, expect, it } from "vitest";
import {
  buildFingerprintRecord,
  parseLscpuText,
  parseProcCpuinfoText,
  serializeVectorsToBytes,
  sha256HexOfVectors,
  vectorDimensions,
} from "../measure-embedding-output-fingerprint-lib.mjs";

/**
 * `scripts/measure-embedding-output-fingerprint-lib.mjs` の歯（Issue #565）。
 *
 * ⛔ **本物のモデルは一度も呼ばない。** 固定のベクトル（偽の `embed()` の戻り値）を
 * 直接渡して、バイト列化・hash・CPU 情報の抽出・組み立てだけを測る。
 *
 * 🔴 **歯1（マネージャー指示: 実装前に赤であることを確認すること）**——
 * 同じベクトル → 同じ sha256。1成分でも違えば違う sha256。**成分の並べ替えは
 * 違う hash になる**（バイト列化が成分の順序をソートしていないことの固定。
 * 変異(iii)「並べ替えてから hash する」を検出する）。
 */

describe("serializeVectorsToBytes / sha256HexOfVectors（歯1）", () => {
  const vectorsA = [
    [0.1, 0.2, 0.3],
    [-1.5, 2.25, 0.0],
  ];

  it("同じベクトルは同じ sha256 になる", () => {
    const vectorsACopy = [
      [0.1, 0.2, 0.3],
      [-1.5, 2.25, 0.0],
    ];
    expect(sha256HexOfVectors(vectorsA)).toBe(sha256HexOfVectors(vectorsACopy));
  });

  it("1成分でも違えば違う sha256 になる", () => {
    const vectorsB = [
      [0.1, 0.2, 0.30001],
      [-1.5, 2.25, 0.0],
    ];
    expect(sha256HexOfVectors(vectorsA)).not.toBe(sha256HexOfVectors(vectorsB));
  });

  it("成分の順序を入れ替えると違う sha256 になる（並べ替えて hash していないことの固定）", () => {
    // vectorsC は vectorsA の1本目の成分を並べ替えただけ——多重集合としては同じ値。
    const vectorsC = [
      [0.3, 0.2, 0.1],
      [-1.5, 2.25, 0.0],
    ];
    expect(sha256HexOfVectors(vectorsA)).not.toBe(sha256HexOfVectors(vectorsC));
  });

  it("ベクトルの本数の順序を入れ替えても違う sha256 になる", () => {
    const vectorsD = [
      [-1.5, 2.25, 0.0],
      [0.1, 0.2, 0.3],
    ];
    expect(sha256HexOfVectors(vectorsA)).not.toBe(sha256HexOfVectors(vectorsD));
  });

  it("64桁の16進文字列を返す（sha256）", () => {
    expect(sha256HexOfVectors(vectorsA)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serializeVectorsToBytes は 8バイト×総成分数の長さを持つ", () => {
    const bytes = serializeVectorsToBytes(vectorsA);
    expect(bytes.length).toBe(8 * 6);
  });
});

describe("vectorDimensions", () => {
  it("全ベクトルが同じ長さなら、その長さを返す", () => {
    expect(
      vectorDimensions([
        [1, 2],
        [3, 4],
        [5, 6],
      ]),
    ).toBe(2);
  });

  it("ベクトルの長さが揃っていなければ null を返す", () => {
    expect(
      vectorDimensions([
        [1, 2],
        [3, 4, 5],
      ]),
    ).toBeNull();
  });

  it("空配列なら null を返す", () => {
    expect(vectorDimensions([])).toBeNull();
  });
});

describe("parseLscpuText", () => {
  const sample = [
    "Architecture:            x86_64",
    "CPU op-mode(s):          32-bit, 64-bit",
    "Vendor ID:                GenuineIntel",
    "Model name:               Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz",
    "CPU(s):                   4",
    "Flags:                    fpu vme de pse tsc msr pae mce cx8 apic sep avx2",
    "",
  ].join("\n");

  it("比較に効く欄だけを取り出す", () => {
    const fields = parseLscpuText(sample);
    expect(fields["Architecture"]).toBe("x86_64");
    expect(fields["Vendor ID"]).toBe("GenuineIntel");
    expect(fields["Model name"]).toBe("Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz");
    expect(fields["CPU(s)"]).toBe("4");
    expect(fields["Flags"]).toContain("avx2");
  });

  it("対象外の欄(CPU op-mode(s)など)は含めない", () => {
    const fields = parseLscpuText(sample);
    expect(fields["CPU op-mode(s)"]).toBeUndefined();
  });
});

describe("parseProcCpuinfoText", () => {
  const sample = [
    "processor\t: 0",
    "vendor_id\t: GenuineIntel",
    "model name\t: Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz",
    "flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep avx2",
    "",
    "processor\t: 1",
    "vendor_id\t: GenuineIntel",
  ].join("\n");

  it("最初のプロセッサエントリから欄を取り出す", () => {
    const fields = parseProcCpuinfoText(sample);
    expect(fields["Vendor ID"]).toBe("GenuineIntel");
    expect(fields["Model name"]).toBe("Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz");
    expect(fields["Flags"]).toContain("avx2");
  });
});

describe("buildFingerprintRecord", () => {
  const cpuInfo = { source: "lscpu", "Model name": "test-cpu" };
  const measuredAt = "2026-09-24T00:00:00.000Z";
  const runnerName = "GitHub Actions 1";

  it("status=ok の生 JSON から sha256/dimensions を持つ測定 JSON を組み立てる", () => {
    const raw = {
      status: "ok",
      detail: "embed() に成功した",
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      inputs: ["朝食にパンを食べた。"],
      vectors: [[0.1, 0.2, 0.3]],
    };
    const result = buildFingerprintRecord({ raw, cpuInfo, measuredAt, runnerName });
    expect(result.ok).toBe(true);
    expect(result.value.status).toBe("ok");
    expect(result.value.sha256).toBe(sha256HexOfVectors(raw.vectors));
    expect(result.value.dimensions).toBe(3);
    expect(result.value.vectorCount).toBe(1);
    expect(result.value.cpuInfo).toEqual(cpuInfo);
    expect(result.value.measuredAt).toBe(measuredAt);
    expect(result.value.runnerName).toBe(runnerName);
  });

  it("status=weights_unavailable のときは sha256/dimensions を持たない", () => {
    const raw = { status: "weights_unavailable", detail: "重みを取得できなかった: test" };
    const result = buildFingerprintRecord({ raw, cpuInfo, measuredAt, runnerName });
    expect(result.ok).toBe(true);
    expect(result.value.status).toBe("weights_unavailable");
    expect(result.value).not.toHaveProperty("sha256");
    expect(result.value).not.toHaveProperty("dimensions");
    expect(result.value.detail).toBe(raw.detail);
  });

  it("status=ok なのに vectors が空だと ok:false になる", () => {
    const raw = { status: "ok", detail: "x", vectors: [] };
    const result = buildFingerprintRecord({ raw, cpuInfo, measuredAt, runnerName });
    expect(result.ok).toBe(false);
  });

  it("vectors の次元数が揃っていないと ok:false になる", () => {
    const raw = {
      status: "ok",
      detail: "x",
      vectors: [
        [1, 2],
        [3, 4, 5],
      ],
    };
    const result = buildFingerprintRecord({ raw, cpuInfo, measuredAt, runnerName });
    expect(result.ok).toBe(false);
  });

  it("生 JSON がオブジェクトでないと ok:false になる", () => {
    const result = buildFingerprintRecord({ raw: null, cpuInfo, measuredAt, runnerName });
    expect(result.ok).toBe(false);
  });

  it("status が想定外の値だと ok:false になる", () => {
    const result = buildFingerprintRecord({
      raw: { status: "weird", detail: "x" },
      cpuInfo,
      measuredAt,
      runnerName,
    });
    expect(result.ok).toBe(false);
  });
});
