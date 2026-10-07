import { execFileSync } from "node:child_process";

/**
 * `git rev-parse HEAD` を試みる。取れなければ `null` を返し、推測で埋めない
 * （浅いチェックアウト・`git` が無い・git 管理外のどれも起こり得る）。
 */
export function tryGitRevParseHead(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // 40桁の16進以外は本物のコミットハッシュと見分けが付かなくなるので、null に倒す。
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
