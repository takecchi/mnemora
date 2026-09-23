/**
 * `scripts/measure-embedding-output-fingerprint.mjs`（固定入力に対する embedding 出力を
 * sha256/次元数/CPU 情報とともに1つの測定 JSON へ合成する CLI）の**純関数の側**。
 * ファイル I/O・`child_process`・`process.exit` を一切持たない——`retrieval-quality-summary.mjs`
 * / `retrieval-quality-summary-lib.mjs` と同じ分担（Issue #565、ADR 0253 追記）。
 *
 * ## この module が受け取るもの
 *
 * **本物のモデルは呼ばない。**`examples/chat` の `embedding-fingerprint` サブコマンド
 * （`tsx` 経由、`@mnemora/local-embedding` を直接 import できる場所）が既に `embed()` を
 * 呼び終えた**生のベクトル**（`MNEMORA_EMBEDDING_FINGERPRINT_RAW_JSON` が書く JSON）を
 * 受け取り、ここでは
 *
 * 1. ベクトルを決まった形でバイト列にし、`sha256` を取る（{@link serializeVectorsToBytes} /
 *    {@link sha256HexOfVectors}）。
 * 2. `lscpu`（または `/proc/cpuinfo`）の生テキストから、比較に効く欄だけを取り出す
 *    （{@link parseLscpuText} / {@link parseProcCpuinfoText}）。
 * 3. 1と2を1つの測定 JSON にまとめる（{@link buildFingerprintRecord}）。
 *
 * だけを行う。
 *
 * ## ⛔ これは門ではない
 *
 * この module の関数はどれも「壊れているかどうか」（入力の形が測定結果として使えるか）
 * しか判定しない。**値の良し悪しは判定しない**——それは
 * `scripts/compare-embedding-output-fingerprints-lib.mjs` の役目でもなく、
 * どの module の役目でもない（Issue #565 は「測るだけ。門にはしない」と明示している）。
 *
 * ## バイト列化の形を固定する理由（Issue #565 の歯1）
 *
 * **成分の並べ替えをしてはいけない。**ベクトルは「候補間の相対的な向き」ではなく
 * 「成分ごとの値」を比較したいので、`embed()` が返した順序をそのまま保持する。
 * 並べ替えてから hash すると、成分が入れ替わっただけの異なるベクトルを同じ hash に
 * してしまい、歯1（1成分でも違えば違う hash になる）が意味を失う。
 */

import { createHash } from "node:crypto";

/**
 * ベクトルの配列を、決まった形のバイト列にする。
 *
 * **形（固定する）**: 各ベクトルの各成分を、渡された順序のまま IEEE754 倍精度
 * リトルエンディアン（8バイト）で連結する。ベクトルの境界・成分の順序のどちらも
 * 並べ替えない——⛔ ソートしない。
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
 * ベクトルの配列の `sha256` 16進文字列。
 *
 * @param {number[][]} vectors
 * @returns {string}
 */
export function sha256HexOfVectors(vectors) {
  return createHash("sha256").update(serializeVectorsToBytes(vectors)).digest("hex");
}

/**
 * ベクトルの配列が持つ次元数。全ベクトルで揃っていなければ `null`
 * （`LocalEmbeddingProvider` は1インスタンス=1 `EmbeddingSpaceId` の契約を持つため、
 * 実運用では揃わないことは無いはずだが、測定 JSON が壊れていた場合に気づけるようにする）。
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

/** `lscpu` の出力から取り出す欄。比較に効くもの（モデル名・アーキテクチャ・フラグの有無）に絞る。 */
const LSCPU_FIELDS = ["Architecture", "Vendor ID", "Model name", "CPU(s)", "Flags"];

/**
 * `lscpu` の生テキストを `{ 欄名: 値 }` に変換する。
 *
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
 * `/proc/cpuinfo` の生テキストから、`lscpu` に無い環境向けの最小限の欄を取り出す
 * （`lscpu` が使えないランナーの保険。Issue #565「採るとしたら何が要るか」3番
 * 「`lscpu`（または `/proc/cpuinfo`）」）。**最初のプロセッサエントリだけを見る**——
 * 同種コアである前提（比較に使う2ジョブはどちらも `ubuntu-latest` の単一 VM であり、
 * ヘテロジニアスコア構成は想定しない）。
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
 * `examples/chat` の `embedding-fingerprint` サブコマンドが書いた生 JSON（パース済み）の
 * 形を検査する。
 *
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
 * 生測定 JSON・CPU 情報・実行時刻・runner 名から、1つの測定 JSON（artifact として
 * 残す最終形）を組み立てる。
 *
 * **`status: "weights_unavailable"` のときは sha256/dimensions/embeddingSpace を
 * 持たない**——欄が無いこと自体が「測っていない」を表す（`identifier-json.ts` /
 * ADR 0008「無いには種類がある」と同じ形）。
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
