import { describe, expect, it } from "vitest";
import {
  compareFingerprints,
  expectedHashOfTreeEntry,
  formatFingerprintReport,
  gitBlobSha1Hex,
  normalizeActualPath,
} from "../check-local-embedding-fingerprint-lib.mjs";

/**
 * `scripts/check-local-embedding-fingerprint-lib.mjs` の純関数の歯。
 *
 * ⚠ このファイルはネットワークにもモデル取得にも触れない。`gitBlobSha1Hex` の
 * 実測値は、この作業木でこの依頼のために実際に `git hash-object` を実行して
 * 確かめた値であり（下記コメント参照）、そらで書いた値ではない。
 */

describe("gitBlobSha1Hex", () => {
  it("『test\\n』(5バイト)の git blob hash と一致する（実測値。`echo -n 'test\\n' > f; git hash-object f` で確認済み）", () => {
    // ⭐ 実測: printf 'test\n' > /tmp/x; git hash-object /tmp/x
    //   => 9daeafb9864cf43055ae93beb0afd6c7d144bfa4（依頼文に書かれた値と一致した）。
    const bytes = Buffer.from("test\n", "utf8");
    expect(gitBlobSha1Hex(bytes)).toBe("9daeafb9864cf43055ae93beb0afd6c7d144bfa4");
  });

  it("空バイト列でも計算できる（`git hash-object /dev/null` は e69de29bb2d1d6434b8b29ae775ad8c2e48c5391。実測済み）", () => {
    expect(gitBlobSha1Hex(Buffer.alloc(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});

describe("expectedHashOfTreeEntry", () => {
  it("LFS エントリ（entry.lfs.oid が在る）は sha256 として扱う", () => {
    const entry = { oid: "pointer-blob-sha1", lfs: { oid: "abc123", size: 999 } };
    expect(expectedHashOfTreeEntry(entry)).toEqual({ algorithm: "sha256", hex: "abc123" });
  });

  it("非 LFS エントリ（entry.lfs が無い）は entry.oid を git-blob-sha1 として扱う", () => {
    const entry = { oid: "fa0cbd5bb7c2005cdf94c390666b7d4b4b37fdd4" };
    expect(expectedHashOfTreeEntry(entry)).toEqual({
      algorithm: "git-blob-sha1",
      hex: "fa0cbd5bb7c2005cdf94c390666b7d4b4b37fdd4",
    });
  });

  it("どちらの oid も取れなければ null（tree API の形が変わった等）", () => {
    expect(expectedHashOfTreeEntry({})).toBeNull();
    expect(expectedHashOfTreeEntry({ lfs: {} })).toBeNull();
  });
});

describe("compareFingerprints", () => {
  it("match: 手元のファイルが全部 expectedByPath と一致する", () => {
    const actual = [
      { path: "config.json", algorithm: "git-blob-sha1", hex: "aaa" },
      { path: "onnx/model_quantized.onnx", algorithm: "sha256", hex: "bbb" },
    ];
    const expectedByPath = new Map([
      ["config.json", { algorithm: "git-blob-sha1", hex: "aaa" }],
      ["onnx/model_quantized.onnx", { algorithm: "sha256", hex: "bbb" }],
    ]);
    const result = compareFingerprints({ actual, expectedByPath });
    expect(result.verdict).toBe("match");
    expect(result.matched).toEqual(["config.json", "onnx/model_quantized.onnx"]);
    expect(result.mismatched).toEqual([]);
    expect(result.unknownOnDisk).toEqual([]);
  });

  it("mismatch: hex が食い違う", () => {
    const actual = [{ path: "config.json", algorithm: "git-blob-sha1", hex: "wrong" }];
    const expectedByPath = new Map([["config.json", { algorithm: "git-blob-sha1", hex: "right" }]]);
    const result = compareFingerprints({ actual, expectedByPath });
    expect(result.verdict).toBe("mismatch");
    expect(result.matched).toEqual([]);
    expect(result.mismatched).toEqual([
      {
        path: "config.json",
        expected: { algorithm: "git-blob-sha1", hex: "right" },
        actual: { algorithm: "git-blob-sha1", hex: "wrong" },
      },
    ]);
    expect(result.unknownOnDisk).toEqual([]);
  });

  it("mismatch: 手元に在るのに HF の tree に無い（素性不明）ファイルが在る", () => {
    const actual = [{ path: "mystery.bin", algorithm: "git-blob-sha1", hex: "whatever" }];
    const expectedByPath = new Map();
    const result = compareFingerprints({ actual, expectedByPath });
    expect(result.verdict).toBe("mismatch");
    expect(result.matched).toEqual([]);
    expect(result.mismatched).toEqual([]);
    expect(result.unknownOnDisk).toEqual(["mystery.bin"]);
  });

  it("mismatch: actual が空（手元に検査対象が1本も無い）——保留ではなく赤（依頼者の決定）", () => {
    const expectedByPath = new Map([["config.json", { algorithm: "git-blob-sha1", hex: "aaa" }]]);
    const result = compareFingerprints({ actual: [], expectedByPath });
    expect(result.verdict).toBe("mismatch");
    expect(result.matched).toEqual([]);
    expect(result.mismatched).toEqual([]);
    expect(result.unknownOnDisk).toEqual([]);
  });

  it("🔴 HF の tree に在るが手元に無いファイルは、match のまま崩れない（transformers.js は必要な分だけ取るため）", () => {
    // expectedByPath には onnx/model.onnx（fp32 の完全版）も在るが、手元には
    // q8 量子化版しか無い、という現実的なケース。
    const actual = [{ path: "onnx/model_quantized.onnx", algorithm: "sha256", hex: "bbb" }];
    const expectedByPath = new Map([
      ["onnx/model.onnx", { algorithm: "sha256", hex: "fp32-hash-not-on-disk" }],
      ["onnx/model_quantized.onnx", { algorithm: "sha256", hex: "bbb" }],
    ]);
    const result = compareFingerprints({ actual, expectedByPath });
    expect(result.verdict).toBe("match");
    expect(result.matched).toEqual(["onnx/model_quantized.onnx"]);
    expect(result.mismatched).toEqual([]);
    expect(result.unknownOnDisk).toEqual([]);
  });
});

/**
 * `normalizeActualPath`（Issue #597 案(a) の追加分、ADR 0253 追記5）。
 *
 * 【背景・実測】CI run 35953212055 で、`examples/chat` が固定した revision を
 * `LocalEmbeddingProvider` へ渡すようになった結果、`@huggingface/transformers` の
 * `FileCache` が `<repo>/<revision>/<filename>` というサブディレクトリにファイルを
 * 置くようになり、この門が「素性不明」を4本報告して赤くなった
 * （`不一致: 一致 4 本 / hash 食い違い 0 本 / 素性不明 4 本`）。
 */
describe("normalizeActualPath", () => {
  const REVISION = "cdf9391f1ff2198daa8f63f7ccf97d7b3e7415a0";

  it("pinnedRevision が null なら、相対パスをそのまま返す（revision=main のフラットな配置）", () => {
    expect(normalizeActualPath("config.json", null)).toBe("config.json");
    expect(normalizeActualPath("onnx/model_quantized.onnx", null)).toBe(
      "onnx/model_quantized.onnx",
    );
  });

  it("pinnedRevision のサブディレクトリで始まっていれば、そのプレフィックスを剥がす", () => {
    expect(normalizeActualPath(`${REVISION}/config.json`, REVISION)).toBe("config.json");
    expect(normalizeActualPath(`${REVISION}/onnx/model_quantized.onnx`, REVISION)).toBe(
      "onnx/model_quantized.onnx",
    );
  });

  it("⚠ 陰性対照: 別の revision のサブディレクトリでは剥がさない（別物として素性不明のままにする）", () => {
    expect(
      normalizeActualPath("0000000000000000000000000000000000000000/config.json", REVISION),
    ).toBe("0000000000000000000000000000000000000000/config.json");
  });

  it("⚠ 陰性対照: プレフィックスの後に `/` が無い（たまたま前方一致するだけのファイル名）は剥がさない", () => {
    // 例: revision 名そのものをファイル名の先頭に持つ、たまたまの一致。
    expect(normalizeActualPath(`${REVISION}not-a-directory.json`, REVISION)).toBe(
      `${REVISION}not-a-directory.json`,
    );
  });

  it("プレフィックスの無いフラットな配置は、pinnedRevision が在っても変わらない", () => {
    // revision=main で落とした（フラットな）ファイルと、revision 指定で落とした
    // （ネストした）ファイルが同じキャッシュディレクトリに同居するケース
    // （CI の example-chat ジョブで実際に起きている——本文参照）。
    expect(normalizeActualPath("config.json", REVISION)).toBe("config.json");
  });
});

describe("formatFingerprintReport", () => {
  it("match のとき、一致した本数を報告する", () => {
    const report = formatFingerprintReport({
      verdict: "match",
      matched: ["a", "b"],
      mismatched: [],
      unknownOnDisk: [],
    });
    expect(report).toContain("2");
    expect(report).toContain("一致");
  });

  it("mismatch のとき、食い違った path ごとに期待と実物の hex を並べる", () => {
    const report = formatFingerprintReport({
      verdict: "mismatch",
      matched: [],
      mismatched: [
        {
          path: "config.json",
          expected: { algorithm: "git-blob-sha1", hex: "expected-hex" },
          actual: { algorithm: "git-blob-sha1", hex: "actual-hex" },
        },
      ],
      unknownOnDisk: ["mystery.bin"],
    });
    expect(report).toContain("config.json");
    expect(report).toContain("expected-hex");
    expect(report).toContain("actual-hex");
    expect(report).toContain("mystery.bin");
  });

  it("mismatch かつ actual が空のとき、専用の文面を返す", () => {
    const report = formatFingerprintReport({
      verdict: "mismatch",
      matched: [],
      mismatched: [],
      unknownOnDisk: [],
    });
    expect(report).toContain("1本も無い");
  });
});
