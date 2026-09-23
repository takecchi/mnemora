/**
 * `scripts/embedding-output-fingerprint-summary.mjs`（CI の Job Summary に載せる
 * Markdown を組み立てる CLI）の**純関数の側**。ファイル I/O・`process.argv`・
 * `process.exit` を一切持たない（`retrieval-quality-summary-lib.mjs` と同じ分担。
 * Issue #565、ADR 0253 追記）。
 *
 * ⛔ **このスクリプトは門ではない。**測定した sha256・次元数・CPU 情報をそのまま
 * 表示するだけで、良し悪しを判定しない——判定（一致/不一致の突き合わせ）は
 * `scripts/compare-embedding-output-fingerprints.mjs` の役目であり、このジョブは
 * それより前段（自分自身が何を測ったか）を報告するだけである。
 */

/**
 * `scripts/measure-embedding-output-fingerprint.mjs` が書いた測定 JSON（パース済み）の
 * 形を検査する。
 *
 * @param {unknown} data
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
export function validateFingerprintRecord(data) {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "測定 JSON がオブジェクトでない" };
  }
  const value = /** @type {{ status?: unknown }} */ (data);
  if (value.status !== "ok" && value.status !== "weights_unavailable") {
    return {
      ok: false,
      error: `測定 JSON の status が想定外である: ${JSON.stringify(value.status)}`,
    };
  }
  if (value.status === "ok") {
    const ok = /** @type {{ sha256?: unknown, dimensions?: unknown }} */ (data);
    if (typeof ok.sha256 !== "string" || ok.sha256 === "") {
      return { ok: false, error: "status=ok なのに sha256 (string) が無い" };
    }
    if (typeof ok.dimensions !== "number") {
      return { ok: false, error: "status=ok なのに dimensions (number) が無い" };
    }
  }
  return { ok: true, value: /** @type {Record<string, unknown>} */ (data) };
}

/**
 * CPU 情報を Markdown の箇条書きへ整形する。
 *
 * @param {Record<string, unknown> | undefined} cpuInfo
 * @returns {string[]}
 */
function formatCpuInfoLines(cpuInfo) {
  if (!cpuInfo || typeof cpuInfo !== "object") {
    return ["  - (CPU 情報なし)"];
  }
  if (cpuInfo.unavailable) {
    return [`  - ⚠ CPU 情報を取得できなかった: ${cpuInfo.reason}`];
  }
  return Object.entries(cpuInfo)
    .filter(([key]) => key !== "source")
    .map(([key, value]) => `  - ${key}: ${value}`);
}

/**
 * Markdown を組み立てる。**stdout に出すのは呼び出し側の役目**——ここは文字列を返すだけ。
 *
 * @param {Record<string, unknown>} measured
 * @returns {string}
 */
export function buildFingerprintSummaryMarkdown(measured) {
  const lines = [
    "# 固定入力に対する embedding 出力の指紋（測定、Issue #565 / ADR 0253 追記）",
    "",
    "⛔ **これは門ではない。**測るだけであり、値の良し悪しは判定しない。" +
      "門にするかどうかは、複数 run にわたって n が溜まり、偽陽性率が測れてから判断する。",
    "",
  ];

  if (measured.status === "weights_unavailable") {
    lines.push(
      `🟡 重みを取得できなかったので、測っていない: ${measured.detail}`,
      "",
      `- measuredAt: ${measured.measuredAt}`,
      `- runnerName: ${measured.runnerName ?? "(不明)"}`,
    );
    return lines.join("\n");
  }

  lines.push(
    `- sha256: \`${measured.sha256}\``,
    `- dimensions: ${measured.dimensions}`,
    `- vectorCount: ${measured.vectorCount}`,
    `- embeddingSpace: ${JSON.stringify(measured.embeddingSpace)}`,
    `- inputs: ${JSON.stringify(measured.inputs)}`,
    `- measuredAt: ${measured.measuredAt}`,
    `- runnerName: ${measured.runnerName ?? "(不明)"}`,
    "- CPU 情報:",
    ...formatCpuInfoLines(/** @type {Record<string, unknown>} */ (measured.cpuInfo)),
  );
  return lines.join("\n");
}
