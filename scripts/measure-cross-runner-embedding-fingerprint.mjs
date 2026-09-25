#!/usr/bin/env node
/**
 * `.github/workflows/embedding-cross-runner-reproducibility.yml` の各脚（matrix: runner ×
 * numThreads × rep）が、`examples/chat` の `embedding-fingerprint` サブコマンドが書いた
 * 生ベクトル JSON（`--raw`）と、この CLI 自身が集める `lscpu`（無ければ `/proc/cpuinfo`）・
 * matrix の値から、1脚分の測定 JSON（`--out`）を書き出す CLI（Issue #565）。
 *
 * `scripts/measure-embedding-output-fingerprint.mjs`（2ジョブ比較の既存の測る段）と
 * ほぼ同じ形だが、次の3点が違う:
 *
 * 1. **float32 として** sha256・ビットパターンを持つ（{@link
 *    ../cross-runner-embedding-fingerprint-lib.mjs} の `sha256HexOfFloat32Vectors` /
 *    `vectorsToFloat32Hex`）——`measure-embedding-output-fingerprint-lib.mjs` の
 *    `sha256HexOfVectors` は float64 表現である（別の値。混同しないこと）。
 * 2. **`--runner-label` / `--num-threads` / `--rep` を必須で受け取る**——matrix の脚を
 *    識別する軸そのものであり、`--raw` の中身（`embedding-fingerprint.ts` が書いた
 *    `numThreads` フィールドと重複するが、`--num-threads` は「matrix が指定した値」、
 *    `--raw` の `numThreads` は「provider が実際に使った値」——通常は一致するはずだが、
 *    ここでは配線側の値（matrix）を脚の識別に使う。⚠ 食い違えば `note` に残す）。
 * 3. `--raw` が既に持つ `runtimeVersions` / `weightsDigest` / `numThreads` をそのまま
 *    測定 JSON へ転記する（embed() を呼んだ側でしか取れない情報であり、ここでは
 *    再取得しない）。
 *
 * 使い方:
 *   node scripts/measure-cross-runner-embedding-fingerprint.mjs \
 *     --raw <path> --out <path> \
 *     --runner-label <label> --runner-name <name> --rep <n>
 *
 * ⛔ **このスクリプトは門ではない。**`status: "ok"` になる限り、値の良し悪しは判定
 * しない——非0で終わるのは、`--raw` の中身が測定結果として使えない（壊れている）ときだけ
 * である。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  parseLscpuText,
  parseProcCpuinfoText,
} from "./measure-embedding-output-fingerprint-lib.mjs";
import {
  sha256HexOfFloat32Vectors,
  vectorsToFloat32Hex,
} from "./cross-runner-embedding-fingerprint-lib.mjs";

const args = process.argv.slice(2);

function readArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

const rawPath = readArgValue("--raw");
const outPath = readArgValue("--out");
const runnerLabel = readArgValue("--runner-label");
const runnerName = readArgValue("--runner-name") ?? null;
const repRaw = readArgValue("--rep");

if (!rawPath || !outPath || !runnerLabel || !repRaw) {
  console.error(
    "使い方: node scripts/measure-cross-runner-embedding-fingerprint.mjs " +
      "--raw <path> --out <path> --runner-label <label> [--runner-name <name>] --rep <n>",
  );
  process.exit(1);
}

const rep = Number(repRaw);
if (!Number.isInteger(rep) || rep < 1) {
  console.error(`--rep が正の整数ではない: ${JSON.stringify(repRaw)}`);
  process.exit(1);
}

let rawText;
try {
  rawText = readFileSync(rawPath, "utf8");
} catch (err) {
  console.error(`生測定 JSON を読めない（${rawPath}）: ${err.message}`);
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(rawText);
} catch (err) {
  console.error(`生測定 JSON の parse に失敗した（${rawPath}）: ${err.message}`);
  process.exit(1);
}

if (raw.status !== "ok" && raw.status !== "weights_unavailable") {
  console.error(`生測定 JSON の status が想定外である: ${JSON.stringify(raw.status)}`);
  process.exit(1);
}

/**
 * `lscpu` を試し、無ければ `/proc/cpuinfo` を試す（`measure-embedding-output-fingerprint.mjs`
 * の `collectCpuInfo` と同じ形）。
 *
 * @returns {Record<string, unknown>}
 */
function collectCpuInfo() {
  const lscpu = spawnSync("lscpu", [], { encoding: "utf8" });
  if (lscpu.status === 0 && typeof lscpu.stdout === "string") {
    return { source: "lscpu", ...parseLscpuText(lscpu.stdout) };
  }
  try {
    const cpuinfoText = readFileSync("/proc/cpuinfo", "utf8");
    return { source: "/proc/cpuinfo", ...parseProcCpuinfoText(cpuinfoText) };
  } catch (err) {
    return {
      unavailable: true,
      reason:
        `lscpu も /proc/cpuinfo も読めなかった` +
        `（lscpu: ${lscpu.error ? String(lscpu.error.message) : `exit ${lscpu.status}`} / ` +
        `/proc/cpuinfo: ${err.message}）`,
    };
  }
}

const cpuInfo = collectCpuInfo();
const measuredAt = new Date().toISOString();
const arch = process.arch;

/** @type {Record<string, unknown>} */
const base = {
  runnerLabel,
  runnerName,
  arch,
  rep,
  measuredAt,
  cpuInfo,
  numThreads: raw.numThreads ?? null,
  runtimeVersions: raw.runtimeVersions ?? null,
  weightsDigest: raw.weightsDigest ?? null,
};

if (raw.status === "weights_unavailable") {
  const out = { status: "weights_unavailable", detail: raw.detail, ...base };
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(
    `固定入力の embedding 出力の指紋（ランナー間比較、重み取得失敗）を書き出した: ${outPath}`,
  );
  process.exit(0);
}

if (!Array.isArray(raw.vectors) || raw.vectors.length === 0) {
  console.error("生測定 JSON の status=ok だが vectors 配列が無い、または空である");
  process.exit(1);
}
for (const vector of raw.vectors) {
  if (!Array.isArray(vector) || vector.some((component) => typeof component !== "number")) {
    console.error("生測定 JSON の vectors の要素が number[] でない");
    process.exit(1);
  }
}

const dims = raw.vectors[0].length;
const dimensions = raw.vectors.every((v) => v.length === dims) ? dims : null;
if (dimensions === null) {
  console.error("vectors の次元数がベクトル間で揃っていない");
  process.exit(1);
}

const out = {
  status: "ok",
  detail: raw.detail,
  ...base,
  embeddingSpace: raw.embeddingSpace,
  inputs: raw.inputs,
  vectors: raw.vectors,
  vectorsFloat32Hex: vectorsToFloat32Hex(raw.vectors),
  sha256Float32: sha256HexOfFloat32Vectors(raw.vectors),
  dimensions,
  vectorCount: raw.vectors.length,
};

writeFileSync(outPath, `${JSON.stringify(out)}\n`, "utf8");
console.log(`固定入力の embedding 出力の指紋（ランナー間比較）を書き出した: ${outPath}`);
process.exit(0);
