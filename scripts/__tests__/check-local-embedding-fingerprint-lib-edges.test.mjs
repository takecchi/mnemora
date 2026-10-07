import { describe, expect, it } from "vitest";
import {
  compareFingerprints,
  formatFingerprintReport,
  normalizeActualPath,
} from "../check-local-embedding-fingerprint-lib.mjs";

/**
 * #1789（ADR 0666）の確かめ直し（Issue #1877）で、既存の歯をすり抜けた変異に当てる歯。
 * - hash の種類（sha256 と git-blob-sha1）が違えば、16進が同じでも一致にしない。
 * - 固定 revision の接頭辞を剥がすのは先頭だけ（途中に同じ並びが在るパスは触らない）。
 * - 素性不明のファイルだけで不一致のとき、報告の文面は「一致」と言わない。
 */

const SUM = "a".repeat(64);

describe("compareFingerprints: hash の種類", () => {
  it("種類が違えば、16進が同じでも不一致（期待は sha256、手元は git-blob-sha1）", () => {
    const result = compareFingerprints({
      actual: [{ path: "model.onnx", algorithm: "git-blob-sha1", hex: SUM }],
      expectedByPath: new Map([["model.onnx", { algorithm: "sha256", hex: SUM }]]),
    });
    expect(result.verdict).toBe("mismatch");
    expect(result.mismatched.map((m) => m.path)).toEqual(["model.onnx"]);
    expect(result.matched).toEqual([]);
  });

  it("種類も16進も同じなら一致", () => {
    const result = compareFingerprints({
      actual: [{ path: "model.onnx", algorithm: "sha256", hex: SUM }],
      expectedByPath: new Map([["model.onnx", { algorithm: "sha256", hex: SUM }]]),
    });
    expect(result.verdict).toBe("match");
  });
});

describe("normalizeActualPath: 先頭の revision だけを剥がす", () => {
  it("先頭に revision が在れば剥がす", () => {
    expect(normalizeActualPath("abc123/onnx/model.onnx", "abc123")).toBe("onnx/model.onnx");
  });

  it("途中に `<revision>/` が在るパスは触らない", () => {
    expect(normalizeActualPath("onnx/abc123/model.onnx", "abc123")).toBe("onnx/abc123/model.onnx");
  });

  it("revision と先頭が部分一致するだけ（`abc1234/…`）のパスは触らない", () => {
    expect(normalizeActualPath("abc1234/model.onnx", "abc123")).toBe("abc1234/model.onnx");
  });
});

describe("formatFingerprintReport: 素性不明だけで不一致のとき", () => {
  it("「一致」で始まらず、素性不明の本数と名前を出す", () => {
    const result = compareFingerprints({
      actual: [
        { path: "model.onnx", algorithm: "sha256", hex: SUM },
        { path: "extra.bin", algorithm: "git-blob-sha1", hex: "b".repeat(40) },
      ],
      expectedByPath: new Map([["model.onnx", { algorithm: "sha256", hex: SUM }]]),
    });
    expect(result.verdict).toBe("mismatch");
    expect(result.mismatched).toEqual([]);
    const report = formatFingerprintReport(result);
    expect(report.startsWith("不一致")).toBe(true);
    expect(report).toContain("素性不明 1 本");
    expect(report).toContain("extra.bin");
  });

  it("全部一致のときは「一致」で始まる（やりすぎの対）", () => {
    const result = compareFingerprints({
      actual: [{ path: "model.onnx", algorithm: "sha256", hex: SUM }],
      expectedByPath: new Map([["model.onnx", { algorithm: "sha256", hex: SUM }]]),
    });
    expect(formatFingerprintReport(result).startsWith("一致")).toBe(true);
  });
});
