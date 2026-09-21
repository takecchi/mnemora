#!/usr/bin/env node
/**
 * `@mnemora/local-embedding` が実際に読み込んだ重みファイルが、宣言された
 * Hugging Face repo が**今まさに**持っているものと一致するかを照合する CLI。
 *
 * ⭐ **この道具は期待値をリポジトリに1つも焼き込まない。**
 *
 * - **repo 名はここにもハードコードしない。** 唯一の出所は
 *   `packages/local-embedding/src/local-embedding-provider.ts` の
 *   `DEFAULT_LOCAL_EMBEDDING_REPO` であり、この CLI はその文字列リテラルを
 *   正規表現で取り出す（`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。
 * - **期待する hash もここには置かない。** 毎回 Hugging Face の tree API を実際に
 *   引いて、**その瞬間の repo の内容**を期待値にする。ファイルにハッシュを
 *   埋め込むと、repo が更新された翌日には陳腐化した期待値と黙って比較することになる
 *   ——それは「照合」ではなく「1回限りのスナップショットとの比較」であり、
 *   この道具が検査したいこと（今まさに一致しているか）とは別物になる。
 *
 * 判定ロジック（`gitBlobSha1Hex` / `expectedHashOfTreeEntry` / `compareFingerprints` /
 * `formatFingerprintReport`）は `scripts/check-local-embedding-fingerprint-lib.mjs`
 * にある——ファイル I/O・ネットワークを持たない純関数の側であり、ここ（CLI）は
 * それを呼ぶだけの薄い層である（`scripts/ci-green-check.mjs` と同じ分担）。
 *
 * ## 判定表（この CLI はゲートである）
 *
 * ⭐ **問いは2つに割れている**（Issue #586 / ADR 0253 追記1）——
 * **(1) 宣言が指す先が在るか**（{@link checkDeclaredRepoExists}）と
 * **(2) その中身を読めたか**（{@link fetchTreeWithRetry} 以降）。
 *
 * | # | 事象 | 判定 | exit |
 * |---|---|---|---|
 * | — | 宣言された repo（`DEFAULT_LOCAL_EMBEDDING_REPO`）を読み取れない | 赤 | `1` |
 * | — | `cacheDir` が引けない（`--cache-dir` も env も無い） | 赤 | `1` |
 * | **(1)** | 🔴 **宣言された repo が存在しない（モデル情報 API が再試行3回とも 404）** | **赤** | **`1`** |
 * | **(1)** | モデル情報 API が 404 以外の非2xx／到達しない ⟹ **「在るか」に答えない。(2) へ続行** | — | — |
 * | (2) | 全ファイル一致 | match | `0` |
 * | (2) | ハッシュが食い違う | 赤 | `1` |
 * | (2) | 手元に在るが HF の tree に無いファイルが在る | 赤 | `1` |
 * | (2) | 手元のファイルが読めない（I/O エラー） | 赤 | `1` |
 * | (2) | `<cacheDir>/<repo>/` にファイルが1本も無い | 赤 | `1` |
 * | (2) | tree API に届かない（再試行3回を尽くしてもネットワーク失敗） | 保留 | `2` |
 * | (2) | 🔴 **tree API が非2xx（404 を含む）を返す** | **保留** | **`2`** |
 * | (2) | 🔴 **tree API が 200 を返したが、応答が配列でない** | **保留** | **`2`** |
 * | (2) | 🔴 **tree のエントリから hash を取れない（`oid` も `lfs.oid` も無い）** | **判定は変えない。⚠ 理由を必ず印字** | — |
 * | (2) | 🔴 **tree のエントリが file でも directory でもない（type/path が想定と違う）** | **判定は変えない。⚠ 理由を必ず印字** | — |
 * | — | この CLI 自身のバグ・想定外の例外・不明な引数 | 実行時エラー | `3` |
 *
 * 🔴 **tree API の非2xx／応答が配列でない の2行は、2026-09-21 まで判定表に行が
 * 無かった**（Issue #586 発見1）。**実装は最初からそう倒れていたのに、表がそれを
 * 書いていなかった。** ⟹ **表が実装の射程を覆っていなかったのであって、実装が
 * 勝手に振る舞っていたのではない。**
 *
 * ## ⚠ 「判定は変えない。理由を必ず印字」の2行について（Issue #586 発見2）
 *
 * **これらは exit コードを持たない。** {@link buildExpectedByPath} が読み飛ばすので、
 * **対応する手元のファイルが在れば `unknownOnDisk`（素性不明）として赤になり、
 * 無ければ判定は動かない。** ⟹ **結果として fail-safe である（黙って緑にならない）。**
 *
 * 🔴 **だが 2026-09-21 まで、読み飛ばしたこと自体がどこにも出ていなかった。** 出るのは
 * 「素性不明（HF の tree に無い）」だけで、**読んだ人は「キャッシュが汚れた」と読む——
 * 真因（HF の応答の形が変わった）に辿り着けない。** ⟹ {@link formatSkippedTreeEntries}
 * が件数と理由を必ず印字するようにした。⛔ **判定は1つも変えていない。変えたのは診断だけ。**
 *
 * ⭐ **なぜ「全件読み飛ばし」を保留にしないか**: 保留は「HF に届かない／tree を読めない」
 * に取ってある。**配列は届いていて、中身も数えられている**——読めなかったのではなく、
 * **知っている形と違った**のである。⟹ そこを保留に倒すと、#586 が名指しした
 * 「黙って緑に近い状態で通る」を、別の入口から作り直すことになる。**赤のままにする。**
 *
 * ## ⭐ 保留（exit 2）に倒してよいものの境界
 *
 * **「この repo が直せないもの」だけである。** ⟹ **(2) の失敗はすべて保留でよい**
 * ——tree が読めないのは HF 側の事情であり、偽陽性率に上限を置けない。
 *
 * 🔴 **だが「宣言された repo 名が何も指していない」は、この repo が直せる。**
 * ⟹ **それだけを (1) として切り出し、赤にした。** ⛔ **(1) に 429 や 5xx を
 * 混ぜないこと**——それらは「在るか」に答えていないので、赤の根拠にならない。
 *
 * ⚠ **なぜ (2) の 404 は保留のままか**: (1) を通った時点で「repo は在る」ので、
 * tree だけが 404 を返すのは HF 側の事情（API の形の変更等）である。⟹ 外部要因。
 *
 * **それ以外（`cacheDir`／repo 宣言／ファイルの不在）はすべて赤**——CI に置くこの門は、
 * モデルのキャッシュ鍵が存在する（＝置き場所が決まっている）ことを前提にしており、
 * それらは「判定を保留する」話ではなく「**設定が壊れている**」話だからである。
 *
 * ⛔ **ハッシュの選び分けはファイル名や拡張子で分岐しない。** HF API の応答に
 * `lfs` が在るかどうかだけで分岐する（`expectedHashOfTreeEntry` の戻り値の
 * `algorithm`）——CLI 自身が拡張子等から独自に判断すると、焼き込んだ期待値と
 * 同じ理由で腐る。
 *
 * ## キャッシュの場所
 *
 * `--cache-dir <path>` → 無ければ環境変数 `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` →
 * どちらも無ければ赤（exit 1）。**transformers.js の既定のキャッシュ場所を
 * 推測しない**——推測が外れると「モデルは在るのに検査していない」を
 * 「一致した」と取り違えかねない。
 *
 * ## HF API
 *
 * 既定では `https://huggingface.co/api/models/<repo>/tree/main?recursive=1&expand=1`
 * を `fetch` で引く。失敗したら最大3回まで、2秒間隔で再試行する。それでも
 * 失敗したら保留（exit 2）。
 *
 * ⚠ **`--api-base <url>`（既定 `https://huggingface.co`）で問い合わせ先を差し替えられる。**
 * これは本番の挙動を変えるための入口ではなく、**「HF API に届かない」という exit 2 の
 * 経路を、実際のネットワーク障害を待たずに単体試験・変異試験から再現するための注入点**
 * である（`packages/openai` の `client` 注入と同じ役目）。到達不能な URL を渡せば
 * 到達失敗を、その場で・決定的に再現できる。
 *
 * ## 終了コード（`ci-green-check.mjs` と同じ形の規約）
 *
 * `0` = match（一致）/ `1` = mismatch（不一致。上の判定表の「赤」全部を含む）/
 * `2` = undetermined（判定保留。HF API 取得に失敗した場合のみ）/
 * `3` = 実行時エラー（この CLI 自身のバグ・想定していない例外）。
 *
 * ⚠ **`undetermined` を `match` と取り違えないこと。** `0` 以外はすべて非0で落ちる
 * ——`undetermined` を「まあ緑」として握りつぶす呼び出し側を書かないこと。
 *
 * ## 使い方
 *
 * ```
 * node scripts/check-local-embedding-fingerprint.mjs --cache-dir /path/to/cache
 * node scripts/check-local-embedding-fingerprint.mjs --cache-dir /path/to/cache --json
 * MNEMORA_LOCAL_EMBEDDING_CACHE_DIR=/path/to/cache node scripts/check-local-embedding-fingerprint.mjs
 * node scripts/check-local-embedding-fingerprint.mjs --cache-dir /path/to/cache --api-base http://127.0.0.1:1
 * ```
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
} from "./check-local-embedding-fingerprint-lib.mjs";

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

/** HF の tree API の既定の問い合わせ先。`--api-base` で差し替えない限りこれを使う。 */
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
 * 唯一の出所（`local-embedding-provider.ts` の `DEFAULT_LOCAL_EMBEDDING_REPO`）から
 * 宣言された repo 名を取り出す。⛔ ここにも `ci.yml` にも repo 名を書かない
 * （焼き込み禁止）——だからこの関数が「読めなかった」ときは、フォールバック値を
 * 持たずにそのまま `null` を返す。
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
 * ⭐ **前段: 「宣言が指す先が在るか」だけを問う**（Issue #586、ADR 0253 追記1）。
 *
 * 🔴 **この問いは 404 か否かの2値に留める。⛔ ここに 429 や 5xx を混ぜないこと。**
 *
 * **なぜ分けるか**: 元の形は、tree API から返ったあらゆる非2xx を `fetchTreeWithRetry`
 * が1つの `{ok:false}` に畳み、CLI がそれを**すべて保留（exit 2）**にしていた。
 * ⟹ 判定表が逐語で「保留に倒してよいのは **HF API への到達失敗ただ1つ**である。この
 * **リポジトリの管理が及ばない外部要因**であり（…）」と書いていた論拠が、
 * **404（＝宣言された repo 名が何も指していない。この repo が直せる）を覆っていなかった。**
 *
 * ⟹ **問いを2つに割る。** 「宣言が指す先が在るか」（ここ。404 なら赤）と
 * 「その中身を読めたか」（{@link fetchTreeWithRetry}。失敗は従来どおり保留）。
 * ⭐ **前者には「赤／答えない」の2値しかなく、それ以上分ける先が無い**——だから
 * 再帰しない。⛔ **答えられないときは答えない**（`"undetermined"` を返して続行する）
 * ——ここで黙って赤にすると、外部要因を内部起因として扱うことになる。
 *
 * 🔴 **404 は再試行して確かめる。** 404 を1回で赤にすると、HF の一過性の不調が
 * **必須ジョブを止める**。⟹ {@link RETRY_ATTEMPTS} 回すべてが 404 のときだけ
 * `"missing"` を名乗る。⭐ **正常系（200）では追加の HTTP 往復はちょうど1回である**
 * ——200 を見た時点で即座に返すので、再試行の待ち時間は発生しない。
 *
 * ⛔ **429 / 5xx / 到達失敗は `"undetermined"` である。** それらは「在るか」に
 * 答えていない。⟹ 続行して、tree 側の判定（保留）に委ねる。
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
      // 到達していない ⟹ 「在るか」に答えていない。
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
 * `sleep` を挟んでの再試行付き `fetch`。**HF の tree API が読めなければ`
 * undetermined` に落とす**——この関数はネットワーク I/O を持つため
 * `check-local-embedding-fingerprint-lib.mjs`（純関数だけの側）には置いていない。
 *
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
 * HF の tree エントリの配列から `path -> {algorithm, hex}` の Map を作る。
 *
 * 🔴 **読み飛ばしたものを黙って捨てない**（Issue #586 発見2、ADR 0253 追記2）。
 *
 * 以前はここが `if (expected)` で **oid を取れないエントリを無言で落としていた。**
 * ⟹ HF が `oid` / `lfs.oid` の返し方を変えると、そのエントリが期待値から消え、
 * 対応する手元のファイルが `unknownOnDisk`（素性不明）として**赤**になる。
 * ⭕ **赤になること自体は正しい**（fail-safe。黙って緑にはならない）。
 * 🔴 **だが出る文面が「素性不明（HF の tree に無い）」だったので、読んだ人は
 * 「キャッシュが汚れた」と読む——真因（HF の応答の形が変わった）に辿り着けない。**
 *
 * ⟹ **読み飛ばした件数と理由を持ち回り、呼び出し側が文面に出す。**
 * ⛔ **判定（verdict）は変えていない**——変えるのは診断だけである。
 *
 * ⚠ **`type: "directory"` は正常なので数えない。** 数えるのは次の2つだけ:
 *
 * - `noOid`: `type: "file"` で `path` も在るのに、`oid` も `lfs.oid` も取れない
 *   （{@link expectedHashOfTreeEntry} が `null` を返す）。**HF が hash の返し方を
 *   変えた**ときにここが増える。
 * - `unrecognized`: オブジェクトではあるが、file でも directory でもない／`path` が
 *   無い。**HF がフィールド名そのものを変えた**ときにここが増える。
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
      // 正常。tree にはディレクトリも並ぶ。
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
 * 読み飛ばしたエントリを、人が真因に辿り着ける文面にする。読み飛ばしが無ければ空配列。
 *
 * ⭐ **緑のときにも出す。** 「手元に対応するファイルが無かったので赤にならなかった」
 * だけかもしれず、**そのときこそ黙ってはいけない**（形の変化の予兆である）。
 *
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
 * `repoDir` 以下に実在するファイルを再帰的に列挙し、`expectedByPath` の情報を使って
 * それぞれの hash を計算する。**`expectedByPath` に無い path（素性不明のファイル）も
 * 列挙は続ける**——`compareFingerprints` が `unknownOnDisk` として拾うのはここで
 * 挙げたものだけなので、ここで除外すると門として機能しなくなる。
 * その場合の algorithm は `git-blob-sha1` を既定にする（`compareFingerprints` は
 * `expectedByPath` に無い path の hex/algorithm を実際には比較しないので、
 * この既定値が判定結果を左右することはない）。
 *
 * 🔴 **1本でも読めなければ、それは「片方のハッシュしか計算できない」＝赤（判定表）
 * である。** ここで例外を投げて `main()` の `catch` に落とし exit 3（実行時
 * エラー）にしてしまうと、「この CLI 自身のバグ」と「対象ファイルが読めない」が
 * 区別できなくなる——読めなかった path を `unreadable` として返し、呼び出し側
 * （`main()`）が判定表どおり赤（exit 1）にする。
 *
 * @param {string} repoDir
 * @param {Map<string, { algorithm: string, hex: string }>} expectedByPath
 * @returns {{ actual: { path: string, algorithm: string, hex: string }[], unreadable: { path: string, reason: string }[] }}
 */
function collectActualFiles(repoDir, expectedByPath) {
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
    // HF の path は常に `/` 区切り——Windows でも一致させるため sep を置換する。
    const relPath = relative(repoDir, absPath).split(sep).join("/");
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

/** 判定表の「赤」（不一致）に落として exit 1 で終える。 */
function red(reason) {
  console.error(`赤（mismatch）: ${reason}`);
  process.exit(1);
}

/** 判定表の「保留」（HF API 到達失敗のみ）に落として exit 2 で終える。 */
function undetermined(reason) {
  console.error(`保留（undetermined）: ${reason}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 🔴 判定表: 宣言を読み取れない ⟹ 赤（保留にしない）。
  const repo = readDeclaredRepo();
  if (!repo) {
    red(
      "packages/local-embedding/src/local-embedding-provider.ts から " +
        "DEFAULT_LOCAL_EMBEDDING_REPO を取り出せなかった（宣言の唯一の出所が読めない）。",
    );
    return;
  }

  // 🔴 判定表: cacheDir が引けない ⟹ 赤（保留にしない）。この門は CI 専用であり、
  // CI ではキャッシュ鍵が存在する＝置き場所が決まっていることが前提だからである。
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

  // 🔴 判定表（前段）: 宣言された repo が存在しない ⟹ 赤。⛔ 保留にしない。
  // ⭐ この段が答えるのは「在るか」だけである。答えられないときは続行する。
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
    // ⭐ 判定表で唯一「保留」にしてよい事象——このリポジトリの管理が及ばない
    // 外部要因（ネットワーク）であり、偽陽性率に上限を置けないため。
    undetermined(
      `Hugging Face の tree API を ${RETRY_ATTEMPTS} 回試したが取得できなかった` +
        `（${treeUrl}）。最後の失敗理由: ${treeResult.reason}`,
    );
    return;
  }

  const { map: expectedByPath, ...skipped } = buildExpectedByPath(treeResult.entries);
  // 🔴 読み飛ばしは、緑でも赤でも必ず出す（Issue #586 発見2）。⛔ 判定は変えない。
  for (const line of formatSkippedTreeEntries(skipped)) {
    console.error(line);
  }
  const repoDir = join(cacheDir, repo);
  const { actual, unreadable } = collectActualFiles(repoDir, expectedByPath);

  const result = compareFingerprints({ actual, expectedByPath });
  console.log(formatFingerprintReport(result));

  // 🔴 判定表: 手元のファイルが読めない ⟹ 赤。`compareFingerprints` は読めた分だけを
  // 見て match を返しうるが、読めなかったファイルがある時点で「全ファイル一致」は
  // 主張できないので、ここで上書きする。
  if (unreadable.length > 0) {
    console.error(`読めなかったファイル ${unreadable.length} 本:`);
    for (const item of unreadable) {
      console.error(`  ${item.path}: ${item.reason}`);
    }
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        { repo, cacheDir, repoDir, apiBase, unreadable, skippedTreeEntries: skipped, ...result },
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
