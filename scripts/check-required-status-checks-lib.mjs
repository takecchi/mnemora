/**
 * 純関数の側。ファイル I/O・`gh` の起動・`process.argv`・`process.exit` を持たない。
 *
 * ⛔ 3値(match/mismatch/undetermined)で答える。「読めなかった」を `match` に丸めると、
 * 権限が無くて読めていない回が「ずれていない」として消える。
 *
 * ⛔ どちらが正かは決めない。ずれの是正(宣言か branch protection か)は人間の判断
 * (branch protection の変更はオーナー領分。`docs/autonomy.md` §3)。
 *
 * required は2か所に置ける: classic の branch protection と ruleset。GitHub は両方を課すので、
 * 現物は両方の和集合として読む。片方でも読めなければ和集合は作れないので保留にする。
 * ⚠ classic の `404 Branch not protected` は「読めない」ではなく「classic の保護が無い」という事実として扱う。
 */

/**
 * ⛔ `-q` で `.required_status_checks.contexts` を絞った結果を渡さない。生 JSON を丸ごと渡し、形を見て判定する
 * (「`required_status_checks` が無い」と「在るが `contexts` が空」を区別するため)。
 * `contexts` と `checks` の両方を見る。片方だけ読むと、もう片方だけ更新された回を取り逃す。
 * 欄が無い・形が違うときは空配列ではなく `null`(読めなかった)を返す。空配列は「required が1つも無い」という別の事実。
 *
 * @param {unknown} protection
 * @returns {{ names: string[], disagreement: { contexts: string[], checks: string[] } | null } | null}
 */
export function contextsFromProtection(protection) {
  if (protection === null || typeof protection !== "object") return null;
  const required = /** @type {{ required_status_checks?: unknown }} */ (protection)
    .required_status_checks;
  if (required === null || typeof required !== "object") return null;

  const req = /** @type {{ contexts?: unknown, checks?: unknown }} */ (required);
  const fromContexts = Array.isArray(req.contexts)
    ? req.contexts.filter((name) => typeof name === "string")
    : null;
  const fromChecks = Array.isArray(req.checks)
    ? req.checks
        .map((check) =>
          check === null || typeof check !== "object"
            ? null
            : /** @type {{context?: unknown}} */ (check).context,
        )
        .filter((name) => typeof name === "string")
    : null;

  if (fromContexts === null && fromChecks === null) return null;

  const primary = fromChecks ?? fromContexts ?? [];
  const disagreement =
    fromContexts !== null && fromChecks !== null && !sameSet(fromContexts, fromChecks)
      ? { contexts: [...fromContexts].sort(), checks: [...fromChecks].sort() }
      : null;

  return { names: [...primary].sort(), disagreement };
}

/** @param {string[]} a @param {string[]} b @returns {boolean} */
function sameSet(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/**
 * `GET repos/{repo}/rules/branches/{branch}`(そのブランチに効いている active な規則の配列)から、
 * `required_status_checks` の規則の context を集める。ruleset の一覧から ref の条件を自前で評価しないのは、
 * その判定(include/exclude・`~DEFAULT_BRANCH`・evaluate モードの除外)を GitHub がこの応答で済ませているため。
 * 配列でない・規則の形が違うときは `null`(読めなかった)。required の規則が1つも無いのは空配列(別の事実)。
 *
 * @param {unknown} rules
 * @returns {string[] | null}
 */
export function contextsFromBranchRules(rules) {
  if (!Array.isArray(rules)) return null;
  /** @type {string[]} */
  const names = [];
  for (const rule of rules) {
    if (rule === null || typeof rule !== "object") return null;
    const { type, parameters } = /** @type {{ type?: unknown, parameters?: unknown }} */ (rule);
    if (type !== "required_status_checks") continue;
    const checks =
      parameters !== null && typeof parameters === "object"
        ? /** @type {{ required_status_checks?: unknown }} */ (parameters).required_status_checks
        : undefined;
    if (!Array.isArray(checks)) return null;
    for (const check of checks) {
      const context =
        check !== null && typeof check === "object"
          ? /** @type {{ context?: unknown }} */ (check).context
          : undefined;
      if (typeof context !== "string") return null;
      names.push(context);
    }
  }
  return [...new Set(names)].sort();
}

/**
 * ⛔ 404 でも `Branch not found` などは「保護が無い」ではない(ブランチ名の誤りかもしれない)。文言まで見る。
 *
 * @param {string} error `gh api` の stderr
 * @returns {boolean}
 */
export function isClassicProtectionAbsent(error) {
  return error.includes("Branch not protected") && error.includes("HTTP 404");
}

/**
 * @typedef {{ json: unknown, error: null } | { json: null, error: string }} ApiResult
 * @typedef {{ names: string[], disagreement: { contexts: string[], checks: string[] } | null }} LiveContexts
 */

/**
 * classic と ruleset の両方を読み、和集合を作る。`fetchJson` は GET だけを行う(試験では fixture を返す)。
 *
 * @param {(apiPath: string, options?: { paginatedArray?: boolean }) => ApiResult} fetchJson
 * @param {string} repo
 * @param {string} branch
 * @returns {{ live: LiveContexts | null, sources: string[], unreadable: string[] }}
 *   `sources` は読めた事実(どこから何件か、classic が無いこと)、`unreadable` は読めなかった理由。
 */
export function readLiveRequiredChecks(fetchJson, repo, branch) {
  const classicPath = `repos/${repo}/branches/${branch}/protection`;
  const rulesPath = `repos/${repo}/rules/branches/${branch}`;
  /** @type {string[]} */
  const sources = [];
  /** @type {string[]} */
  const unreadable = [];
  /** @type {string[]} */
  const names = [];
  let disagreement = null;

  const classic = fetchJson(classicPath);
  if (classic.error !== null) {
    if (isClassicProtectionAbsent(classic.error)) {
      sources.push(
        `classic の branch protection は無い（${classicPath} が 404 Branch not protected）`,
      );
    } else {
      unreadable.push(`${classicPath}: ${classic.error}`);
    }
  } else {
    const fromClassic = contextsFromProtection(classic.json);
    if (fromClassic === null) {
      unreadable.push(
        `${classicPath}: 応答に required_status_checks の contexts / checks が無い、または形が違う`,
      );
    } else {
      names.push(...fromClassic.names);
      disagreement = fromClassic.disagreement;
      sources.push(`classic の branch protection: ${fromClassic.names.length} 件`);
    }
  }

  // 規則の数が1ページを超えても取りこぼさないよう、全ページを1つの配列にして返させる。
  const rules = fetchJson(rulesPath, { paginatedArray: true });
  if (rules.error !== null) {
    unreadable.push(`${rulesPath}: ${rules.error}`);
  } else {
    const fromRules = contextsFromBranchRules(rules.json);
    if (fromRules === null) {
      unreadable.push(`${rulesPath}: 応答が規則の配列でない、または required_status_checks の形が違う`);
    } else {
      names.push(...fromRules);
      sources.push(`ruleset の required_status_checks: ${fromRules.length} 件`);
    }
  }

  if (unreadable.length > 0) return { live: null, sources, unreadable };
  return { live: { names: [...new Set(names)].sort(), disagreement }, sources, unreadable };
}

/**
 * 🔴 空の宣言を素通りさせない。`declared` が空なら `live` が何であっても `mismatch`。
 * `live` も空だと集合演算では `match` が出てしまう(ADR 0279)。
 *
 * @param {string[]} declared
 * @param {LiveContexts | null} live
 * @param {{ sources: string[], unreadable: string[] }} [read] `readLiveRequiredChecks` の読めた事実と読めなかった理由。
 *   報告に載せるだけで、判定には使わない(判定は `live` だけで決まる)。
 * @returns {{
 *   verdict: "match" | "mismatch" | "undetermined",
 *   declared: string[],
 *   live: string[] | null,
 *   missing: string[],
 *   extra: string[],
 *   disagreement: { contexts: string[], checks: string[] } | null,
 *   reason: string,
 *   sources: string[],
 *   unreadable: string[],
 * }}
 */
export function compareRequiredStatusChecks(declared, live, read = { sources: [], unreadable: [] }) {
  const result = compareDeclaredWithLive(declared, live);
  const reason =
    result.verdict === "undetermined" && read.unreadable.length > 0
      ? `${result.reason} 読めなかった理由: ${read.unreadable.join(" / ")}`
      : result.reason;
  return { ...result, reason, sources: read.sources, unreadable: read.unreadable };
}

/**
 * @param {string[]} declared
 * @param {LiveContexts | null} live
 */
function compareDeclaredWithLive(declared, live) {
  const declaredSorted = [...declared].sort();

  if (declaredSorted.length === 0) {
    return {
      verdict: "mismatch",
      declared: declaredSorted,
      live: live === null ? null : live.names,
      missing: [],
      extra: live === null ? [] : live.names,
      disagreement: live === null ? null : live.disagreement,
      reason:
        "宣言（.github/required-status-checks.json の contexts）が空である。" +
        "この repo は常に required status check を持つ前提の門であり、空の宣言は" +
        "「一致した」ではなく「宣言ファイルが壊れている」として扱う（ADR 0279）。",
    };
  }

  if (live === null) {
    return {
      verdict: "undetermined",
      declared: declaredSorted,
      live: null,
      missing: [],
      extra: [],
      disagreement: null,
      reason:
        "required status check の現物（classic の branch protection と ruleset）を読めなかった" +
        "（gh api の失敗、または応答の形が想定と違う）。読めていないだけであり、" +
        "「ずれていない」ではない。",
    };
  }

  const liveNames = live.names;
  const missing = declaredSorted.filter((name) => !liveNames.includes(name));
  const extra = liveNames.filter((name) => !declaredSorted.includes(name));
  const drifted = missing.length > 0 || extra.length > 0 || live.disagreement !== null;

  return {
    verdict: drifted ? "mismatch" : "match",
    declared: declaredSorted,
    live: liveNames,
    missing,
    extra,
    disagreement: live.disagreement,
    reason: drifted
      ? "宣言と protection の required contexts がずれている。"
      : "宣言と protection の required contexts が一致した。",
  };
}

/**
 * @param {ReturnType<typeof compareRequiredStatusChecks>} result
 * @returns {string}
 */
export function formatComparisonReport(result) {
  const lines = [];
  const sources = result.sources ?? [];
  const unreadable = result.unreadable ?? [];
  const sourceLines = sources.map((source) => `  読めたもの: ${source}`);

  if (result.verdict === "match") {
    lines.push(`一致（match）: 宣言と protection の required contexts が一致した。`);
    lines.push(`  ${result.declared.join(" / ")}`);
    lines.push(...sourceLines);
    return lines.join("\n");
  }

  if (result.verdict === "undetermined") {
    lines.push("保留（undetermined）: required status check の現物を読めなかった。");
    lines.push("これは「ずれていない」ではない。**読めていない**。");
    if (unreadable.length === 0) {
      lines.push("  読めなかった理由は渡されていない。");
    }
    for (const cause of unreadable) {
      lines.push(`  読めなかったもの: ${cause}`);
    }
    lines.push(...sourceLines);
    // ⛔ 権限を理由に挙げるのは、応答が実際に 403 のときだけ。404 などを権限のせいにしない。
    if (unreadable.some((cause) => cause.includes("HTTP 403"))) {
      lines.push(
        "  403 は権限が足りないことを示す。GitHub Actions の既定の GITHUB_TOKEN では" +
          " classic の branch protection を読めない。",
      );
    }
    lines.push(`宣言の側だけは読めている: ${result.declared.join(" / ")}`);
    return lines.join("\n");
  }

  lines.push("不一致（mismatch）: 宣言と protection がずれている。");
  lines.push(result.reason);
  lines.push(...sourceLines);
  lines.push("【この結果の意味】どちらが正しいかは、この道具には決められない。");
  lines.push(
    "宣言（.github/required-status-checks.json）が古いのかもしれないし、protection の側が" +
      "意図せず変わったのかもしれない。どちらを直すかは人間が決めること。",
  );
  lines.push(`  宣言: ${result.declared.join(" / ") || "（空）"}`);
  lines.push(`  protection: ${(result.live ?? []).join(" / ") || "（空、または未取得）"}`);
  if (result.missing.length > 0) {
    lines.push(`  宣言に在って protection に無い: ${result.missing.join(" / ")}`);
  }
  if (result.extra.length > 0) {
    lines.push(`  protection に在って宣言に無い: ${result.extra.join(" / ")}`);
  }
  if (result.disagreement !== null) {
    lines.push(
      "  ⚠ protection の応答の中で contexts と checks が食い違っている" +
        `（contexts: ${result.disagreement.contexts.join(" / ")} / ` +
        `checks: ${result.disagreement.checks.join(" / ")}）。` +
        "GitHub 側で片方だけが動いた形なので、宣言を直す前にそちらを見ること。",
    );
  }
  lines.push(
    "  宣言を直すなら .github/required-status-checks.json の contexts と observedAt を、",
    "  protection を直すならリポジトリの branch protection・ruleset の設定を" +
      "（このスクリプトは1バイトも書き換えない）。",
  );
  return lines.join("\n");
}
