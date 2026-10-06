import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankOutWorkflowComments } from "../workflow-comment-blank-lib.mjs";
import { runNodeScript } from "./spawn-with-deadline.mjs";
import {
  buildCacheKeySuffix,
  CACHE_LAYOUT_TAG,
  slugForCacheKey,
} from "../print-local-embedding-cache-key-lib.mjs";

/**
 * `scripts/print-local-embedding-cache-key.mjs`（CI のモデルキャッシュ鍵を決める CLI）と、
 * `.github/workflows/ci.yml` 側の配線の歯（Issue #564 / ADR 0263、Issue #597 案(a) による
 * ADR 0263 追記）。
 *
 * ⭐ **鍵そのものを assert する。** 鍵は「何が変われば取り直すか」を決めている値であり、
 * **そこが静かにずれると、CI は古い重みを配り続けても緑のまま**になる——それが
 * Issue #564 の本題だった。⟹ **値の形を歯で固定する。**
 *
 * 🔴 **2026-09-24 追記（Issue #597 案(a)）**: revision はもう Hugging Face の `main` から
 * 引かない——`scripts/local-embedding-pinned-revision.json`（唯一の宣言）に固定した sha を
 * 使う。⟹ **この CLI はもう Hugging Face に問い合わせない。** 以前あった `--api-base`
 * （HF スタブへ向ける注入点）は無くなった——**「不明な引数」になること自体が、
 * 旧い（HF に問い合わせる）形へ戻っていないことの歯である。**
 *
 * ⭐ **フォールバックの文面も assert する。** 宣言（repo/dtype/固定revision）を読めない
 * ときにジョブを落とさない設計なので、**出るのは `::warning::` の文面だけ**である。
 * ⟹ そこが消えたら、「宣言を読めなかった」ことが誰にも届かなくなる。
 *
 * ⚠ **固定 revision の宣言ファイルの場所は `--declaration-path` で差し替えられる**
 * ——本物の `scripts/local-embedding-pinned-revision.json` を書き換えずに
 * 「宣言が読めない」を歯から再現するため（`packages/openai` の `client` 注入と同じ役目）。
 */

const script = fileURLToPath(new URL("../print-local-embedding-cache-key.mjs", import.meta.url));
const workflow = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const providerSource = fileURLToPath(
  new URL("../../packages/local-embedding/src/local-embedding-provider.ts", import.meta.url),
);
const pinnedRevisionDeclaration = fileURLToPath(
  new URL("../local-embedding-pinned-revision.json", import.meta.url),
);

/** 宣言を、CLI とは別のやり方（行を探して引用符の中を取る）で読む。 */
function declaredIndependently(name) {
  const line = readFileSync(providerSource, "utf8")
    .split("\n")
    .find((l) => l.includes(`export const ${name}`));
  if (!line) throw new Error(`宣言の行が見つからない: ${name}`);
  return line.split('"')[1];
}

/**
 * 固定 revision の宣言を、CLI（`readPinnedRevision`）とは別のやり方
 * （`JSON.parse` を直接呼ぶだけ）で読む。**両者が同じ値を見ていることの独立した証人。**
 */
function pinnedRevisionIndependently() {
  const parsed = JSON.parse(readFileSync(pinnedRevisionDeclaration, "utf8"));
  if (typeof parsed?.sha !== "string" || parsed.sha.length === 0) {
    throw new Error(`${pinnedRevisionDeclaration} に sha が無い`);
  }
  return parsed.sha;
}

const repo = declaredIndependently("DEFAULT_LOCAL_EMBEDDING_REPO");
const dtype = declaredIndependently("DEFAULT_LOCAL_EMBEDDING_DTYPE");
const pinnedSha = pinnedRevisionIndependently();

/**
 * 🔴 **revision を入れる前に `ci.yml` が持っていた鍵。**
 * 宣言（repo/dtype/固定revision）のどれかが読めなかったときの落ち先が、`ci.yml` の
 * 接頭辞と繋いでこれと一致することを下で確かめる——一致していないと、**宣言が
 * 壊れている間に温かいキャッシュを外して 4ファイル計42MB のモデル一式を取りに行かせる**
 * ことになる。
 */
const KEY_BEFORE_THIS_CHANGE = "local-embedding-ruri-v3-30m-q8-v1";

/** `ci.yml` 側がリテラルで持つ接頭辞（下の「配線」の `describe` が現物と突き合わせる）。 */
const PREFIX_IN_WORKFLOW = "local-embedding-";

/**
 * CLI を子として起こして待つ。子が期限（`spawn-with-deadline.mjs` の既定 30 秒）までに close しなければ、
 * 子を kill して「N 秒で close しなかった」と落ちる（2026-09-28、負荷の下で子の node が止まり、この歯が
 * testTimeout まで待っていた件。原因は断定していない）。
 */
async function runCli(args) {
  const { code, stdout, stderr } = await runNodeScript(script, args);
  return { code, stdout: stdout.trim(), stderr };
}

/** `--declaration-path` を、一時ディレクトリに書いた壊れた/正しい宣言へ向けて走らせる。 */
async function withDeclarationFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "local-embedding-pinned-revision-"));
  const path = join(dir, "local-embedding-pinned-revision.json");
  if (content !== null) {
    writeFileSync(path, content);
  }
  try {
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("print-local-embedding-cache-key.mjs: 鍵の接尾辞の組み立て（純関数）", () => {
  it("repo / dtype / sha と、中身の形の版（CACHE_LAYOUT_TAG）が全部入る", () => {
    expect(buildCacheKeySuffix({ repo: "owner/model", dtype: "q8", sha: "abc123" })).toBe(
      `owner-model-q8-abc123-${CACHE_LAYOUT_TAG}`,
    );
  });

  it("⚠ 中身の形の版は、revision ごとの根（<根>/<revision>/<repo>/<file>）で保存し直した版である（Issue #1004・#1403）", () => {
    // 版を戻すと、古い形（<repo>/<file>、または <repo>/<revision>/<file>）で保存されたキャッシュが、また当たる。
    expect(CACHE_LAYOUT_TAG).toBe("revision-root-2");
  });

  it("🔴 接頭辞を持たない（ci.yml 側のリテラルと二重にならない）", () => {
    expect(buildCacheKeySuffix({ repo: "o/m", dtype: "q8", sha: "s" })).not.toContain(
      PREFIX_IN_WORKFLOW,
    );
  });

  it("鍵に使えない文字は `-` に均される", () => {
    expect(slugForCacheKey("a/b c:d")).toBe("a-b-c-d");
  });

  it("⚠ 陰性対照: sha が違えば鍵も違う（これが成り立たないと取り直しが起きない）", () => {
    const a = buildCacheKeySuffix({ repo: "o/m", dtype: "q8", sha: "1111" });
    const b = buildCacheKeySuffix({ repo: "o/m", dtype: "q8", sha: "2222" });
    expect(a).not.toBe(b);
  });

  it("⚠ 陰性対照: dtype が違えば鍵も違う", () => {
    expect(buildCacheKeySuffix({ repo: "o/m", dtype: "q8", sha: "s" })).not.toBe(
      buildCacheKeySuffix({ repo: "o/m", dtype: "fp32", sha: "s" }),
    );
  });
});

describe("print-local-embedding-cache-key.mjs: CLI", () => {
  it("⭐ 固定した revision の宣言から組み立てた鍵を印字する（Issue #597 案(a)）", async () => {
    const r = await runCli(["--plain"]);
    expect(r.stdout).toBe(buildCacheKeySuffix({ repo, dtype, sha: pinnedSha }));
    expect(r.code).toBe(0);
  });

  it("既定では $GITHUB_OUTPUT の行形式（key=…）で出す", async () => {
    const r = await runCli([]);
    expect(r.stdout).toBe(`key=${buildCacheKeySuffix({ repo, dtype, sha: pinnedSha })}`);
    expect(r.code).toBe(0);
  });

  it(
    "🔴 --api-base は不明な引数である —— Hugging Face に問い合わせる旧い形へ戻って" +
      "いないことの歯（旧い形なら --api-base は既知の引数になる）",
    async () => {
      const r = await runCli(["--api-base", "http://127.0.0.1:1", "--plain"]);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("不明な引数: --api-base");
    },
  );

  it(
    "🔴 固定 revision の宣言が読めなければ、**revision を入れる前の鍵**へ落ちる。" +
      "⛔ ジョブを落とさない（exit 0）",
    async () => {
      await withDeclarationFile(null, async (path) => {
        const r = await runCli(["--declaration-path", path, "--plain"]);
        // 🔴 ここが一致していないと、宣言が壊れている間に温かいキャッシュを外すことになる。
        expect(PREFIX_IN_WORKFLOW + r.stdout).toBe(KEY_BEFORE_THIS_CHANGE);
        expect(r.code).toBe(0);
      });
    },
  );

  it("⭐ 落ちるときは黙らない: ::warning:: に理由を書く（宣言が読めない場合）", async () => {
    await withDeclarationFile(null, async (path) => {
      const r = await runCli(["--declaration-path", path, "--plain"]);
      expect(r.stderr).toContain("::warning::キャッシュ鍵:");
      expect(r.stderr).toContain("固定した revision の宣言");
      expect(r.stderr).toContain(path);
    });
  });

  it("JSON が壊れていても、落ちずにフォールバックする", async () => {
    await withDeclarationFile("{ not valid json", async (path) => {
      const r = await runCli(["--declaration-path", path, "--plain"]);
      expect(PREFIX_IN_WORKFLOW + r.stdout).toBe(KEY_BEFORE_THIS_CHANGE);
      expect(r.code).toBe(0);
    });
  });

  it("sha が無い（別の形の JSON）ときも、落ちずにフォールバックする", async () => {
    await withDeclarationFile(JSON.stringify({ notSha: "x" }), async (path) => {
      const r = await runCli(["--declaration-path", path, "--plain"]);
      expect(PREFIX_IN_WORKFLOW + r.stdout).toBe(KEY_BEFORE_THIS_CHANGE);
      expect(r.code).toBe(0);
    });
  });

  // Issue #1784（#595 の確かめ直し）: 空文字の sha も「読めない」と同じく、警告してフォールバックする。
  // `sha.length > 0` を外しても以前の歯は赤にならず、revision の欠けた鍵が警告なしで出ていた【実測】。
  it("sha が空文字のときも、警告してフォールバックする（revision の欠けた鍵を黙って作らない）", async () => {
    await withDeclarationFile(JSON.stringify({ sha: "" }), async (path) => {
      const r = await runCli(["--declaration-path", path, "--plain"]);
      expect(PREFIX_IN_WORKFLOW + r.stdout).toBe(KEY_BEFORE_THIS_CHANGE);
      expect(r.stderr).toContain("::warning::");
      expect(r.code).toBe(0);
    });
  });

  // Issue #1784（#595 の確かめ直し）。以下4本は、以前の歯がどれも赤にならなかった変異を塞ぐ【実測】。

  it("⭐ 宣言が揃っているときは、警告を出さない（揃っているのにフォールバックの警告を出す変異を塞ぐ）", async () => {
    const r = await runCli(["--plain"]);
    expect(r.stderr).not.toContain("::warning::");
    expect(r.stdout).toBe(buildCacheKeySuffix({ repo, dtype, sha: pinnedSha }));
    expect(r.code).toBe(0);
  });

  it.each([
    ["配列", JSON.stringify({ sha: ["abc"] })],
    ["数", JSON.stringify({ sha: 123 })],
    ["オブジェクト", JSON.stringify({ sha: { length: 5 } })],
  ])("sha が文字列でない（%s）ときも、落ちずに警告してフォールバックする", async (_label, content) => {
    await withDeclarationFile(content, async (path) => {
      const r = await runCli(["--declaration-path", path, "--plain"]);
      expect(PREFIX_IN_WORKFLOW + r.stdout).toBe(KEY_BEFORE_THIS_CHANGE);
      expect(r.stderr).toContain("::warning::");
      expect(r.code).toBe(0);
    });
  });

  // repo / dtype の宣言（local-embedding-provider.ts）は、CLI が自分の位置から相対で読む。壊さずに
  // 「片方だけ読めない」を作るため、CLI とその lib を一時の木へ写し、宣言の側だけを差し替える。
  it.each([
    ["repo だけ", 'export const DEFAULT_LOCAL_EMBEDDING_REPO = "org/model";\n'],
    ["dtype だけ", 'export const DEFAULT_LOCAL_EMBEDDING_DTYPE = "q8";\n'],
    ["どちらも無い", "export const OTHER = 1;\n"],
    ["宣言のファイルが無い", null],
  ])("宣言（%s）しか読めないときは、警告してフォールバックする（exit 0）", async (_label, provider) => {
    const root = mkdtempSync(join(tmpdir(), "local-embedding-cache-key-tree-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      copyFileSync(script, join(root, "scripts", "print-local-embedding-cache-key.mjs"));
      copyFileSync(
        fileURLToPath(new URL("../print-local-embedding-cache-key-lib.mjs", import.meta.url)),
        join(root, "scripts", "print-local-embedding-cache-key-lib.mjs"),
      );
      if (provider !== null) {
        const dir = join(root, "packages", "local-embedding", "src");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "local-embedding-provider.ts"), provider);
      }
      const { code, stdout, stderr } = await runNodeScript(
        join(root, "scripts", "print-local-embedding-cache-key.mjs"),
        ["--plain"],
      );
      expect(PREFIX_IN_WORKFLOW + stdout.trim()).toBe(KEY_BEFORE_THIS_CHANGE);
      expect(stderr).toContain("::warning::キャッシュ鍵: 宣言（DEFAULT_LOCAL_EMBEDDING_REPO");
      expect(code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("⭐ ネットワークへ出ない（fetch も socket の connect も呼ばない。Issue #597 案(a)）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-embedding-cache-key-net-"));
    try {
      const mark = join(dir, "mark.txt");
      // fetch と net.Socket#connect を、呼ばれたら印を残す偽物に差し替える（子へ NODE_OPTIONS=--import で渡す）。
      const preload = join(dir, "preload.mjs");
      writeFileSync(
        preload,
        [
          'import { appendFileSync } from "node:fs";',
          'import net from "node:net";',
          'globalThis.fetch = () => { appendFileSync(process.env.NET_MARK, "fetch\\n"); return Promise.reject(new Error("blocked")); };',
          "const connect = net.Socket.prototype.connect;",
          'net.Socket.prototype.connect = function (...a) { appendFileSync(process.env.NET_MARK, "connect\\n"); return connect.apply(this, a); };',
          "",
        ].join("\n"),
      );
      const env = { ...process.env, NET_MARK: mark, NODE_OPTIONS: `--import ${preload}` };

      // ⚠ 陰性対照: 同じ差し替えの下で fetch を呼ぶ子は、印を残す（差し替えが効いていなければ下の主張は空回りする）。
      const control = join(dir, "control.mjs");
      writeFileSync(control, 'fetch("http://127.0.0.1:1/").catch(() => {});\n');
      await runNodeScript(control, [], { env });
      expect(readFileSync(mark, "utf8")).toContain("fetch");
      writeFileSync(mark, "");

      const r = await runNodeScript(script, ["--plain"], { env });
      expect(r.stdout.trim()).toBe(buildCacheKeySuffix({ repo, dtype, sha: pinnedSha }));
      expect(r.code).toBe(0);
      expect(readFileSync(mark, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不明な引数 ⟹ 実行時エラー（exit 3）", async () => {
    const r = await runCli(["--nope"]);
    expect(r.stderr).toContain("不明な引数: --nope");
    expect(r.code).toBe(3);
  });
});

describe("ci.yml の配線（Issue #564）", () => {
  const yml = readFileSync(workflow, "utf8");
  const keyLines = () =>
    yml.split("\n").filter((l) => /^\s+key:\s/.test(l) && l.includes("local-embedding"));

  it("🔴 手で版を振った固定の鍵（式を含まない literal）が、どの cache 段にも残っていない", () => {
    const stale = keyLines().filter((l) => !l.includes("${{"));
    expect(stale).toEqual([]);
  });

  it("⭐ local-embedding の cache 段はすべて、鍵をこの CLI の出力から取る", () => {
    expect(keyLines().length).toBeGreaterThanOrEqual(2); // 空回り防止の下限
    for (const line of keyLines()) {
      expect(line).toContain("steps.local-embedding-cache-key.outputs.key");
    }
  });

  it("鍵を決める段の数と、cache 段の数が一致する（対が崩れていない）", () => {
    const decide = (yml.match(/id: local-embedding-cache-key/g) ?? []).length;
    const use = (yml.match(/steps\.local-embedding-cache-key\.outputs\.key/g) ?? []).length;
    expect(decide).toBe(use);
    expect(decide).toBeGreaterThanOrEqual(2);
  });

  it("鍵を決める段は、この CLI を起動している", () => {
    expect(yml).toContain("node scripts/print-local-embedding-cache-key.mjs");
  });

  // ⭐ 以下3本は、**既存の歯が cache 段を見分けるのに使っている手がかり**を固定する。
  // 🔴 この変更を書く過程で、3つとも実際に壊して既存の歯を落とした。⟹ 契約として残す。

  it("⭐ 接頭辞 `local-embedding-` は yml のリテラルとして残っている", () => {
    // 🔴 `ci-yml-local-embedding-cache-wiring.test.mjs` が逐語で「cache 段は `key:` が
    // `local-embedding` で始まることで見分ける。⛔ `path:` では見分けない」と宣言して
    // いる。⟹ 接頭辞を式の中へ入れると、あちらが段を見つけられなくなる。
    for (const line of keyLines()) {
      expect(line).toMatch(/key:\s*local-embedding-/);
    }
  });

  it("⭐ 鍵の値に空白を入れない（既存の歯が `key:` を `(\\S+)` で取り出すため）", () => {
    // 🔴 `ci-yml-association-wiring.test.mjs` が /^\s*key:\s*(\S+)/ で鍵を取る。
    // ⟹ `${{ x }}` のように内側へ空白を入れると値が途中で切れ、identifier-probes
    // との共有の検査が壊れる。
    for (const line of keyLines()) {
      expect(line.trim().replace(/^key:\s*/, "")).not.toContain(" ");
    }
  });

  it("⭐ 鍵を決める段の名前に「キャッシュ」を入れない（既存の歯が step 名で cache 段を探すため）", () => {
    // 🔴 `ci-yml-association-wiring.test.mjs` は
    // `steps.find((step) => step.name.includes("キャッシュ"))` で cache 段を探す。
    // ⟹ その手前に「キャッシュ」を含む段を置くと、そちらが先に当たって壊れる。
    const decideStepNames = yml.split("\n").filter((l) => /^\s+- name:.*cache 鍵/.test(l));
    expect(decideStepNames.length).toBeGreaterThanOrEqual(2);
    for (const line of decideStepNames) {
      expect(line).not.toContain("キャッシュ");
    }
  });

  it("⚠ 陰性対照: 架空のステップ id では見つからない（検査が常に true に退化していない）", () => {
    expect(yml).not.toContain("steps.no-such-cache-key-step.outputs.key");
  });
});

/**
 * Issue #1784（#595 の確かめ直し）: 上の「ci.yml の配線」は、文字列が yml のどこかに在ることと、
 * 個数が合うことしか見ていない。**「鍵を CLI の出力から取る」という約束を別の書き方で外す変異は、
 * 次のものがすべて素通りした【実測】**（どの歯も赤にならなかった）:
 * - 鍵を決める段の `run:` を、手書きの鍵を出す `echo "key=…"` に置き換える（1か所）
 * - 鍵を決める段から `>> "$GITHUB_OUTPUT"` を外す／`if: false` を付ける／`id` を改名する（1か所）
 * - 鍵を決める段を cache 段の後ろへ動かす（出力が空のまま鍵が作られる）
 * - `outputs.key` を `outputs.keyx` にする（全部。部分一致の `toContain` が通る）
 * - 鍵の末尾に `-${{github.run_id}}` を足す（全部。毎回当たらず、cache が実質外れる）
 * - cache 段に `restore-keys:` を足す（鍵が外れたとき、前の revision の重みを復元して
 *   新しい鍵で保存し直す。revision を鍵に入れた意味がなくなる）
 *
 * ⭐ そこで、**ジョブごとに段を切り出して、段の形を逐語で固定する。** コメントは潰してから見る
 * （地の文が `id:` や `key:` を引用していても数えない）。YAML は構造として解析していない
 * （依存追加はオーナー専権。既存の wiring 歯と同じ判断）。
 */
describe("ci.yml の配線: 鍵を決める段と cache 段の形（Issue #1784）", () => {
  const { text, unhandled } = blankOutWorkflowComments(readFileSync(workflow, "utf8"));
  const lines = text.split("\n");

  /** @type {{ job: string, steps: string[] }[]} */
  const jobs = [];
  let inJobs = false;
  for (const line of lines) {
    if (line === "jobs:") {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const jobHead = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobHead) {
      jobs.push({ job: jobHead[1], steps: [] });
      continue;
    }
    if (jobs.length === 0) continue;
    const current = jobs[jobs.length - 1];
    if (/^ {6}- /.test(line)) {
      current.steps.push(line);
    } else if (current.steps.length > 0) {
      current.steps[current.steps.length - 1] += `\n${line}`;
    }
  }

  const DECIDE_RUN = '        run: node scripts/print-local-embedding-cache-key.mjs >> "$GITHUB_OUTPUT"';
  const CACHE_KEY = "          key: local-embedding-${{steps.local-embedding-cache-key.outputs.key}}";
  const isDecide = (step) => /^ {8}id: local-embedding-cache-key$/m.test(step);
  const isCache = (step) => /^ {10}key:\s*local-embedding/m.test(step);
  const hasStepLevel = (step, key) => new RegExp(`^ {8}["']?${key}["']?\\s*:`, "m").test(step);

  const jobsWithCache = jobs.filter((j) => j.steps.some(isCache));

  it("🔴 コメント潰しが「扱えない」形に当たっていない", () => {
    expect(unhandled).toEqual([]);
  });

  it("⚠ cache 段を持つジョブが2つ以上見つかる（空回り防止の下限。本数は焼き込まない）", () => {
    expect(jobsWithCache.length).toBeGreaterThanOrEqual(2);
  });

  it("⭐ cache 段を持つジョブは、鍵を決める段をちょうど1つ、cache 段より前に持つ", () => {
    for (const { job, steps } of jobsWithCache) {
      const decideAt = steps.map((s, i) => (isDecide(s) ? i : -1)).filter((i) => i >= 0);
      const cacheAt = steps.map((s, i) => (isCache(s) ? i : -1)).filter((i) => i >= 0);
      expect(decideAt, `${job}: 鍵を決める段（id: local-embedding-cache-key）の位置`).toHaveLength(1);
      for (const at of cacheAt) {
        expect(decideAt[0], `${job}: 鍵を決める段が cache 段より後ろにある`).toBeLessThan(at);
      }
    }
  });

  it("⭐ 鍵を決める段の run: は、この CLI の出力を $GITHUB_OUTPUT へ流す1行そのもの", () => {
    for (const { job, steps } of jobsWithCache) {
      for (const step of steps.filter(isDecide)) {
        expect(step.split("\n"), `${job}: run: の行`).toContain(DECIDE_RUN);
        // 手書きの鍵を出す別の run: が同居していない（run: は1つだけ）。
        expect(step.match(/^ {8}run:/gm) ?? [], `${job}: run: の数`).toHaveLength(1);
      }
    }
  });

  it("⛔ 鍵を決める段・cache 段は、`if:` も `continue-on-error` も持たない（走らなくする書き方を許さない）", () => {
    for (const { job, steps } of jobsWithCache) {
      for (const step of steps.filter((s) => isDecide(s) || isCache(s))) {
        expect(hasStepLevel(step, "if"), `${job}: if:`).toBe(false);
        expect(hasStepLevel(step, "continue-on-error"), `${job}: continue-on-error:`).toBe(false);
      }
    }
  });

  it("⭐ cache 段の key: は、接頭辞＋CLI の出力だけの1行そのもの。restore-keys も無い", () => {
    for (const { job, steps } of jobsWithCache) {
      for (const step of steps.filter(isCache)) {
        const keyLine = step.split("\n").find((l) => /^ {10}key:/.test(l));
        expect(keyLine, `${job}: key: の行`).toBe(CACHE_KEY);
        // 🔴 restore-keys は、鍵が外れたとき前の revision の重みを復元し、新しい鍵で保存し直す。
        // revision を鍵に入れて取り直させる ADR 0263 の目的と逆向きである。
        expect(step, `${job}: restore-keys`).not.toMatch(/restore-keys/);
        expect(step, `${job}: actions/cache（restore/save の片側だけではない）`).toMatch(
          /^ {8}uses: actions\/cache@/m,
        );
      }
    }
  });
});

describe("固定した revision の宣言（Issue #597 案(a)）", () => {
  it("scripts/local-embedding-pinned-revision.json が sha を持つ", () => {
    expect(pinnedSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
