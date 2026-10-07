/**
 * 純関数の側。ファイル I/O・`gh` の起動・`process.argv`・`process.exit` を持たない。
 *
 * ⚠ ログに印字された文言を読んでいるだけで、registry の実際の状態は見ていない(ADR 0207)。
 * 文言と実際がずれる経路(`publish.yml` の該当行が書き換わる等)は、`classifyPublishOutcome` が
 * 新しい文言を `unknown` として返すことでしか検知できない。`unknown` を黙って published/skipped に倒さないのはそのため。
 *
 * 素の `gh api .../logs` は `::group::` を `##[group]` に変換した形で返すので、両方の表記を受ける。
 */

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /;
// eslint-disable-next-line no-control-regex -- ANSI エスケープの除去に \x1b を使う。
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const GROUP_START_RE = /^(?:::group::|##\[group\])npm publish (.+?)\s*$/;
const GROUP_END_RE = /^(?:::endgroup::|##\[endgroup\])\s*$/;

const DRY_RUN_MARKER = "予行（--dry-run）です。registry へは何も上がりません。";

/**
 * ⚠ 先頭の空白は取り除かない。runner が印字する「これから打つ script」の行(`  echo "::group::npm publish ${spec}"`)は、
 * ANSI を剥がしても `  echo "` が残り、行頭アンカーの `GROUP_START_RE` に一致しない。
 * これが未展開のテンプレート文字列を実際の group と誤認しない唯一の防波堤なので、行頭アンカーを緩めない。
 *
 * @param {string} line
 * @returns {string}
 */
function normalizeLine(line) {
  return line.replace(TIMESTAMP_RE, "").replace(ANSI_RE, "");
}

/**
 * ⛔ `::endgroup::` を見ないまま次の group や末尾に達した場合も、そこまでの本文で1本として確定する。
 * 失敗した回は `exit` が `echo "::endgroup::"` より先に実行されて group が閉じず、
 * 捨てると最も知りたい「失敗した」本を取りこぼす。
 *
 * @param {string} logText
 * @returns {{ spec: string, body: string }[]}
 */
export function parsePublishGroups(logText) {
  const rawLines = logText.split(/\r?\n/);
  /** @type {{ spec: string, bodyLines: string[] } | null} */
  let current = null;
  /** @type {{ spec: string, body: string }[]} */
  const groups = [];

  const closeCurrent = () => {
    if (current) {
      groups.push({ spec: current.spec, body: current.bodyLines.join("\n") });
      current = null;
    }
  };

  for (const rawLine of rawLines) {
    const line = normalizeLine(rawLine);
    const startMatch = line.match(GROUP_START_RE);
    if (startMatch) {
      closeCurrent();
      current = { spec: startMatch[1], bodyLines: [] };
      continue;
    }
    if (GROUP_END_RE.test(line)) {
      closeCurrent();
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }
  closeCurrent();

  return groups;
}

/**
 * @param {string} spec
 * @returns {{ name: string, version: string | null }}
 */
export function parseSpecName(spec) {
  const match = spec.match(/^(.+)@([^@]+)$/);
  if (!match) return { name: spec, version: null };
  return { name: match[1], version: match[2] };
}

/**
 * ⛔ 3つの既知文言のどれにも一致しなければ `unknown`。published/skipped のどちらにも黙って倒さない。
 *
 * @param {string} body
 * @returns {"published" | "skipped" | "failed" | "unknown"}
 */
export function classifyPublishOutcome(body) {
  if (body.includes("を publish した")) return "published";
  if (body.includes("既に registry に在る（飛ばした）")) return "skipped";
  if (body.includes("の publish が失敗した")) return "failed";
  return "unknown";
}

/**
 * ⚠ `logText.includes(DRY_RUN_MARKER)` では足りない。runner は実行前に script 全文を ANSI 付きで
 * `Run set -euo pipefail` group に印字し、そこには `DRY_RUN` の値に関係なく固定文言が常に現れる。
 * 単純な部分一致は本番 run を予行と誤判定する。行を正規化(タイムスタンプ・ANSI 除去)したあと、完全一致で見る。
 *
 * @param {string} logText
 * @returns {boolean}
 */
export function detectDryRunMarker(logText) {
  return logText.split(/\r?\n/).some((rawLine) => normalizeLine(rawLine) === DRY_RUN_MARKER);
}

/**
 * ⛔ 本数・名前は呼び出し側が渡す `publishTargets` から読む。件数のリテラルを持たない。
 * 判定不能(group が無い・`unknown` がある)は、fail にも pass にも決め打たない(どちらも誤りを生みうる)。
 *
 * @param {string} logText
 * @param {{ name: string }[]} publishTargets
 * @returns {{
 *   verdict: "pass" | "fail" | "indeterminate",
 *   reason: string,
 *   isDryRun: boolean | null,
 *   totalTargets: number,
 *   publishedCount: number,
 *   perTarget: { name: string, outcome: "published" | "skipped" | "failed" | "missing" | "unknown", spec?: string }[],
 *   unexpectedNames: string[],
 * }}
 */
export function evaluatePublishRunCoverage(logText, publishTargets) {
  const groups = parsePublishGroups(logText);

  const byName = new Map();
  for (const group of groups) {
    const { name } = parseSpecName(group.spec);
    const outcome = classifyPublishOutcome(group.body);
    byName.set(name, { spec: group.spec, outcome });
  }

  const targetNames = publishTargets.map((t) => t.name);
  const targetNameSet = new Set(targetNames);

  /** @type {{ name: string, outcome: "published" | "skipped" | "failed" | "missing" | "unknown", spec?: string }[]} */
  const perTarget = targetNames.map((name) => {
    const entry = byName.get(name);
    if (!entry) return { name, outcome: "missing" };
    return { name, outcome: entry.outcome, spec: entry.spec };
  });

  const unexpectedNames = [...byName.keys()].filter((name) => !targetNameSet.has(name));
  const publishedCount = perTarget.filter((p) => p.outcome === "published").length;
  const skippedNames = perTarget.filter((p) => p.outcome === "skipped").map((p) => p.name);
  const failedNames = perTarget.filter((p) => p.outcome === "failed").map((p) => p.name);
  const missingNames = perTarget.filter((p) => p.outcome === "missing").map((p) => p.name);
  const unknownNames = perTarget.filter((p) => p.outcome === "unknown").map((p) => p.name);

  const isDryRun = groups.length === 0 ? null : detectDryRunMarker(logText);

  /** @type {"pass" | "fail" | "indeterminate"} */
  let verdict;
  let reason;

  if (groups.length === 0) {
    verdict = "indeterminate";
    reason =
      "ログに npm publish の ::group::（または ##[group]）が1つも見つからなかった。" +
      "publish 段が走っていない・ログが publish 段まで届いていない・ログの取得自体に" +
      "問題がある、のいずれかである可能性がある。";
  } else if (unknownNames.length > 0) {
    verdict = "indeterminate";
    reason =
      `次の対象の本文が、既知の3文言（を publish した / 既に registry に在る（飛ばした） / ` +
      `の publish が失敗した）のどれにも一致しなかった: ${unknownNames.join(", ")}。` +
      `publish.yml の文言が変わった可能性がある。`;
  } else if (
    unexpectedNames.length > 0 ||
    skippedNames.length > 0 ||
    failedNames.length > 0 ||
    missingNames.length > 0
  ) {
    verdict = "fail";
    const parts = [];
    if (skippedNames.length > 0) parts.push(`飛ばした: ${skippedNames.join(", ")}`);
    if (failedNames.length > 0) parts.push(`失敗した: ${failedNames.join(", ")}`);
    if (missingNames.length > 0) parts.push(`ログに無い: ${missingNames.join(", ")}`);
    if (unexpectedNames.length > 0) {
      parts.push(`PUBLISH_TARGETS に無い名前がログに在る: ${unexpectedNames.join(", ")}`);
    }
    reason =
      `${publishedCount}/${targetNames.length} 本しか publish 経路を通っていない（${parts.join("; ")}）。` +
      (isDryRun
        ? "予行なので「壊れている」ではない——この予行が確かめたのはこの本数だけ、という意味である（ADR 0207）。"
        : "");
  } else {
    verdict = "pass";
    reason = `PUBLISH_TARGETS の全 ${targetNames.length} 本が publish 経路を通った（"を publish した"）。`;
  }

  return {
    verdict,
    reason,
    isDryRun,
    totalTargets: targetNames.length,
    publishedCount,
    perTarget,
    unexpectedNames,
  };
}

/**
 * ⛔ 段の番号では見つけない。GitHub の step 番号は「Set up job」を含むかどうかでずれ、
 * `docs/release-v1.md` §1.2 の番号とも一致しない。`::group::npm publish` という現物の目印から step 名を逆算する。
 * 簡易なテキスト走査で YAML パーサではない。前提が崩れたら `null` を返す(呼び出し側は「見つからなかった」として扱うこと)。
 *
 * @param {string} workflowYamlText
 * @returns {string | null}
 */
export function findPublishStepName(workflowYamlText) {
  const lines = workflowYamlText.split(/\r?\n/);
  let currentName = null;
  for (const line of lines) {
    const nameMatch = line.match(/^\s*-\s*name:\s*(.+?)\s*$/);
    if (nameMatch) {
      currentName = stripYamlScalarQuotes(nameMatch[1]);
      continue;
    }
    if (line.includes("::group::npm publish")) {
      return currentName;
    }
  }
  return null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripYamlScalarQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
