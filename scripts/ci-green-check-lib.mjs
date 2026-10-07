/**
 * ⛔ 「run」(`actions/runs/{run_id}`)の `conclusion` は扱わない。run 全体の conclusion と、その中の1 job の conclusion は別物で、混同しないことがこのファイルの前提。
 */

/** @param {{ name: string, status: string, conclusion: string | null }[]} checkRuns */
export function summarizeCheckRuns(checkRuns) {
  const total = checkRuns.length;
  const pending = checkRuns.filter((r) => r.status !== "completed").map((r) => r.name);
  const nonSuccess = checkRuns
    .filter((r) => r.status === "completed" && r.conclusion !== "success")
    .map((r) => ({ name: r.name, conclusion: r.conclusion }));
  const allCompleted = pending.length === 0;
  const allSuccess = allCompleted && nonSuccess.length === 0;
  return { total, pending, nonSuccess, allCompleted, allSuccess };
}

/**
 * ⚠ 同名の check-run が複数在りうる(再実行など)ので、厳しい側に倒す。
 * 1件でも未完なら `pending`、全件完了でも1件でも success でなければ `nonSuccess`。最後の1件だけ見て success と取り違えない。
 *
 * @param {{name:string,status:string,conclusion:string|null}[]} checkRuns
 * @param {string[]} requiredContexts
 * @returns {{ missing: string[], pending: string[], nonSuccess: {name:string,conclusion:string|null}[] }}
 */
export function summarizeRequiredContexts(checkRuns, requiredContexts) {
  const byName = new Map();
  for (const run of checkRuns) {
    if (!byName.has(run.name)) byName.set(run.name, []);
    byName.get(run.name).push(run);
  }

  const missing = [];
  const pending = [];
  const nonSuccess = [];

  for (const name of requiredContexts) {
    const runs = byName.get(name);
    if (!runs || runs.length === 0) {
      missing.push(name);
      continue;
    }
    const incomplete = runs.filter((r) => r.status !== "completed");
    if (incomplete.length > 0) {
      pending.push(name);
      continue;
    }
    const failed = runs.filter((r) => r.conclusion !== "success");
    if (failed.length > 0) {
      // 同名が複数在るときは、失敗した実行を名指しする(最後の1件だけを見ない)。
      for (const r of failed) nonSuccess.push({ name: r.name, conclusion: r.conclusion });
    }
  }

  return { missing, pending, nonSuccess };
}

/**
 * ⛔ 緑の判定には使わない。`status` は `total === 0` の間ずっと `pending` で、変わるのは理由の文言だけ。
 * `"dirty"` は merge ref が作れず run が作られない(待っても来ない)。「まだ登録されていない可能性」という待てと読める文言を使わず、衝突を名指しする。
 * 🔴 `"unknown"` を `"dirty"` と同じ扱いにしない。そのとき run が作られるかは確かめていないので、従来の理由に留める。
 * 取得できなかった(`null`/`undefined`)ときも、従来の理由をそのまま返す。
 *
 * @param {string | null | undefined} mergeableState
 * @returns {string}
 */
function describeEmptyCheckRunsReason(mergeableState) {
  if (mergeableState === "dirty") {
    return (
      "check-runs が0件——base と衝突しており（mergeable_state=dirty）、GitHub が merge ref を" +
      "作れないため run 自体が作られない（Issue #615 実測）。待っても来ない——base を" +
      "取り込み直して衝突を解くこと。"
    );
  }
  return "check-runs が0件——まだ登録されていない可能性がある（Issue #228 観測1）";
}

/**
 * ⛔ `total === 0` は `pending`。0件を「対象が無いから緑」と読まない。理由の文言だけを `mergeableState` で切り分け、判定は変えない。
 * `skipped`/`neutral`/`cancelled`/`timed_out`/`action_required` は success ではないので `red` 側に入る。
 * 下限は required status checks に縛る(ADR 0215)。`needs:` を持つ job は依存元が終わるまで check-run 自体が無いため、
 * 登録済みが全部 success でも `green` にしてはいけない窓がある。
 *
 * ⚠ `requiredContexts` は省略できない。省略可能にすると「取得できなかったから従来どおり」で下限が静かに無効化される。
 * 取得不能は明示的に `null` を渡す。
 *
 * @param {{ name: string, status: string, conclusion: string | null }[]} checkRuns
 * @param {string[] | null | undefined} requiredContexts
 * @param {string | null | undefined} mergeableState
 * @returns {{ status: "pending" | "red" | "green", reason: string, summary: ReturnType<typeof summarizeCheckRuns>, required: { contexts: string[] | null, missing: string[], pending: string[], nonSuccess: {name:string,conclusion:string|null}[] } }}
 */
export function verdict(checkRuns, requiredContexts, mergeableState) {
  const summary = summarizeCheckRuns(checkRuns);

  if (!Array.isArray(requiredContexts)) {
    return {
      status: "pending",
      reason: "必須チェックの集合を取得できていない——下限が無いので判定しない（ADR 0215）",
      summary,
      required: { contexts: null, missing: [], pending: [], nonSuccess: [] },
    };
  }
  if (requiredContexts.length === 0) {
    return {
      status: "pending",
      reason: "必須チェックが0件——下限が取れないので判定しない（ADR 0215）",
      summary,
      required: { contexts: requiredContexts, missing: [], pending: [], nonSuccess: [] },
    };
  }

  const requiredSummary = summarizeRequiredContexts(checkRuns, requiredContexts);
  const required = { contexts: requiredContexts, ...requiredSummary };

  if (summary.total === 0) {
    return {
      status: "pending",
      reason: describeEmptyCheckRunsReason(mergeableState),
      summary,
      required,
    };
  }
  if (requiredSummary.missing.length > 0) {
    let reason =
      `必須チェック${requiredContexts.length}件のうち${requiredSummary.missing.length}件が` +
      `まだ登録されていない（集合が不完全）: ${requiredSummary.missing.join(", ")}`;
    if (requiredSummary.pending.length > 0) {
      reason += `（登録済みの必須チェックの中にも走っている最中のものが在る: ${requiredSummary.pending.join(", ")}）`;
    }
    return { status: "pending", reason, summary, required };
  }
  if (!summary.allCompleted) {
    return {
      status: "pending",
      reason: `${summary.pending.length}件が completed でない: ${summary.pending.join(", ")}`,
      summary,
      required,
    };
  }
  if (requiredSummary.nonSuccess.length > 0) {
    return {
      status: "red",
      reason:
        `必須チェックのうち${requiredSummary.nonSuccess.length}件が success でない: ` +
        `${JSON.stringify(requiredSummary.nonSuccess)}`,
      summary,
      required,
    };
  }
  if (!summary.allSuccess) {
    return {
      status: "red",
      reason: `${summary.nonSuccess.length}件が success でない: ${JSON.stringify(summary.nonSuccess)}`,
      summary,
      required,
    };
  }
  return {
    status: "green",
    reason: `${summary.total}件すべてが completed かつ success`,
    summary,
    required,
  };
}

/**
 * ⚠ `stable: true` は「この2回の間に増減が無かった」だけで、「もう増えない」ことの証明ではない。
 *
 * @param {{ name: string }[]} prevCheckRuns
 * @param {{ name: string }[]} currCheckRuns
 */
export function compareCheckRunNameSets(prevCheckRuns, currCheckRuns) {
  const prevNames = new Set(prevCheckRuns.map((r) => r.name));
  const currNames = new Set(currCheckRuns.map((r) => r.name));
  const added = [...currNames].filter((n) => !prevNames.has(n));
  const removed = [...prevNames].filter((n) => !currNames.has(n));
  return { stable: added.length === 0 && removed.length === 0, added, removed };
}

/**
 * ⚠ 「緑を見た sha」と「実際にマージされる sha」の一致を、文書の指示ではなく `gh pr merge --match-head-commit` に強制させる。
 *
 * @param {string|number} prNumber
 * @param {string} sha
 * @returns {string}
 */
export function formatMatchHeadCommitHint(prNumber, sha) {
  const shortSha = sha.slice(0, 7);
  return (
    `この判定は sha ${shortSha} に対するものである。この sha 以外をマージしないこと:\n` +
    `  gh pr merge ${prNumber} --squash --delete-branch --match-head-commit ${sha}`
  );
}
