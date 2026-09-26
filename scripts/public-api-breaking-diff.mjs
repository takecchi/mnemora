#!/usr/bin/env node
/**
 * v1.0.0 以降に公開 API へ「静かに」入った破壊的変更の**候補**を、実行時に組んだ2つの
 * 公開 API snapshot（`scripts/__snapshots__/public-api/{anthropic,core,local-embedding,
 * openai,postgres,testkit}.d.ts`）の構造的な diff から一覧にする道具（Issue #818 /
 * `#811`/`#813`/`#815`）。
 *
 * ## なぜ要るか
 *
 * `docs/migration-v1.md` は「`v1.0.0` より後に着地した破壊的変更の節は、まだここに無い。
 * …この3件以外に `v1.0.0` より後に着地してまだ数えていない変更が残っているかどうかは、
 * 別途棚卸しが要る」と自ら書いている（同ファイル、`v0.5.0 → v1.0.0` 節の末尾）。
 * Issue #818 は実際に、`TenantSettingsStoreConformanceOptions.supportsTaxonomyMode` が
 * 必須フィールドとして着地しながら CHANGELOG/ADR のどちらにも破壊性が書かれていなかった
 * （後に PR #827 で任意へ巻き戻された）実例を見つけている。この道具はその「棚卸し」を、
 * 次に同じことが起きたときのために自動化する——ただし**確定はしない**（下記）。
 *
 * ## 数え方の規律（`docs/migration-v1.md` 633〜638行）
 *
 * > ⛔ **`packages/<pkg>/src` の差分では数えないこと**——マイグレーションの追加のように `src` を
 * > 1行も触らない変更を取りこぼす。⟹ **公開 API の実 diff
 * > （`scripts/__snapshots__/public-api/`）から数えること。**
 *
 * この道具は `packages/<pkg>/src` を一切読まない。基準（`--base`、既定 `v1.0.0`）と対象
 * （`--head`、既定は**作業ツリー**）の両方について、`scripts/__snapshots__/public-api/*.d.ts`
 * だけを見る——**その場で `git show <ref>:<path>` を実行し**（`--head` 省略時は作業ツリーの
 * ファイルをそのまま読む）、期待値や件数を道具・生成物に焼き込まない
 * （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。
 *
 * ## union の入力/出力の判定（`docs/migration-v1.md` 854〜889行、項目17）
 *
 * > 🔴 **だが同じ `[0.2.0]` は…「網羅性検査（`never`）をしているコードは壊れる」と書きながら
 * > …「Changed（後方互換だが挙動が変わりうるもの）」に置いている** ⟹ ⛔ **この repo には、
 * > 同じ形に対する扱いが2つ在り、線は引かれていない。**…**その線そのものは
 * > [Issue #541](https://github.com/takecchi/mnemora/issues/541) に残っている。**
 *
 * ⟹ この道具は「出力側の union に値が増えた」だけを破壊的として数え、「入力側だけで
 * 広がった」ものは非破壊として黙って外す。入力/出力のどちらか（または両方/不明）を
 * 保守的なヒューリスティックで判定し、決め切れないものは一覧の「要人判断」枠に出す
 * （実装・理由は `scripts/public-api-breaking-diff-lib.mjs` の `computeIoClosures`）。
 * Issue #541 の線引きそのものをこの道具が代わりに決めることはしない。
 *
 * ## これは門ではない
 *
 * ⛔ **判定しない。確定しない。exit code は常に `0`。**（想定外の失敗も最上位の
 * try/catch で拾い、失敗内容を Markdown に出したうえで `0` を返す——
 * `scripts/north-star-default-probe.mjs` と同じ設計。）出す一覧が「これで全部」だとは
 * 名乗らない——検出しない形は上と `public-api-breaking-diff-lib.mjs` 冒頭に明記してある。
 * `docs/migration-v1.md`/`CHANGELOG.md` への計上（確定と書き込み）は人が行う
 * （AGENTS.md「⚠ 機械には「検出」まで」）。
 *
 * ## 使い方
 *
 * ```
 * node scripts/public-api-breaking-diff.mjs                       # v1.0.0 vs 作業ツリー
 * node scripts/public-api-breaking-diff.mjs --base v0.5.0         # 基準を変える
 * node scripts/public-api-breaking-diff.mjs --head 55a39bd        # 対象を特定 commit にする
 * node scripts/public-api-breaking-diff.mjs --base v1.0.0 --head 55a39bd
 * ```
 *
 * CI では `.github/workflows/ci.yml` の `build` ジョブから
 * `>> "$GITHUB_STEP_SUMMARY"` で Job Summary に流し込む（既定引数のまま、
 * `v1.0.0` vs 作業ツリー＝そのビルドの `main`）。
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { PUBLISH_TARGETS } from "./publish-targets.mjs";
import {
  buildFatalFallbackMarkdown,
  buildFullMarkdownReport,
  buildPackageModel,
  diffPackageModels,
} from "./public-api-breaking-diff-lib.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = "v1.0.0";

function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, head: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--head") args.head = argv[++i];
    else throw new Error(`不明な引数: ${a}`);
  }
  return args;
}

function snapshotRelPath(dirBasename) {
  return `scripts/__snapshots__/public-api/${dirBasename}.d.ts`;
}

/**
 * `git show <ref>:<path>` をその場で実行する。数字・内容は一切焼き込まない。
 *
 * `stdio` を明示して `stderr` も `pipe` にする——既定（`execFileSync` は `stdio` 未指定だと
 * 子プロセスの `stderr` を親の `stderr` へそのまま流す）のままだと、CI の Job Summary には
 * 出ない生の `git` エラーがログにだけ漏れ、`buildFullMarkdownReport` の「読み取りに失敗した
 * パッケージ」欄には `git` のエラー本文が載らない（`error.message` だけになる）。ここで
 * 拾って `error.stderr` から一行目を足すことで、一覧のほうにも理由が出るようにする。
 */
function readSnapshotAtRef(ref, relPath) {
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderrFirstLine = String(error.stderr ?? "").split("\n")[0];
    const wrapped = new Error(
      `git show ${ref}:${relPath} に失敗した${stderrFirstLine ? `: ${stderrFirstLine}` : ""}`,
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function readSnapshotFromWorkingTree(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function basenameOfDir(dir) {
  return dir.split("/").pop();
}

async function main() {
  let markdown;
  try {
    const args = parseArgs(process.argv.slice(2));
    const headLabel = args.head ?? "作業ツリー";

    const perPackage = PUBLISH_TARGETS.map((target) => {
      const pkgBasename = basenameOfDir(target.dir);
      const relPath = snapshotRelPath(pkgBasename);
      try {
        const baseText = readSnapshotAtRef(args.base, relPath);
        const headText = args.head
          ? readSnapshotAtRef(args.head, relPath)
          : readSnapshotFromWorkingTree(relPath);
        const baseModel = buildPackageModel(baseText, `${args.base}:${relPath}`);
        const headModel = buildPackageModel(headText, `${headLabel}:${relPath}`);
        const diff = diffPackageModels(baseModel, headModel);
        return { pkgName: target.name, diff, error: null };
      } catch (error) {
        return {
          pkgName: target.name,
          diff: null,
          error: error instanceof Error ? error.message.split("\n")[0] : String(error),
        };
      }
    });

    markdown = buildFullMarkdownReport({
      base: args.base,
      head: headLabel,
      perPackage,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    markdown = buildFatalFallbackMarkdown(error);
  }
  console.log(markdown);
}

await main();
// **明示的に 0 を宣言する**——このスクリプトは門ではない（冒頭のコメント参照）。
process.exit(0);
