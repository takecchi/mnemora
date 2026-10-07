#!/usr/bin/env node
/**
 * ⛔ 門ではない。`status: "ok"` になる限り値の良し悪しは判定しない。非0になるのは `--raw` の中身が測定結果として使えないときだけ。
 * ⛔ `lscpu` も `/proc/cpuinfo` も失敗したときは、`{ unavailable: true, reason }` を CPU 情報として使い、黙って空にしない。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  buildFingerprintRecord,
  parseLscpuText,
  parseProcCpuinfoText,
} from "./measure-embedding-output-fingerprint-lib.mjs";

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
const runnerName = readArgValue("--runner-name") ?? null;

if (!rawPath || !outPath) {
  console.error(
    "使い方: node scripts/measure-embedding-output-fingerprint.mjs --raw <path> --out <path> [--runner-name <name>]",
  );
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

/**
 * どちらも失敗したことを黙って空のオブジェクトにしない。後段(比較段)が「測っていない」ことに気づけるよう、CPU 情報の中に残す。
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

const built = buildFingerprintRecord({ raw, cpuInfo, measuredAt, runnerName });
if (!built.ok) {
  console.error(built.error);
  process.exit(1);
}

writeFileSync(outPath, `${JSON.stringify(built.value, null, 2)}\n`, "utf8");
console.log(`固定入力の embedding 出力の指紋を書き出した: ${outPath}`);
process.exit(0);
