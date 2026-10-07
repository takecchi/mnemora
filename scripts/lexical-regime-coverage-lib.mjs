/**
 * ⛔ `postgres` ジョブが緑でも「両方の regime が走った」ことにはならない。片方の脚が落ちると artifact が無く、
 * `if-no-files-found: ignore` は黙る。ここが引き受けるのは artifact が揃ったあとの判定だけで、
 * ジョブ自体の skip は呼び出し側(ci.yml)が見る。
 *
 * ⚠ `EXPECTED_SERVER_ENCODINGS` は ci.yml の matrix の脚と二重管理。
 * ずれたら `ci-yml-postgres-regime-coverage-wiring.test.mjs` が赤くなる。
 */

/**
 * `LATIN1` はサポート対象と確認できていないため含めない。
 *
 * @type {readonly string[]}
 */
export const EXPECTED_SERVER_ENCODINGS = ["UTF8", "SQL_ASCII"];

/**
 * @param {string} serverEncoding
 * @returns {string}
 */
export function artifactNameForEncoding(serverEncoding) {
  return `lexical-regime-${serverEncoding}`;
}

/**
 * @typedef {object} LegStatus
 * @property {string} encoding
 * @property {boolean} present
 * @property {string} [error]
 * @property {string} [measuredEncoding]
 */

/**
 * 🔴 「artifact が両方ある」だけでは足りず、実際に測れた server_encoding が2種類あることまで見る。
 * `POSTGRES_INITDB_ARGS` が効いていないと、両脚が同じ値を測りうる。
 * ⛔ 3脚目や、期待していない追加の一致は要求しない。
 *
 * @param {LegStatus[]} legs
 * @returns {{ ok: true, distinctMeasured: string[] } | { ok: false, problems: string[] }}
 */
export function evaluateCoverage(legs) {
  /** @type {string[]} */
  const problems = [];

  for (const leg of legs) {
    if (!leg.present) {
      problems.push(
        `${artifactNameForEncoding(leg.encoding)} の artifact が無い` +
          `(server_encoding=${leg.encoding} の脚が走っていないか、artifact を書く前に` +
          "測定段が落ちた可能性がある)",
      );
      continue;
    }
    if (leg.error) {
      problems.push(`${artifactNameForEncoding(leg.encoding)} の中身を読めない: ${leg.error}`);
      continue;
    }
    if (leg.measuredEncoding !== leg.encoding) {
      problems.push(
        `${artifactNameForEncoding(leg.encoding)} の中身が server_encoding=` +
          `${leg.measuredEncoding} を測っている(artifact 名が主張する脚は ${leg.encoding})`,
      );
    }
  }

  const distinctMeasured = [
    ...new Set(
      legs
        .filter((leg) => leg.present && !leg.error && leg.measuredEncoding !== undefined)
        .map((leg) => /** @type {string} */ (leg.measuredEncoding)),
    ),
  ];

  if (problems.length === 0 && distinctMeasured.length < EXPECTED_SERVER_ENCODINGS.length) {
    problems.push(
      `実際に測れた server_encoding が ${distinctMeasured.length} 種類しかない` +
        `(${JSON.stringify(distinctMeasured)})。期待する ${EXPECTED_SERVER_ENCODINGS.length} 種類` +
        `(${JSON.stringify(EXPECTED_SERVER_ENCODINGS)})が別々に走った証拠にならない` +
        "——POSTGRES_INITDB_ARGS が効いていない可能性がある(ADR 0106 負債4)。",
    );
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, distinctMeasured };
}

/**
 * @param {LegStatus[]} legs
 * @param {ReturnType<typeof evaluateCoverage>} result
 * @returns {string}
 */
export function buildCoverageSummaryMarkdown(legs, result) {
  const rows = legs.map((leg) => {
    const status = !leg.present
      ? "artifact 無し"
      : leg.error
        ? `読めない(${leg.error})`
        : leg.measuredEncoding === leg.encoding
          ? `OK(server_encoding=${leg.measuredEncoding})`
          : `不一致(server_encoding=${leg.measuredEncoding})`;
    return `| ${artifactNameForEncoding(leg.encoding)} | ${status} |`;
  });

  const lines = [
    "# 両方の server_encoding regime が実際に走ったか(Issue #155)",
    "",
    "⛔ **`postgres` ジョブが緑であることは、両方の regime が走った証拠ではない。**" +
      "このジョブは matrix の各脚が残した artifact を集め、名前どおりの server_encoding を" +
      "実際に測っていて、かつ2種類とも別の値であることを確かめる。",
    "",
    "| artifact | 状態 |",
    "|---|---|",
    ...rows,
    "",
    result.ok
      ? `✅ 実際に測れた server_encoding: ${JSON.stringify(result.distinctMeasured)}`
      : "🔴 " + result.problems.join(" / "),
  ];
  return lines.join("\n");
}
