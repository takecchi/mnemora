/**
 * ⛔ この module も門ではない。`classifyLegPair` が返す `"mismatch"` は観測であって判定ではなく、
 * どの呼び出し側も exit code を非0にしない。
 * ⚠ `CROSS_RUNNER_RUNNERS` / `CROSS_RUNNER_NUM_THREADS` / `CROSS_RUNNER_REPS` は workflow の matrix と二重管理。
 * ずれたら `embedding-cross-runner-reproducibility-workflow-wiring.test.mjs` が赤くなる。
 * 比較の前に必ず `Math.fround` を通す。double では違っても float32 では同じ(逆も)を取り違えるため。
 * artifact 無し・読めない・`weights_unavailable`・vectors の形崩れは必ず `"incomparable"` で返し、
 * `"match"` / `"mismatch"` のどちらにも倒さない。
 */

import { createHash } from "node:crypto";

/**
 * `arch` は意図した値でしかない。比較で信じるのは実測の `leg.arch`。
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

export const CROSS_RUNNER_ARTIFACT_PREFIX = "cross-runner-embedding-fingerprint";

/**
 * ⚠ 区切りは `--`。runner label は単発のハイフンとピリオドを含むが `--` は含まない。
 * 含むようになったら `parseCrossRunnerArtifactName` の正規表現も直すこと。
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
 * @param {string} runnerLabel
 * @param {number} numThreads
 * @param {number} rep
 * @returns {string}
 */
export function crossRunnerArtifactName(runnerLabel, numThreads, rep) {
  return `${CROSS_RUNNER_ARTIFACT_PREFIX}--${crossRunnerLegId(runnerLabel, numThreads, rep)}`;
}

/**
 * 形が合わなければ throw せず `null`。
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

export const CROSS_RUNNER_BASELINE_LEG_ID = crossRunnerLegId("ubuntu-latest", 4, 1);

/**
 * big-endian 表示は人が読む慣習に合わせたもの。`sha256HexOfFloat32Vectors` のバイト列化とは独立で、混同しない。
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
 * @param {number} value
 * @returns {number}
 */
function float32Uint32Bits(value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(Math.fround(value), 0);
  return buf.readUInt32LE(0);
}

/**
 * `+0` と `-0` は同じ順序値(ULP 距離 0)。
 *
 * @param {number} bits 符号なし32bit整数
 * @returns {number}
 */
function orderedFromFloat32Bits(bits) {
  return (bits & 0x80000000) !== 0 ? 0x100000000 - bits : bits + 0x80000000;
}

/**
 * `NaN` / `Infinity` が絡めば 0 でごまかさず `null`。
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
 * ⛔ 並べ替えない。
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
 * @param {number[][]} vectors
 * @returns {string}
 */
export function sha256HexOfFloat32Vectors(vectors) {
  return createHash("sha256").update(serializeVectorsToFloat32Bytes(vectors)).digest("hex");
}

/**
 * @param {number[][]} vectors
 * @returns {string[][]}
 */
export function vectorsToFloat32Hex(vectors) {
  return vectors.map((vector) => vector.map((component) => float32BitsHex(component)));
}

/**
 * ⚠ 本数・成分数が違えば `comparable: false`。次元が違うベクトルの「最大絶対差」に意味は無い。
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

/**
 * @typedef {object} CrossRunnerLeg
 * @property {string} id
 * @property {string} runnerLabel
 * @property {"x64" | "arm64" | string} arch 実測値(意図ではない)
 * @property {number} numThreads
 * @property {number} rep
 * @property {boolean} present
 * @property {string} [error]
 * @property {Record<string, unknown>} [record]
 */

/**
 * 🔴 どの分岐でも exit code を決めない。
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

/**
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
