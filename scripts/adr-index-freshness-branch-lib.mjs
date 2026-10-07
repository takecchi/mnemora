/**
 * ⛔ 手元(`GITHUB_REF` が無い)は、常に git のブランチ名 === "main" で判定する。
 * ADR PR のブランチ上の手元の `pnpm run test` を、索引を生成する前でも赤くしないため。
 * 索引が最新かは、PR 上の CI か `node scripts/generate-adr-index.mjs --check` で見る。
 *
 * ⚠ 名前を `isMain` に戻さない。`pull_request` の CI は main ブランチではない(`refs/pull/<n>/merge`)が、検査は有効にしたい。
 * `isMain` のままだと「main ではないのに true を返す」名前と中身の食い違いになる(ADR 0192)。
 *
 * `forceOverride` は手元での変異試験専用(`ADR_INDEX_FRESHNESS_FORCE=1`)。
 */

const PULL_REQUEST_MERGE_REF_RE = /^refs\/pull\/\d+\/merge$/;

/**
 * @param {string} githubRef
 * @returns {boolean}
 */
export function isPullRequestMergeRef(githubRef) {
  return typeof githubRef === "string" && PULL_REQUEST_MERGE_REF_RE.test(githubRef);
}

/**
 * @param {{ githubRef?: string, gitBranch?: string, forceOverride?: boolean }} input
 * @returns {boolean}
 */
export function shouldEnforceAdrIndexFreshness({ githubRef, gitBranch, forceOverride = false }) {
  if (forceOverride) return true;
  // `GITHUB_REF` が在ればそれを信じ、git のブランチ名は見ない。
  // CI の中で `git rev-parse --abbrev-ref HEAD` は "HEAD"(detached)を返すことがあり、誤って安全側に倒れてしまう。
  if (typeof githubRef === "string" && githubRef.length > 0) {
    return githubRef === "refs/heads/main" || isPullRequestMergeRef(githubRef);
  }
  return gitBranch === "main";
}
