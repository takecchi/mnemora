/**
 * ⛔ これは門ではない。判定するのは入力が測定結果として使える形かどうかだけで、値の良し悪しは判定しない。
 *
 * 成分の並べ替えをしない。`embed()` が返した順序を保持する。並べ替えてから hash すると、成分が
 * 入れ替わっただけの別のベクトルが同じ hash になり、1成分でも違えば違う hash になる前提が崩れる。
 */

import { createHash } from "node:crypto";

/**
 * ⛔ ベクトルの境界も成分の順序も、ソートしない。
 *
 * @param {number[][]} vectors
 * @returns {Buffer}
 */
export function serializeVectorsToBytes(vectors) {
  const totalComponents = vectors.reduce((sum, vector) => sum + vector.length, 0);
  const buffer = Buffer.alloc(totalComponents * 8);
  let offset = 0;
  for (const vector of vectors) {
    for (const component of vector) {
      buffer.writeDoubleLE(component, offset);
      offset += 8;
    }
  }
  return buffer;
}

/**
 * @param {number[][]} vectors
 * @returns {string}
 */
export function sha256HexOfVectors(vectors) {
  return createHash("sha256").update(serializeVectorsToBytes(vectors)).digest("hex");
}

/**
 * 揃っていなければ `null`。測定 JSON が壊れていたときに気づけるようにするため。
 *
 * @param {number[][]} vectors
 * @returns {number | null}
 */
export function vectorDimensions(vectors) {
  if (vectors.length === 0) {
    return null;
  }
  const first = vectors[0].length;
  const uniform = vectors.every((vector) => vector.length === first);
  return uniform ? first : null;
}

const LSCPU_FIELDS = ["Architecture", "Vendor ID", "Model name", "CPU(s)", "Flags"];

/**
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseLscpuText(text) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of text.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!LSCPU_FIELDS.includes(key)) {
      continue;
    }
    fields[key] = line.slice(separatorIndex + 1).trim();
  }
  return fields;
}

/**
 * 最初のプロセッサエントリだけを見る。比較に使う2ジョブはどちらも単一 VM で、ヘテロジニアスコア構成は想定しない。
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseProcCpuinfoText(text) {
  /** @type {Record<string, string>} */
  const fields = {};
  const firstEntry = text.split("\n\n")[0] ?? "";
  for (const line of firstEntry.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key === "model name") {
      fields["Model name"] = value;
    } else if (key === "flags") {
      fields["Flags"] = value;
    } else if (key === "vendor_id") {
      fields["Vendor ID"] = value;
    }
  }
  return fields;
}

/**
 * @param {unknown} data
 * @returns {{ ok: true, value: { status: "ok" | "weights_unavailable", detail: string, embeddingSpace?: Record<string, unknown>, inputs?: string[], vectors?: number[][] } } | { ok: false, error: string }}
 */
export function validateRawFingerprintJson(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "生測定 JSON がオブジェクトでない" };
  }
  const value = /** @type {{ status?: unknown, detail?: unknown, vectors?: unknown }} */ (data);
  if (value.status !== "ok" && value.status !== "weights_unavailable") {
    return {
      ok: false,
      error: `生測定 JSON の status が想定外である: ${JSON.stringify(value.status)}`,
    };
  }
  if (typeof value.detail !== "string") {
    return { ok: false, error: "生測定 JSON に detail (string) が無い" };
  }
  if (value.status === "ok") {
    if (!Array.isArray(value.vectors) || value.vectors.length === 0) {
      return { ok: false, error: "status=ok なのに vectors 配列が無い、または空である" };
    }
    for (const vector of value.vectors) {
      if (!Array.isArray(vector) || vector.some((component) => typeof component !== "number")) {
        return { ok: false, error: "vectors の要素が number[] でない" };
      }
    }
  }
  return {
    ok: true,
    value:
      /** @type {{ status: "ok" | "weights_unavailable", detail: string, embeddingSpace?: Record<string, unknown>, inputs?: string[], vectors?: number[][] }} */ (
        data
      ),
  };
}

/**
 * `status: "weights_unavailable"` のときは sha256/dimensions/embeddingSpace を持たない。
 * 欄が無いこと自体が「測っていない」を表す。
 *
 * @param {{ raw: unknown, cpuInfo: Record<string, unknown>, measuredAt: string, runnerName: string | null }} input
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function buildFingerprintRecord({ raw, cpuInfo, measuredAt, runnerName }) {
  const validated = validateRawFingerprintJson(raw);
  if (!validated.ok) {
    return validated;
  }
  const value = validated.value;

  if (value.status === "weights_unavailable") {
    return {
      ok: true,
      value: {
        status: "weights_unavailable",
        detail: value.detail,
        measuredAt,
        runnerName,
        cpuInfo,
      },
    };
  }

  const vectors = /** @type {number[][]} */ (value.vectors);
  const dimensions = vectorDimensions(vectors);
  if (dimensions === null) {
    return { ok: false, error: "vectors の次元数がベクトル間で揃っていない" };
  }

  return {
    ok: true,
    value: {
      status: "ok",
      detail: value.detail,
      sha256: sha256HexOfVectors(vectors),
      dimensions,
      vectorCount: vectors.length,
      embeddingSpace: value.embeddingSpace,
      inputs: value.inputs,
      measuredAt,
      runnerName,
      cpuInfo,
    },
  };
}
