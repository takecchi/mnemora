import { describe, expect, it } from "vitest";
import {
  buildFingerprintSummaryMarkdown,
  validateFingerprintRecord,
} from "../embedding-output-fingerprint-summary-lib.mjs";

/**
 * `scripts/embedding-output-fingerprint-summary-lib.mjs` の歯（Issue #565）。
 * 本物のモデルは呼ばない——固定の測定 JSON を直接渡す。
 */

describe("validateFingerprintRecord", () => {
  it("status=ok で sha256/dimensions が揃っていれば ok:true", () => {
    const result = validateFingerprintRecord({ status: "ok", sha256: "abc", dimensions: 256 });
    expect(result.ok).toBe(true);
  });

  it("status=ok なのに sha256 が無ければ ok:false", () => {
    const result = validateFingerprintRecord({ status: "ok", dimensions: 256 });
    expect(result.ok).toBe(false);
  });

  it("status=weights_unavailable は sha256 が無くても ok:true", () => {
    const result = validateFingerprintRecord({ status: "weights_unavailable", detail: "x" });
    expect(result.ok).toBe(true);
  });

  it("オブジェクトでなければ ok:false", () => {
    expect(validateFingerprintRecord(null).ok).toBe(false);
    expect(validateFingerprintRecord("x").ok).toBe(false);
  });
});

describe("buildFingerprintSummaryMarkdown", () => {
  it("status=ok なら sha256・dimensions・CPU 情報を含む", () => {
    const markdown = buildFingerprintSummaryMarkdown({
      status: "ok",
      sha256: "abc123",
      dimensions: 256,
      vectorCount: 3,
      embeddingSpace: { provider: "local", model: "ruri-v3-30m/sym", dimensions: 256 },
      inputs: ["a", "b", "c"],
      measuredAt: "2026-09-24T00:00:00.000Z",
      runnerName: "GitHub Actions 1",
      cpuInfo: { source: "lscpu", "Model name": "test-cpu" },
    });
    expect(markdown).toContain("abc123");
    expect(markdown).toContain("256");
    expect(markdown).toContain("test-cpu");
    expect(markdown).toContain("門ではない");
  });

  it("status=weights_unavailable なら sha256 を出さず、理由を出す", () => {
    const markdown = buildFingerprintSummaryMarkdown({
      status: "weights_unavailable",
      detail: "重みを取得できなかった: network error",
      measuredAt: "2026-09-24T00:00:00.000Z",
      runnerName: "GitHub Actions 1",
    });
    expect(markdown).toContain("重みを取得できなかった");
    expect(markdown).not.toContain("sha256:");
  });
});
