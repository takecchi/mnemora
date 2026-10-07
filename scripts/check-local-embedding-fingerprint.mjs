#!/usr/bin/env node
/**
 * ⛔ 期待値（repo 名・hash）をリポジトリに焼き込まない。repo 名は `DEFAULT_LOCAL_EMBEDDING_REPO` の文字列リテラルを
 * 正規表現で取り出し、hash は毎回 Hugging Face の tree API を引いて、その瞬間の repo の内容を期待値にする。
 * ⛔ 照合先は `main` のままにする。固定した revision（`scripts/local-embedding-pinned-revision.json`）は、
 * キャッシュの置き場所の解釈（`normalizeActualPath`）にだけ使う。
 * ⛔ 保留（exit 2）に倒してよいのは、この repo が直せない外部要因（tree API が読めない・届かない）だけ。
 * 宣言された repo が存在しない（404）はこの repo が直せるので、前段で切り出して赤にする。429・5xx は混ぜない。
 * ⛔ ハッシュの選び分けは、ファイル名や拡張子で分岐せず、HF の応答に `lfs` が在るかどうかだけで決める。
 * ⛔ transformers.js の既定のキャッシュ場所を推測しない（外れると「検査していない」を「一致した」と取り違える）。
 * ⚠ `undetermined`（exit 2）を `match` と取り違えないこと。
 * `--api-base` は、到達失敗（exit 2）の経路を単体試験・変異試験から決定的に再現するための注入点で、
 * 本番の挙動を変えるためではない。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareFingerprints,
  expectedHashOfTreeEntry,
  formatFingerprintReport,
  gitBlobSha1Hex,
  cacheRepoDirs,
  normalizeActualPath,
} from "./check-local-embedding-fingerprint-lib.mjs";

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

const DEFAULT_HF_API_BASE = "https://huggingface.co";

function parseArgs(argv) {
  const args = { cacheDir: undefined, apiBase: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cache-dir") args.cacheDir = argv[++i];
    else if (a === "--api-base") args.apiBase = argv[++i];
    else if (a === "--json") args.json = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(3);
    }
  }
  return args;
}

/**
 * ⛔ repo 名のフォールバック値を持たない。読めなければ `null` を返す。
 *
 * @returns {string | null}
 */
function readDeclaredRepo() {
  const providerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "packages",
    "local-embedding",
    "src",
    "local-embedding-provider.ts",
  );
  let source;
  try {
    source = readFileSync(providerPath, "utf8");
  } catch {
    return null;
  }
  const matched = /export const DEFAULT_LOCAL_EMBEDDING_REPO\s*=\s*"([^"]+)"/.exec(source);
  return matched ? matched[1] : null;
}

/**
 * キャッシュの置き場所の解釈にのみ使う。⛔ 「何と照合するか」は変えない。
 * 読めなくても赤にせず `null` を返す（正規化しない）。
 *
 * @returns {string | null}
 */
function readPinnedRevisionForCacheLayout() {
  const declarationPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "local-embedding-pinned-revision.json",
  );
  let source;
  try {
    source = readFileSync(declarationPath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  return typeof parsed?.sha === "string" && parsed.sha.length > 0 ? parsed.sha : null;
}

/**
 * 404 か否かの2値に留める。⛔ 429・5xx・到達失敗は `"undetermined"` で、続行して tree 側の判定に委ねる。
 * ⛔ 404 は再試行して確かめる（1回で赤にすると HF の一過性の不調が必須ジョブを止める）。
 * {@link RETRY_ATTEMPTS} 回すべてが 404 のときだけ `"missing"`。
 *
 * @param {string} apiBase
 * @param {string} repo
 * @returns {Promise<{ verdict: "missing" | "present" | "undetermined", url: string, detail: string }>}
 */
async function checkDeclaredRepoExists(apiBase, repo) {
  const url = `${apiBase}/api/models/${repo}`;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    let status;
    try {
      status = (await fetch(url)).status;
    } catch (error) {
      return { verdict: "undetermined", url, detail: String(error?.message ?? error) };
    }
    if (status !== 404) {
      return {
        verdict: status >= 200 && status < 300 ? "present" : "undetermined",
        url,
        detail: `HTTP ${status}`,
      };
    }
    if (attempt < RETRY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return { verdict: "missing", url, detail: `HTTP 404（${RETRY_ATTEMPTS} 回とも）` };
}

/**
 * @param {string} url
 * @returns {Promise<{ ok: true, entries: unknown[] } | { ok: false, reason: string }>}
 */
async function fetchTreeWithRetry(url) {
  let lastReason = "";
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        lastReason = `HTTP ${response.status} ${response.statusText}`;
      } else {
        const body = await response.json();
        if (!Array.isArray(body)) {
          lastReason = `tree API の応答が配列でなかった: ${JSON.stringify(body).slice(0, 200)}`;
        } else {
          return { ok: true, entries: body };
        }
      }
    } catch (error) {
      lastReason = String(error?.message ?? error);
    }
    if (attempt < RETRY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  return { ok: false, reason: lastReason };
}

/**
 * ⛔ 読み飛ばしたものを黙って捨てない。件数と理由を持ち回り、呼び出し側が文面に出す（判定は変えない）。
 * `type: "directory"` は正常なので数えない。
 *
 * @param {unknown[]} entries
 * @returns {{ map: Map<string, { algorithm: string, hex: string }>, noOid: string[], unrecognized: number }}
 */
function buildExpectedByPath(entries) {
  const map = new Map();
  const noOid = [];
  let unrecognized = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      unrecognized += 1;
      continue;
    }
    if (entry.type === "directory") {
      continue;
    }
    if (entry.type !== "file" || !entry.path) {
      unrecognized += 1;
      continue;
    }
    const expected = expectedHashOfTreeEntry(entry);
    if (expected) {
      map.set(entry.path, expected);
    } else {
      noOid.push(entry.path);
    }
  }
  return { map, noOid, unrecognized };
}

/**
 * @param {{ noOid: string[], unrecognized: number }} skipped
 * @returns {string[]}
 */
function formatSkippedTreeEntries(skipped) {
  const lines = [];
  if (skipped.noOid.length > 0) {
    lines.push(
      `⚠ HF の tree に、hash を取れないエントリが ${skipped.noOid.length} 件あった` +
        "（oid も lfs.oid も無い）。⟹ **Hugging Face の応答の形が変わった可能性がある。**" +
        "これらは期待値を作れないので照合の対象から外れている——" +
        "対応する手元のファイルは「素性不明」として数えられる。",
    );
    for (const path of skipped.noOid) {
      lines.push(`  hash を取れなかった tree エントリ: ${path}`);
    }
  }
  if (skipped.unrecognized > 0) {
    lines.push(
      `⚠ HF の tree に、file でも directory でもないエントリが ${skipped.unrecognized} 件あった` +
        "（type/path が想定と違う）。⟹ **Hugging Face の応答の形が変わった可能性がある。**",
    );
  }
  return lines;
}

/**
 * ⛔ `expectedByPath` に無い path（素性不明のファイル）も列挙を続ける。除外すると門として機能しない。
 * ⛔ 読めなかったファイルで例外を投げない（exit 3 になり、CLI 自身のバグと区別できなくなる）。
 * `unreadable` として返し、呼び出し側が赤にする。
 * ⛔ `pinnedRevision` の正規化は「照合対象」を変えない（tree は今も `main`）。
 *
 * @param {string} repoDir
 * @param {Map<string, { algorithm: string, hex: string }>} expectedByPath
 * @param {string | null} pinnedRevision
 * @returns {{ actual: { path: string, algorithm: string, hex: string }[], unreadable: { path: string, reason: string }[] }}
 */
function collectActualFiles(repoDir, expectedByPath, pinnedRevision) {
  if (!existsSync(repoDir)) {
    return { actual: [], unreadable: [] };
  }
  const dirents = readdirSync(repoDir, { recursive: true, withFileTypes: true });
  const actual = [];
  const unreadable = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const parentPath = dirent.parentPath ?? dirent.path;
    const absPath = join(parentPath, dirent.name);
    const rawRelPath = relative(repoDir, absPath).split(sep).join("/");
    const relPath = normalizeActualPath(rawRelPath, pinnedRevision);
    const expected = expectedByPath.get(relPath);
    // ⛔ 拡張子・ファイル名では分岐しない——HF の応答（`expected.algorithm`）だけに従う。
    const algorithm = expected?.algorithm ?? "git-blob-sha1";
    let bytes;
    try {
      bytes = readFileSync(absPath);
    } catch (error) {
      unreadable.push({ path: relPath, reason: String(error?.message ?? error) });
      continue;
    }
    const hex =
      algorithm === "sha256"
        ? createHash("sha256").update(bytes).digest("hex")
        : gitBlobSha1Hex(bytes);
    actual.push({ path: relPath, algorithm, hex });
  }
  return { actual, unreadable };
}

function red(reason) {
  console.error(`赤（mismatch）: ${reason}`);
  process.exit(1);
}

function undetermined(reason) {
  console.error(`保留（undetermined）: ${reason}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const repo = readDeclaredRepo();
  if (!repo) {
    red(
      "packages/local-embedding/src/local-embedding-provider.ts から " +
        "DEFAULT_LOCAL_EMBEDDING_REPO を取り出せなかった（宣言の唯一の出所が読めない）。",
    );
    return;
  }

  // 保留にしない。この門は CI 専用で、置き場所が決まっている前提であり、引けないのは設定が壊れている。
  const cacheDir = args.cacheDir ?? process.env.MNEMORA_LOCAL_EMBEDDING_CACHE_DIR;
  if (!cacheDir) {
    red(
      "キャッシュの場所が指定されていない（--cache-dir も " +
        "MNEMORA_LOCAL_EMBEDDING_CACHE_DIR も無い）。" +
        "transformers.js の既定のキャッシュ場所は推測しない。",
    );
    return;
  }

  console.log(`宣言された repo（唯一の出所: local-embedding-provider.ts）: ${repo}`);
  console.log(`キャッシュの場所: ${cacheDir}`);

  const apiBase = args.apiBase ?? DEFAULT_HF_API_BASE;

  // 保留にしない。答えられないときは続行する。
  const existence = await checkDeclaredRepoExists(apiBase, repo);
  if (existence.verdict === "missing") {
    red(
      `宣言された repo（${repo}）が Hugging Face に存在しない（${existence.url} が ` +
        `${existence.detail}）。⟹ 宣言の書き間違い・repo の改名・上流での削除を疑うこと。` +
        "⛔ これは保留にしない——「宣言が何も指していない」は、判定を待つ話ではなく " +
        "設定が壊れている話である（ADR 0253 追記1 / Issue #586）。",
    );
    return;
  }
  console.log(`宣言された repo の存在確認: ${existence.verdict}（${existence.detail}）`);

  const treeUrl = `${apiBase}/api/models/${repo}/tree/main?recursive=1&expand=1`;
  const treeResult = await fetchTreeWithRetry(treeUrl);
  if (!treeResult.ok) {
    // 保留にしてよいのは、この repo の管理が及ばない外部要因（ネットワーク）だけ。
    undetermined(
      `Hugging Face の tree API を ${RETRY_ATTEMPTS} 回試したが取得できなかった` +
        `（${treeUrl}）。最後の失敗理由: ${treeResult.reason}`,
    );
    return;
  }

  const { map: expectedByPath, ...skipped } = buildExpectedByPath(treeResult.entries);
  for (const line of formatSkippedTreeEntries(skipped)) {
    console.error(line);
  }
  const pinnedRevision = readPinnedRevisionForCacheLayout();
  console.log(
    pinnedRevision !== null
      ? `固定した revision の宣言（キャッシュの置き場所の解釈にのみ使う。照合対象は main のまま）: ${pinnedRevision}`
      : "固定した revision の宣言を読めなかった（キャッシュの置き場所は revision=main のフラットな配置として解釈する）",
  );
  const actual = [];
  const unreadable = [];
  for (const repoDir of cacheRepoDirs(cacheDir, repo, pinnedRevision)) {
    const collected = collectActualFiles(repoDir, expectedByPath, pinnedRevision);
    actual.push(...collected.actual);
    unreadable.push(...collected.unreadable);
  }

  const result = compareFingerprints({ actual, expectedByPath });
  console.log(formatFingerprintReport(result));

  // ⛔ 照合対象（tree の URL）は固定した宣言へ切り替えない。不一致は `main` が固定した時点から動いた合図で、
  // 固定 revision を更新するかどうかは人間が判断する。
  if (result.verdict !== "match") {
    console.error(
      "⚠ この門は Hugging Face の `main` の tree と照合し続けている" +
        "（固定した revision の宣言はキャッシュの置き場所の解釈にのみ使い、照合対象は変えていない）。" +
        "不一致が「上流の main が動いたこと」によるものなら、CI が使う固定 revision の宣言" +
        "（scripts/local-embedding-pinned-revision.json、Issue #597 案(a)）を新しい sha に" +
        "更新することを検討すること。",
    );
  }

  // 読めなかったファイルが在る時点で「全ファイル一致」は主張できないので、ここで上書きする。
  if (unreadable.length > 0) {
    console.error(`読めなかったファイル ${unreadable.length} 本:`);
    for (const item of unreadable) {
      console.error(`  ${item.path}: ${item.reason}`);
    }
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          repo,
          cacheDir,
          repoDirs: cacheRepoDirs(cacheDir, repo, pinnedRevision),
          apiBase,
          unreadable,
          skippedTreeEntries: skipped,
          ...result,
        },
        null,
        2,
      ),
    );
  }

  if (result.verdict === "match" && unreadable.length === 0) {
    process.exit(0);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(3);
});
