/**
 * `scripts/check-required-status-checks.mjs`（main のブランチ保護 — branch
 * protection — の required status checks が、宣言（`.github/required-status-checks.json`）
 * と一致しているかを突き合わせる CLI）の純関数の側。
 *
 * ファイル I/O・`gh` の起動・`process.argv`・`process.exit` を一切持たない
 * ——`scripts/ci-green-check-lib.mjs` / `scripts/check-local-embedding-fingerprint-lib.mjs`
 * と同じ分担・同じ理由である。本物の GitHub API を叩かずに、合成した応答で
 * 突き合わせだけを単体試験できる（`scripts/__tests__/check-required-status-checks-lib.test.mjs`）。
 *
 * ## 何を塞ぐために在るか（Issue #617、ADR 0274、ADR 0277）
 *
 * ADR 0274 は、required status check の文脈名 `examples/chat (本物の Postgres +
 * pgvector、擬似 provider)` が**中身と食い違って腐っていた**のを直した——ジョブの
 * 実態が変わっても、branch protection の側に登録された文脈名の文字列は誰も見ておらず、
 * 誰にも気づかれずに腐っていた。
 *
 * **腐りが誰にも気づかれなかったのは、担い手の不注意ではなく、branch protection の
 * いまの設定を repo 側から見返す口が無かったからである。** `docs/decisions/0215-*.md`
 * （`ci-green-check.mjs` の下限）は required contexts を*読む*が、それは「CI が緑か」の
 * 判定のためであり、**「読んだ値がこの repo の期待と一致しているか」は問うていない。**
 * この lib はその隙間——「いまの protection は、私たちが思っている6本のままか」——を
 * 塞ぐためにある。
 *
 * ## 3値で答える。「読めなかった」を「一致した」へ倒さない（ADR 0253 / ADR 0222 と同じ形）
 *
 * この repo には既に第3の状態の語彙が在る——`check-local-embedding-fingerprint.mjs`
 * が match(0)/mismatch(1)/undetermined(2)、`ci-green-check.mjs` が green(0)/red(1)/
 * pending(2)、`compare-summary-lib.mjs`（ADR 0222）が pass(0)/fail(1)/indeterminate(2)。
 * この lib も同じ形に揃え、**`verdict: "match" | "mismatch" | "undetermined"`** を返す
 * ——「読めなかった」を `match` に丸めると、権限が無くて読めていない回が
 * 「ずれていない」として出力から消える（`AGENTS.md`「⚠ 機械には『検出』まで」節・
 * ADR 0223 決定2「機械が判定できなかったときは、従来どおりに倒さず赤／保留で止める」
 * と同じ向き）。
 *
 * ## どちらが正かは決めない
 *
 * ずれていたとき、直すべきなのが宣言の側か branch protection の側かは**この lib には
 * 分からない**。{@link compareRequiredStatusChecks} は「ずれている」とだけ言い、
 * どちらを直すかは人間が決める（`docs/autonomy.md` §3「してはいけないこと」——
 * branch protection の設定変更はオーナー領分）。
 */

/**
 * `gh api repos/<owner>/<repo>/branches/<branch>/protection` が返す生の JSON
 * （`JSON.parse` 済みのオブジェクト）から、required な context 名を取り出す。
 *
 * ⛔ **`-q` で `.required_status_checks.contexts` を直接絞った結果を渡さないこと**
 * ——呼び出し側（CLI）は生の JSON を丸ごと渡し、ここで**形**を見て判定する
 * （`ci-green-check.mjs` の `fetchRequiredStatusChecks` の docstring と同じ理由:
 * 「`required_status_checks` 自体が無い」と「在るが `contexts` が空配列」を
 * 区別するためである）。
 *
 * **`contexts` と `checks` の両方を見る。** GitHub は同じものを2つの欄で返す
 * ——`contexts` は後方互換のために残っている文字列配列、`checks` は
 * `{context, app_id}` の配列（新しい側）。**片方だけ読むと、もう片方だけが
 * 更新された回を取り逃す**ので、食い違いそのものも結果に載せる。
 *
 * 欄が無い／形が違うときは `null` を返す（＝読めなかった）。**空配列は返さない**
 * ——空配列は「required が1つも無い」という別の事実であって、それを「読めな
 * かった」と同じ値にすると2つが混ざる。
 *
 * @param {unknown} protection `gh api .../branches/<branch>/protection` の応答（parse 済み）
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

  // どちらか片方しか無ければそれを使う。両方在れば `checks` を採り（新しい側の欄）、
  // 食い違いは別に報告する。
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
 * 宣言（`.github/required-status-checks.json` の `contexts`）と、
 * {@link contextsFromProtection} が取り出した実値を突き合わせる。
 *
 * 🔴 **空の宣言を、素通りさせない。** `declared` が空配列のときは、`live` が
 * 何であっても（`live` 自身が空配列でも）即座に `mismatch` を返す——比較の
 * 結果として `missing`/`extra` が両方空になり「一致」に見えてしまう窓を、
 * 比較へ進む前に閉じる。
 *
 * **なぜ「片方向の包含」だけでは足りないか**: 「宣言の各要素が `live` に在るか」
 * だけを見る実装は、`declared` が空だと*真空で真*になる——**何も無い集合は、
 * どんな集合にも「包含されている」**。この lib は逆方向（`live` の各要素が
 * `declared` に在るか＝`extra`）も見るので、`live` が非空なら空の宣言は
 * `extra` によって自動的に `mismatch` になる。だが **`live` も同時に空**
 * （branch protection 側に required が1つも無い）だと、両方向とも空集合の
 * 比較になり、素の集合演算では `match` が出てしまう。**この repo は常に
 * 6本の required check を持つことを前提にした門であり**、宣言が空という
 * 状態そのものが「宣言ファイルが壊れている」ことを意味する——だから
 * `declared` が空である事実**だけ**を理由に、`live` を見る前に `mismatch`
 * で止める（この判断の理由は ADR 0277「決めたこと」参照）。
 *
 * @param {string[]} declared
 * @param {{ names: string[], disagreement: { contexts: string[], checks: string[] } | null } | null} live
 *   `null` は「protection を読めなかった」を表す。
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
        "「一致した」ではなく「宣言ファイルが壊れている」として扱う（ADR 0277）。",
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
 * {@link compareRequiredStatusChecks} の結果を、人が読んで次の一手が決まる
 * 日本語の報告文字列にする。
 *
 * **赤・保留の意味を文そのものに書く。** ずれたときに読む人が最初に知りたいのは
 * 「どちらを直すのか」で、それはこの lib には決められない——だから「どちらかを
 * 人間が決める必要がある」と明示する。
 *
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
