/**
 * `scripts/compare-embedding-output-fingerprints.mjs`（同一 workflow run 内の2ジョブが
 * 残した embedding 出力の指紋を突き合わせる CLI）の**純関数の側**。ファイル I/O・
 * `process.argv`・`process.exit` を一切持たない（`lexical-regime-coverage-lib.mjs` と
 * 似た分担だが、⛔ **あちらと違ってこちらは門ではない**——Issue #565「採るとしたら何が
 * 要るか」4番の比較段は、n が溜まり偽陽性率が測れるまで、一致・不一致のどちらでも
 * exit 0 のままである）。
 *
 * ## 3つの結果
 *
 * - `"match"` — 両方の artifact が揃っており、sha256・dimensions が一致した。
 * - `"mismatch"` — 両方の artifact が揃っているが、sha256 か dimensions が食い違った。
 *   **両方の CPU 情報の差を添える**（Issue #565「これが無いと、不一致だったときに原因を
 *   切り分けられない」）。
 * - `"incomparable"` — 片方（または両方）の artifact が無い・読めない・
 *   `weights_unavailable`・sha256 が欠けている、のいずれか。**「一致」とも「不一致」とも
 *   名乗らない**——「出なかった」を「一致した」の証拠にしない、という
 *   `AGENTS.md`「⚠『出なかった』を、事象が無いことの証明にしない」の適用。
 */

/**
 * 比較対象の2ジョブと、それぞれが upload する artifact 名。
 *
 * ⚠ **`.github/workflows/ci.yml` の該当ジョブ・upload-artifact の `name:` と
 * 二重管理である。**ずれたら `scripts/__tests__/ci-yml-embedding-output-fingerprint-wiring.test.mjs`
 * が赤くなる（`lexical-regime-coverage-lib.mjs` の `EXPECTED_SERVER_ENCODINGS` と同じ形）。
 *
 * @type {ReadonlyArray<{ id: string, artifactName: string }>}
 */
export const EMBEDDING_FINGERPRINT_JOBS = Object.freeze([
  Object.freeze({ id: "example-chat", artifactName: "embedding-output-fingerprint-example-chat" }),
  Object.freeze({
    id: "root-gate-db-stage",
    artifactName: "embedding-output-fingerprint-root-gate-db-stage",
  }),
]);

/** 各 artifact ディレクトリの下に置かれる測定 JSON のファイル名。 */
export const EMBEDDING_FINGERPRINT_FILENAME = "embedding-fingerprint.json";

/**
 * @typedef {object} FingerprintLeg
 * @property {string} id `EMBEDDING_FINGERPRINT_JOBS` の要素の `id`
 * @property {boolean} present artifact のディレクトリ/ファイルが存在したか
 * @property {string} [error] 存在したが読めない/parse できなかった理由
 * @property {Record<string, unknown>} [record] 読めた測定 JSON(パース済み)
 */

/**
 * `cpuInfo` 同士の差分を取る。**両方に無い欄・両方で同じ値の欄は出さない。**
 *
 * @param {Record<string, unknown> | undefined} a
 * @param {Record<string, unknown> | undefined} b
 * @returns {{ field: string, a: unknown, b: unknown }[]}
 */
function diffCpuInfo(a, b) {
  const aFields = a && typeof a === "object" ? a : {};
  const bFields = b && typeof b === "object" ? b : {};
  const keys = new Set([...Object.keys(aFields), ...Object.keys(bFields)]);
  const diffs = [];
  for (const key of keys) {
    if (aFields[key] !== bFields[key]) {
      diffs.push({ field: key, a: aFields[key], b: bFields[key] });
    }
  }
  return diffs;
}

/**
 * 2つの leg を突き合わせる。
 *
 * 🔴 **どの分岐でも exit code を決めない**——それは呼び出し側(CLI)の役目であり、
 * かつ CLI 側も常に 0 を選ぶ設計である(このスクリプトは門ではない)。
 *
 * @param {FingerprintLeg} legA
 * @param {FingerprintLeg} legB
 * @returns {
 *   | { status: "match", cpuDiff: ReturnType<typeof diffCpuInfo> }
 *   | { status: "mismatch", sha256: Record<string, unknown>, dimensions: Record<string, unknown>, cpuDiff: ReturnType<typeof diffCpuInfo> }
 *   | { status: "incomparable", reason: string }
 * }
 */
export function compareFingerprints(legA, legB) {
  const missing = [legA, legB].filter((leg) => !leg.present).map((leg) => leg.id);
  if (missing.length > 0) {
    return {
      status: "incomparable",
      reason:
        `${missing.join(" と ")} の artifact が無いため、比較できなかった` +
        "（一致とも不一致とも言わない）。",
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
      reason: `${unavailable.join(" と ")} で重みを取得できず測れなかったため、比較できなかった。`,
    };
  }

  if (typeof recordA.sha256 !== "string" || typeof recordB.sha256 !== "string") {
    return {
      status: "incomparable",
      reason: "sha256 が欠けている測定 JSON がある（形が壊れている）ため、比較できなかった。",
    };
  }

  const cpuDiff = diffCpuInfo(
    /** @type {Record<string, unknown>} */ (recordA.cpuInfo),
    /** @type {Record<string, unknown>} */ (recordB.cpuInfo),
  );

  const matches = recordA.sha256 === recordB.sha256 && recordA.dimensions === recordB.dimensions;
  if (matches) {
    return { status: "match", cpuDiff };
  }

  return {
    status: "mismatch",
    sha256: { [legA.id]: recordA.sha256, [legB.id]: recordB.sha256 },
    dimensions: { [legA.id]: recordA.dimensions, [legB.id]: recordB.dimensions },
    cpuDiff,
  };
}

/**
 * Job Summary に載せる Markdown を組み立てる。
 *
 * @param {FingerprintLeg[]} legs
 * @param {ReturnType<typeof compareFingerprints>} result
 * @returns {string}
 */
export function buildComparisonSummaryMarkdown(legs, result) {
  const lines = [
    "# 固定入力に対する embedding 出力の指紋を2ジョブ間で突き合わせる（Issue #565）",
    "",
    "⛔ **これは門ではない。**一致・不一致のどちらでも、このジョブは exit 0 のままである。" +
      "n=2・同一 run という条件下の1回の観測であり、ランナー間の再現性を一般に証明・" +
      "反証するものではない（Issue #565「n を増やせば必ず測れる、とも主張していない」）。",
    "",
    "| ジョブ | artifact | 状態 | sha256 | dimensions |",
    "|---|---|---|---|---|",
    ...legs.map((leg) => {
      const job = EMBEDDING_FINGERPRINT_JOBS.find((j) => j.id === leg.id);
      const artifactName = job ? job.artifactName : "(不明)";
      if (!leg.present) {
        return `| ${leg.id} | ${artifactName} | artifact 無し | - | - |`;
      }
      if (leg.error) {
        return `| ${leg.id} | ${artifactName} | 読めない(${leg.error}) | - | - |`;
      }
      const record = /** @type {Record<string, unknown>} */ (leg.record);
      if (record.status === "weights_unavailable") {
        return `| ${leg.id} | ${artifactName} | 重み取得失敗 | - | - |`;
      }
      return `| ${leg.id} | ${artifactName} | OK | \`${record.sha256}\` | ${record.dimensions} |`;
    }),
    "",
  ];

  if (result.status === "incomparable") {
    lines.push(`🟡 **比較できなかった**: ${result.reason}`);
    return lines.join("\n");
  }

  if (result.status === "match") {
    lines.push("✅ 一致（sha256・dimensions が同じ）。");
    if (result.cpuDiff.length > 0) {
      lines.push(
        "",
        "⚠ sha256 は一致したが、CPU 情報には差がある（参考情報。判定には使っていない）:",
        "",
        "| 欄 | " + EMBEDDING_FINGERPRINT_JOBS.map((j) => j.id).join(" | ") + " |",
        "|---|---|---|",
        ...result.cpuDiff.map((d) => `| ${d.field} | ${d.a} | ${d.b} |`),
      );
    }
    return lines.join("\n");
  }

  // status === "mismatch"
  lines.push(
    "⚠ **不一致**（🔴 落とさない——測るだけである）。sha256・dimensions:",
    "",
    "```json",
    JSON.stringify({ sha256: result.sha256, dimensions: result.dimensions }, null, 2),
    "```",
  );
  if (result.cpuDiff.length > 0) {
    lines.push(
      "",
      "両方の CPU 情報の差（原因を切り分ける材料。Issue #565「これが無いと、不一致だった" +
        "ときに原因を切り分けられない」）:",
      "",
      "| 欄 | " + EMBEDDING_FINGERPRINT_JOBS.map((j) => j.id).join(" | ") + " |",
      "|---|---|---|",
      ...result.cpuDiff.map((d) => `| ${d.field} | ${d.a} | ${d.b} |`),
    );
  } else {
    lines.push("", "（CPU 情報に差は無かった——ハードウェア以外の要因を疑うこと。）");
  }
  return lines.join("\n");
}
