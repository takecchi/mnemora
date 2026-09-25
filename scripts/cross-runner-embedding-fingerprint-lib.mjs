/**
 * `.github/workflows/embedding-cross-runner-reproducibility.yml`（Issue #565「採るとしたら
 * 何が要るか」の測定を、複数 runner × `numThreads` × 反復（rep）へ広げる workflow）が使う
 * **純関数の側**。ファイル I/O・`process.argv`・`process.exit` を一切持たない
 * （`compare-embedding-output-fingerprints-lib.mjs` と同じ分担）。
 *
 * ⛔ **この module も門ではない。**`classifyLegPair` が返す `"mismatch"` は「値が違った」
 * という観測であって、良し悪しの判定ではない——呼び出し側のどこも exit code を
 * 非0にしない（`.github/workflows/embedding-cross-runner-reproducibility.yml` の比較
 * ジョブは常に成功する設計にする）。
 *
 * ## この module が持つ3つの塊
 *
 * 1. **脚（leg）の識別**——runner label × numThreads × rep の組を、artifact 名・ジョブ内の
 *    matrix 値の両方から同じ形に正規化する（{@link crossRunnerLegId} /
 *    {@link crossRunnerArtifactName} / {@link parseCrossRunnerArtifactName}）。
 *    ⚠ **`CROSS_RUNNER_RUNNERS` / `CROSS_RUNNER_NUM_THREADS` / `CROSS_RUNNER_REPS` は
 *    workflow の matrix と二重管理である**（`EMBEDDING_FINGERPRINT_JOBS` と同じ形）。
 *    ずれたら `scripts/__tests__/embedding-cross-runner-reproducibility-workflow-wiring.test.mjs`
 *    が赤くなる。
 * 2. **float32 ビット列としての比較**——`embed()` の出力は internally float32（onnxruntime
 *    は float32 で計算する）だが、JS の `number` は double なので、値をそのまま比較すると
 *    「double としては違うが float32 としては同じ」を見落とす・逆に「float32 として全く
 *    無関係な丸め誤差」を過大に見る、という取り違えが起こる。⟹ 比較の前に必ず
 *    `Math.fround`（float32 への丸め）を通す（{@link ulpDistanceFloat32} /
 *    {@link float32BitsHex} / {@link sha256HexOfFloat32Vectors}）。
 * 3. **群ごとの比較**——基準脚（{@link CROSS_RUNNER_BASELINE_LEG_ID}、
 *    `ubuntu-latest` / `numThreads=4` / `rep=1`）に対する各脚の差分
 *    （{@link buildBaselineComparisons}）と、脚同士のペアワイズ比較を条件で束ねた群の要約
 *    （{@link buildGroupSummaries}）。
 *
 * ## `"incomparable"` を `"match"` にしない
 *
 * `classifyLegPair` は、artifact が無い・読めない・`weights_unavailable`・vectors の形が
 * 崩れている、のいずれかを **必ず `"incomparable"` として返す**——`"match"`／`"mismatch"`
 * のどちらにも倒さない。`AGENTS.md`「⚠『出なかった』を、事象が無いことの証明にしない」の
 * 適用（`compare-embedding-output-fingerprints-lib.mjs` と同じ形）。
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 1. 脚（leg）の識別 —— workflow の matrix と二重管理（ここが唯一の宣言）
// ---------------------------------------------------------------------------

/**
 * matrix が回す runner。`label` は GitHub Actions の `runs-on:` にそのまま渡る値、
 * `arch` はこの measurement が期待するアーキテクチャ（実測でも `uname -m` 等と突き合わせる
 * ——{@link buildGroupSummaries} が信じるのは実測の `leg.arch` であり、ここの `arch` は
 * 「意図した値」でしかない）。
 *
 * @type {ReadonlyArray<{ label: string, arch: "x64" | "arm64" }>}
 */
export const CROSS_RUNNER_RUNNERS = Object.freeze([
  Object.freeze({ label: "ubuntu-latest", arch: "x64" }),
  Object.freeze({ label: "ubuntu-24.04-arm", arch: "arm64" }),
  Object.freeze({ label: "ubuntu-22.04", arch: "x64" }),
  Object.freeze({ label: "ubuntu-22.04-arm", arch: "arm64" }),
]);

/** @type {ReadonlyArray<number>} */
export const CROSS_RUNNER_NUM_THREADS = Object.freeze([1, 2, 4]);

/** @type {ReadonlyArray<number>} */
export const CROSS_RUNNER_REPS = Object.freeze([1, 2]);

/** artifact 名の prefix。この後に `--runner-<label>--nt-<n>--rep-<r>` が続く。 */
export const CROSS_RUNNER_ARTIFACT_PREFIX = "cross-runner-embedding-fingerprint";

/**
 * runner label・numThreads・rep から、比較段が使う脚の識別子を作る。
 *
 * ⚠ **区切りに `--`（ハイフン2連）を使う。** `CROSS_RUNNER_RUNNERS` の label
 * （`ubuntu-24.04-arm` 等）は単発のハイフンとピリオドを含むが `--` は含まない
 * ——含むようになったら、この関数と {@link parseCrossRunnerArtifactName} の
 * 正規表現を両方直すこと。
 *
 * @param {string} runnerLabel
 * @param {number} numThreads
 * @param {number} rep
 * @returns {string}
 */
export function crossRunnerLegId(runnerLabel, numThreads, rep) {
  return `runner-${runnerLabel}--nt-${numThreads}--rep-${rep}`;
}

/**
 * `crossRunnerLegId` を artifact 名（`actions/upload-artifact` の `name:`）へ変換する。
 *
 * @param {string} runnerLabel
 * @param {number} numThreads
 * @param {number} rep
 * @returns {string}
 */
export function crossRunnerArtifactName(runnerLabel, numThreads, rep) {
  return `${CROSS_RUNNER_ARTIFACT_PREFIX}--${crossRunnerLegId(runnerLabel, numThreads, rep)}`;
}

/**
 * artifact 名（ディレクトリ名）から `{ runnerLabel, numThreads, rep }` を復元する。
 * 形が合わなければ `null`（この module は「読めない」を投げずに `null` で返す一貫した
 * 作法を取る——呼び出し側が判断する）。
 *
 * @param {string} artifactName
 * @returns {{ runnerLabel: string, numThreads: number, rep: number } | null}
 */
export function parseCrossRunnerArtifactName(artifactName) {
  const re = /^cross-runner-embedding-fingerprint--runner-(.+)--nt-(\d+)--rep-(\d+)$/;
  const match = re.exec(artifactName);
  if (!match) {
    return null;
  }
  return {
    runnerLabel: /** @type {string} */ (match[1]),
    numThreads: Number(match[2]),
    rep: Number(match[3]),
  };
}

/**
 * matrix が回すべき脚の全量（`CROSS_RUNNER_RUNNERS` × `CROSS_RUNNER_NUM_THREADS` ×
 * `CROSS_RUNNER_REPS`）。比較段が「artifact が1つも無い脚」（ジョブ自体が起動すら
 * しなかった等）を「比較できなかった」として名指しするために使う——`present: false`
 * の脚を暗黙に無視しない。
 *
 * @returns {{ id: string, artifactName: string, runnerLabel: string, arch: "x64" | "arm64", numThreads: number, rep: number }[]}
 */
export function allExpectedCrossRunnerLegs() {
  const legs = [];
  for (const runner of CROSS_RUNNER_RUNNERS) {
    for (const numThreads of CROSS_RUNNER_NUM_THREADS) {
      for (const rep of CROSS_RUNNER_REPS) {
        legs.push({
          id: crossRunnerLegId(runner.label, numThreads, rep),
          artifactName: crossRunnerArtifactName(runner.label, numThreads, rep),
          runnerLabel: runner.label,
          arch: runner.arch,
          numThreads,
          rep,
        });
      }
    }
  }
  return legs;
}

/** 基準脚（Issue #565 が指定した比較の基点）: `ubuntu-latest` / `numThreads=4` / `rep=1`。 */
export const CROSS_RUNNER_BASELINE_LEG_ID = crossRunnerLegId("ubuntu-latest", 4, 1);

// ---------------------------------------------------------------------------
// 2. float32 ビット列としての比較
// ---------------------------------------------------------------------------

/**
 * IEEE754 単精度（float32）のビットパターンを、8桁の16進文字列にする。
 * **big-endian（MSB が先頭）で表示する**——符号・指数・仮数を人が読む慣習に合わせるため
 * （バイト列としての並びの規約ではなく、あくまで表示上の規約。{@link sha256HexOfFloat32Vectors}
 * のバイト列化とは独立な選択であり、混同しないこと）。
 *
 * @param {number} value
 * @returns {string}
 */
export function float32BitsHex(value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(Math.fround(value), 0);
  return buf.toString("hex");
}

/**
 * ベクトルの配列（渡された順序のまま、⛔ 並べ替えない）を、float32 の符号なし32bit整数の
 * 配列に変換する（内部用、bit 演算の材料）。
 *
 * @param {number} value
 * @returns {number}
 */
function float32Uint32Bits(value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(Math.fround(value), 0);
  return buf.readUInt32LE(0);
}

/**
 * float32 の32bit表現を、大小関係を保った符号なし整数へ写す（Bruce Dawson の
 * "Comparing Floating Point Numbers" が示す標準的な ULP 距離の作り方）。
 * 符号ビットが立っていれば `0x100000000 - bits`、立っていなければ `bits + 0x80000000`。
 * **`+0` と `-0` は同じ順序値になる**（両者の ULP 距離は0——符号だけの違いを
 * 「1 ULP 離れている」と数えない）。
 *
 * @param {number} bits 符号なし32bit整数
 * @returns {number}
 */
function orderedFromFloat32Bits(bits) {
  return (bits & 0x80000000) !== 0 ? 0x100000000 - bits : bits + 0x80000000;
}

/**
 * 2つの数値を float32 に丸めたうえでの ULP（Unit in the Last Place）距離。
 * `NaN`／`Infinity` が絡む場合は `null`（「距離」という概念が無いことを、0 で
 * ごまかさない）。
 *
 * @param {number} a
 * @param {number} b
 * @returns {number | null}
 */
export function ulpDistanceFloat32(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return null;
  }
  const orderedA = orderedFromFloat32Bits(float32Uint32Bits(a));
  const orderedB = orderedFromFloat32Bits(float32Uint32Bits(b));
  return Math.abs(orderedA - orderedB);
}

/**
 * 2つの数値が「十進で何桁目の有効数字から食い違うか」（1始まり）。
 * 完全に一致していれば `null`。
 *
 * - 符号が違えば（0 同士を除く）1（最初の桁から食い違う）。
 * - 10 の指数（桁数）が違えば1。
 * - 指数が同じなら、仮数部の桁を先頭から比較し、最初に違う桁の位置（1始まり）を返す。
 *
 * @param {number} a
 * @param {number} b
 * @param {number} precision 比較する有効数字の桁数(既定15——double が確実に持つ桁数)
 * @returns {number | null}
 */
export function firstDivergentSignificantDigit(a, b, precision = 15) {
  if (Object.is(a, b) || a === b) {
    return null;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return 1;
  }
  if (a === 0 || b === 0) {
    // a === b (含む 0 === 0) は上で弾いてある——ここに来るのは片方だけ0のとき。
    return 1;
  }
  const signA = a < 0 ? -1 : 1;
  const signB = b < 0 ? -1 : 1;
  if (signA !== signB) {
    return 1;
  }
  const expA = Math.floor(Math.log10(Math.abs(a)));
  const expB = Math.floor(Math.log10(Math.abs(b)));
  if (expA !== expB) {
    return 1;
  }
  const digitsA = Math.abs(a)
    .toExponential(precision - 1)
    .split(/e/i)[0]
    .replace(".", "");
  const digitsB = Math.abs(b)
    .toExponential(precision - 1)
    .split(/e/i)[0]
    .replace(".", "");
  const len = Math.min(digitsA.length, digitsB.length);
  for (let i = 0; i < len; i += 1) {
    if (digitsA[i] !== digitsB[i]) {
      return i + 1;
    }
  }
  return null;
}

/**
 * ベクトルの配列を、float32 のリトルエンディアン4バイトで連結したバイト列にする。
 * ⛔ 並べ替えない——`measure-embedding-output-fingerprint-lib.mjs` の
 * `serializeVectorsToBytes`（float64 版）と同じ形の float32 版。
 *
 * @param {number[][]} vectors
 * @returns {Buffer}
 */
export function serializeVectorsToFloat32Bytes(vectors) {
  const totalComponents = vectors.reduce((sum, vector) => sum + vector.length, 0);
  const buffer = Buffer.alloc(totalComponents * 4);
  let offset = 0;
  for (const vector of vectors) {
    for (const component of vector) {
      buffer.writeFloatLE(Math.fround(component), offset);
      offset += 4;
    }
  }
  return buffer;
}

/**
 * ベクトルの配列の、float32 表現での sha256 16進文字列。
 *
 * @param {number[][]} vectors
 * @returns {string}
 */
export function sha256HexOfFloat32Vectors(vectors) {
  return createHash("sha256").update(serializeVectorsToFloat32Bytes(vectors)).digest("hex");
}

/**
 * ベクトルの配列を、成分ごとの float32 ビットパターン（16進）の配列に変換する
 * （artifact に残す「ビット列を hex で丸ごと」の実体）。
 *
 * @param {number[][]} vectors
 * @returns {string[][]}
 */
export function vectorsToFloat32Hex(vectors) {
  return vectors.map((vector) => vector.map((component) => float32BitsHex(component)));
}

/**
 * 2組のベクトル集合を突き合わせ、成分ごとの統計を返す。
 *
 * ⚠ **本数・成分数が違えば `comparable: false`。** 次元が違うベクトル同士に対して
 * 「最大絶対差」を語ることに意味は無い。
 *
 * @param {number[][]} vectorsA
 * @param {number[][]} vectorsB
 * @returns {
 *   | { comparable: false, reason: string }
 *   | {
 *       comparable: true,
 *       totalComponents: number,
 *       mismatchComponentCount: number,
 *       maxAbsDiff: number,
 *       maxUlpDiff: number,
 *       firstDivergentSignificantDigit: number | null,
 *       cosineSimilarity: number | null,
 *     }
 * }
 */
export function compareVectorSets(vectorsA, vectorsB) {
  if (vectorsA.length !== vectorsB.length) {
    return {
      comparable: false,
      reason: `ベクトルの本数が違う（${vectorsA.length} と ${vectorsB.length}）`,
    };
  }
  const flatA = vectorsA.flat();
  const flatB = vectorsB.flat();
  if (flatA.length !== flatB.length) {
    return {
      comparable: false,
      reason: `成分の総数が違う（${flatA.length} と ${flatB.length}）——次元数がベクトル間で揃っていない`,
    };
  }
  if (flatA.length === 0) {
    return { comparable: false, reason: "ベクトルが空である" };
  }

  let maxAbsDiff = 0;
  let maxUlpDiff = 0;
  let mismatchComponentCount = 0;
  /** @type {number | null} */
  let worstDivergentDigit = null;
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < flatA.length; i += 1) {
    const a = /** @type {number} */ (flatA[i]);
    const b = /** @type {number} */ (flatB[i]);
    const absDiff = Math.abs(a - b);
    if (absDiff > maxAbsDiff) {
      maxAbsDiff = absDiff;
    }
    const ulp = ulpDistanceFloat32(a, b);
    if (ulp !== null && ulp > maxUlpDiff) {
      maxUlpDiff = ulp;
    }
    if (!Object.is(a, b) && a !== b) {
      mismatchComponentCount += 1;
      const digit = firstDivergentSignificantDigit(a, b);
      if (digit !== null && (worstDivergentDigit === null || digit < worstDivergentDigit)) {
        worstDivergentDigit = digit;
      }
    }
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  const cosineSimilarity =
    normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : null;

  return {
    comparable: true,
    totalComponents: flatA.length,
    mismatchComponentCount,
    maxAbsDiff,
    maxUlpDiff,
    firstDivergentSignificantDigit: worstDivergentDigit,
    cosineSimilarity,
  };
}

// ---------------------------------------------------------------------------
// 3. 脚同士の判定と、群ごとの要約
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CrossRunnerLeg
 * @property {string} id `crossRunnerLegId` の戻り値
 * @property {string} runnerLabel
 * @property {"x64" | "arm64" | string} arch **実測値**（意図ではない。宣言と食い違えば
 *   別途「宣言と食い違う」欄で分かるようにする——ここでは信じて使うだけ）
 * @property {number} numThreads
 * @property {number} rep
 * @property {boolean} present artifact が存在したか
 * @property {string} [error] 存在したが読めない/parse できなかった理由
 * @property {Record<string, unknown>} [record] 読めた測定 JSON(パース済み)
 */

/**
 * 2つの脚を突き合わせる。🔴 **どの分岐でも exit code を決めない**（この module 全体の
 * 決まりごと、上の docstring 参照）。
 *
 * @param {CrossRunnerLeg} legA
 * @param {CrossRunnerLeg} legB
 * @returns {
 *   | { status: "incomparable", reason: string }
 *   | ({ status: "match" | "mismatch", sha256A: string, sha256B: string } & ReturnType<typeof compareVectorSets> extends infer R ? R : never)
 * }
 */
export function classifyLegPair(legA, legB) {
  const missing = [legA, legB].filter((leg) => !leg.present).map((leg) => leg.id);
  if (missing.length > 0) {
    return {
      status: "incomparable",
      reason: `${missing.join(" と ")} の artifact が無いため、比較できなかった（一致とも不一致とも言わない）。`,
    };
  }
  const broken = [legA, legB].filter((leg) => leg.error).map((leg) => `${leg.id}: ${leg.error}`);
  if (broken.length > 0) {
    return {
      status: "incomparable",
      reason: `測定 JSON が読めなかった（${broken.join(" / ")}）ため、比較できなかった。`,
    };
  }
  const recordA = /** @type {Record<string, unknown>} */ (legA.record);
  const recordB = /** @type {Record<string, unknown>} */ (legB.record);

  const unavailable = [legA, legB]
    .filter(
      (leg) =>
        /** @type {Record<string, unknown>} */ (leg.record)?.status === "weights_unavailable",
    )
    .map((leg) => leg.id);
  if (unavailable.length > 0) {
    return {
      status: "incomparable",
      reason: `${unavailable.join(" と ")} で重みを取得できなかったため、比較できなかった。`,
    };
  }

  const vectorsA = recordA?.vectors;
  const vectorsB = recordB?.vectors;
  if (!Array.isArray(vectorsA) || !Array.isArray(vectorsB)) {
    return {
      status: "incomparable",
      reason: "vectors が欠けている測定 JSON がある（形が壊れている）。",
    };
  }

  const comparison = compareVectorSets(
    /** @type {number[][]} */ (vectorsA),
    /** @type {number[][]} */ (vectorsB),
  );
  if (!comparison.comparable) {
    return { status: "incomparable", reason: comparison.reason };
  }

  const sha256A = typeof recordA.sha256Float32 === "string" ? recordA.sha256Float32 : null;
  const sha256B = typeof recordB.sha256Float32 === "string" ? recordB.sha256Float32 : null;
  if (sha256A === null || sha256B === null) {
    return {
      status: "incomparable",
      reason: "sha256Float32 が欠けている測定 JSON がある（形が壊れている）。",
    };
  }

  const status = sha256A === sha256B ? "match" : "mismatch";
  return { status, sha256A, sha256B, ...comparison };
}

/**
 * 全脚を基準脚（`baselineId`）と突き合わせる。
 *
 * @param {CrossRunnerLeg[]} legs
 * @param {string} baselineId
 * @returns {{ baselinePresent: boolean, comparisons: { legId: string, result: ReturnType<typeof classifyLegPair> }[] }}
 */
export function buildBaselineComparisons(legs, baselineId) {
  const baseline = legs.find((leg) => leg.id === baselineId);
  if (!baseline || !baseline.present) {
    return {
      baselinePresent: false,
      comparisons: legs
        .filter((leg) => leg.id !== baselineId)
        .map((leg) => ({
          legId: leg.id,
          result: /** @type {ReturnType<typeof classifyLegPair>} */ ({
            status: "incomparable",
            reason: `基準脚（${baselineId}）の artifact が無いため、比較できなかった。`,
          }),
        })),
    };
  }
  return {
    baselinePresent: true,
    comparisons: legs
      .filter((leg) => leg.id !== baselineId)
      .map((leg) => ({ legId: leg.id, result: classifyLegPair(baseline, leg) })),
  };
}

/**
 * 全脚のペアワイズ比較（$\binom{n}{2}$ 組）。群の要約はここから作る。
 *
 * @param {CrossRunnerLeg[]} legs
 * @returns {{ aId: string, bId: string, result: ReturnType<typeof classifyLegPair> }[]}
 */
export function buildPairwiseComparisons(legs) {
  const pairs = [];
  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      const a = /** @type {CrossRunnerLeg} */ (legs[i]);
      const b = /** @type {CrossRunnerLeg} */ (legs[j]);
      pairs.push({ aId: a.id, bId: b.id, result: classifyLegPair(a, b) });
    }
  }
  return pairs;
}

/**
 * ペアの集合から、比較可能な組だけの要約統計を作る。
 *
 * @param {{ aId: string, bId: string, result: ReturnType<typeof classifyLegPair> }[]} pairs
 * @returns {{ pairCount: number, comparablePairCount: number, matchCount: number, allMatch: boolean | null, maxAbsDiff: number | null, maxUlpDiff: number | null }}
 */
function summarizePairs(pairs) {
  const comparable = pairs.filter((pair) => pair.result.status !== "incomparable");
  const matches = comparable.filter((pair) => pair.result.status === "match");
  const withStats =
    /** @type {Array<Extract<ReturnType<typeof classifyLegPair>, { status: "match" | "mismatch" }>>} */ (
      comparable.map((pair) => pair.result)
    );
  return {
    pairCount: pairs.length,
    comparablePairCount: comparable.length,
    matchCount: matches.length,
    allMatch: comparable.length > 0 ? matches.length === comparable.length : null,
    maxAbsDiff: withStats.length > 0 ? Math.max(...withStats.map((r) => r.maxAbsDiff)) : null,
    maxUlpDiff: withStats.length > 0 ? Math.max(...withStats.map((r) => r.maxUlpDiff)) : null,
  };
}

/**
 * 群ごと（同 arch 内 / arch 間 / numThreads 間 / 同条件 rep 間）の一致の要約。
 *
 * - `archInternal`: 2脚とも同じ arch（runner・numThreads・rep は問わない）。
 * - `archCross`: 2脚の arch が違う。
 * - `numThreadsInternal`: runner と rep が同じで numThreads だけ違う組
 *   （スレッド数だけを動かした影響を切り分ける）。
 * - `repInternal`: runner と numThreads が同じで rep だけ違う組
 *   （同一条件での VM 間ばらつきを切り分ける）。
 *
 * @param {CrossRunnerLeg[]} legs
 * @returns {{ archInternal: ReturnType<typeof summarizePairs>, archCross: ReturnType<typeof summarizePairs>, numThreadsInternal: ReturnType<typeof summarizePairs>, repInternal: ReturnType<typeof summarizePairs> }}
 */
export function buildGroupSummaries(legs) {
  const byId = new Map(legs.map((leg) => [leg.id, leg]));
  const pairs = buildPairwiseComparisons(legs);

  /** @param {string} id */
  const legOf = (id) => /** @type {CrossRunnerLeg} */ (byId.get(id));

  const archInternal = pairs.filter((pair) => legOf(pair.aId).arch === legOf(pair.bId).arch);
  const archCross = pairs.filter((pair) => legOf(pair.aId).arch !== legOf(pair.bId).arch);
  const numThreadsInternal = pairs.filter((pair) => {
    const a = legOf(pair.aId);
    const b = legOf(pair.bId);
    return a.runnerLabel === b.runnerLabel && a.rep === b.rep && a.numThreads !== b.numThreads;
  });
  const repInternal = pairs.filter((pair) => {
    const a = legOf(pair.aId);
    const b = legOf(pair.bId);
    return a.runnerLabel === b.runnerLabel && a.numThreads === b.numThreads && a.rep !== b.rep;
  });

  return {
    archInternal: summarizePairs(archInternal),
    archCross: summarizePairs(archCross),
    numThreadsInternal: summarizePairs(numThreadsInternal),
    repInternal: summarizePairs(repInternal),
  };
}

// ---------------------------------------------------------------------------
// 4. Job Summary 向けの Markdown
// ---------------------------------------------------------------------------

/**
 * `classifyLegPair` / `buildBaselineComparisons` の1件を1行にする。
 *
 * @param {string} legId
 * @param {ReturnType<typeof classifyLegPair>} result
 * @returns {string}
 */
function baselineRowMarkdown(legId, result) {
  if (result.status === "incomparable") {
    return `| ${legId} | 🟡 比較できなかった | - | - | - | - | - | ${result.reason} |`;
  }
  const icon = result.status === "match" ? "✅" : "⚠";
  const digit =
    result.firstDivergentSignificantDigit === null
      ? "-"
      : `${result.firstDivergentSignificantDigit}`;
  const cosine = result.cosineSimilarity === null ? "-" : result.cosineSimilarity.toFixed(10);
  return (
    `| ${legId} | ${icon} ${result.status} | ${result.maxAbsDiff.toExponential(3)} | ` +
    `${result.maxUlpDiff} | ${result.mismatchComponentCount}/${result.totalComponents} | ` +
    `${digit} | ${cosine} | - |`
  );
}

/**
 * 群の要約1件を1行にする。
 *
 * @param {string} label
 * @param {ReturnType<typeof summarizePairs>} summary
 * @returns {string}
 */
function groupSummaryRowMarkdown(label, summary) {
  if (summary.pairCount === 0) {
    return `| ${label} | 0 | - | - | - | - |`;
  }
  const allMatchCell =
    summary.allMatch === null
      ? "比較できた組が無い"
      : summary.allMatch
        ? "✅ 全組一致"
        : "⚠ 不一致あり";
  return (
    `| ${label} | ${summary.pairCount} | ${summary.comparablePairCount} | ${summary.matchCount} | ` +
    `${allMatchCell} | ${summary.maxAbsDiff === null ? "-" : summary.maxAbsDiff.toExponential(3)} |`
  );
}

/**
 * Job Summary に載せる Markdown 一式を組み立てる。
 *
 * @param {{
 *   legs: CrossRunnerLeg[],
 *   baselineId: string,
 *   baselineComparisons: ReturnType<typeof buildBaselineComparisons>,
 *   groupSummaries: ReturnType<typeof buildGroupSummaries>,
 * }} input
 * @returns {string}
 */
export function buildCrossRunnerSummaryMarkdown({
  legs,
  baselineId,
  baselineComparisons,
  groupSummaries,
}) {
  const expectedCount = legs.length;
  const presentCount = legs.filter((leg) => leg.present).length;
  const lines = [
    "# embedding 出力のランナー間再現性（測るだけ。門にはしない。Issue #565）",
    "",
    "⛔ **これは門ではない。**一致・不一致のどちらでも、このジョブは常に成功する。" +
      "n=1 run という条件下の観測であり、ランナー間の再現性を一般に証明・反証するものではない。",
    "",
    `脚（runner × numThreads × rep）: 期待 ${expectedCount} 件中 ${presentCount} 件の artifact が在った。`,
    "",
    "## 基準脚との比較",
    "",
    `基準脚: \`${baselineId}\`（${baselineComparisons.baselinePresent ? "artifact 在り" : "🔴 artifact 無し——以下すべて比較できなかった"}）`,
    "",
    "| 脚 | 判定 | 最大絶対差 | 最大ULP差 | 不一致成分数/全成分数 | 何桁目からずれるか | cosine類似度 | 備考 |",
    "|---|---|---|---|---|---|---|---|",
    ...baselineComparisons.comparisons.map(({ legId, result }) =>
      baselineRowMarkdown(legId, result),
    ),
    "",
    "## 欠損脚（artifact が無かった脚。⚠ 比較できなかったのであり「一致」ではない）",
    "",
  ];

  const missingLegs = legs.filter((leg) => !leg.present);
  if (missingLegs.length === 0) {
    lines.push("（無し——期待した全脚の artifact が揃った。）");
  } else {
    lines.push(...missingLegs.map((leg) => `- \`${leg.id}\``));
  }

  lines.push(
    "",
    "## 群ごとの要約",
    "",
    "⚠ 「全組一致」は、比較できた組（`incomparable` を除く）の中だけで見た一致である。" +
      "比較できた組が無ければ判定しない。",
    "",
    "| 群 | 組数 | 比較できた組 | 一致した組 | 判定 | 最大絶対差 |",
    "|---|---|---|---|---|---|",
    groupSummaryRowMarkdown("同 arch 内", groupSummaries.archInternal),
    groupSummaryRowMarkdown("arch 間", groupSummaries.archCross),
    groupSummaryRowMarkdown(
      "numThreads 間（同 runner・同 rep）",
      groupSummaries.numThreadsInternal,
    ),
    groupSummaryRowMarkdown("rep 間（同 runner・同 numThreads）", groupSummaries.repInternal),
  );

  return lines.join("\n");
}
