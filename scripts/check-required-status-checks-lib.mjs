/**
 * 純関数の側。ファイル I/O・`gh` の起動・`process.argv`・`process.exit` を持たない。
 *
 * ⛔ 3値(match/mismatch/undetermined)で答える。「読めなかった」を `match` に丸めると、
 * 権限が無くて読めていない回が「ずれていない」として消える。
 *
 * ⛔ どちらが正かは決めない。ずれの是正(宣言か branch protection か)は人間の判断
 * (branch protection の変更はオーナー領分。`docs/autonomy.md` §3)。
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
 * 🔴 空の宣言を素通りさせない。`declared` が空なら `live` が何であっても `mismatch`。
 * `live` も空だと集合演算では `match` が出てしまう(ADR 0279)。
 *
 * @param {string[]} declared
 * @param {{ names: string[], disagreement: { contexts: string[], checks: string[] } | null } | null} live
 * @returns {{
 *   verdict: "match" | "mismatch" | "undetermined",
 *   declared: string[],
 *   live: string[] | null,
 *   missing: string[],
 *   extra: string[],
 *   disagreement: { contexts: string[], checks: string[] } | null,
 *   reason: string,
 * }}
 */
export function compareRequiredStatusChecks(declared, live) {
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
        "branch protection の required_status_checks を読めなかった" +
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

  if (result.verdict === "match") {
    lines.push(`一致（match）: 宣言と protection の required contexts が一致した。`);
    lines.push(`  ${result.declared.join(" / ")}`);
    return lines.join("\n");
  }

  if (result.verdict === "undetermined") {
    lines.push("保留（undetermined）: branch protection を読めなかった。");
    lines.push("これは「ずれていない」ではない。**読めていない**。");
    lines.push(
      "branch protection の required_status_checks の読み出しは administration 相当の" +
        "権限を要求し、GitHub Actions の既定の GITHUB_TOKEN には付けられない可能性が高い。",
    );
    lines.push(`宣言の側だけは読めている: ${result.declared.join(" / ")}`);
    lines.push("手元で確かめるなら: gh api repos/takecchi/mnemora/branches/main/protection");
    return lines.join("\n");
  }

  lines.push("不一致（mismatch）: 宣言と protection がずれている。");
  lines.push(result.reason);
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
    "  protection を直すならリポジトリの branch protection の設定を" +
      "（このスクリプトは1バイトも書き換えない）。",
  );
  return lines.join("\n");
}
