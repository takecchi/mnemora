import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCacheKeySuffix, slugForCacheKey } from "../print-local-embedding-cache-key-lib.mjs";

/**
 * `scripts/print-local-embedding-cache-key.mjs`（CI のモデルキャッシュ鍵を決める CLI）と、
 * `.github/workflows/ci.yml` 側の配線の歯（Issue #564 / ADR 0263）。
 *
 * ⭐ **鍵そのものを assert する。** 鍵は「何が変われば取り直すか」を決めている値であり、
 * **そこが静かにずれると、CI は古い重みを配り続けても緑のまま**になる——それが
 * Issue #564 の本題だった。⟹ **値の形を歯で固定する。**
 *
 * ⭐ **フォールバックの文面も assert する。** HF に届かないときにジョブを落とさない
 * 設計なので、**出るのは `::warning::` の文面だけ**である。⟹ そこが消えたら、
 * 「revision を入れられなかった」ことが誰にも届かなくなる。
 *
 * ⚠ 測り方は `check-local-embedding-fingerprint-cli.test.mjs` と同じ——CLI が用意して
 * いる `--api-base` の注入点へ**手元の HTTP スタブ**を向ける。⟹ Hugging Face にも
 * 4ファイル計42MB のモデル一式にも触らない。
 */

const script = fileURLToPath(new URL("../print-local-embedding-cache-key.mjs", import.meta.url));
const workflow = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const providerSource = fileURLToPath(
  new URL("../../packages/local-embedding/src/local-embedding-provider.ts", import.meta.url),
);

/** 宣言を、CLI とは別のやり方（行を探して引用符の中を取る）で読む。 */
function declaredIndependently(name) {
  const line = readFileSync(providerSource, "utf8")
    .split("\n")
    .find((l) => l.includes(`export const ${name}`));
  if (!line) throw new Error(`宣言の行が見つからない: ${name}`);
  return line.split('"')[1];
}

const repo = declaredIndependently("DEFAULT_LOCAL_EMBEDDING_REPO");
const dtype = declaredIndependently("DEFAULT_LOCAL_EMBEDDING_DTYPE");

/**
 * 🔴 **revision を入れる前に `ci.yml` が持っていた鍵。**
 * HF に届かなかったときの落ち先が、`ci.yml` の接頭辞と繋いでこれと一致することを
 * 下で確かめる——一致していないと、**HF 障害中に温かいキャッシュを外して
 * 4ファイル計42MB のモデル一式を取りに行かせる**ことになる。
 */
const KEY_BEFORE_THIS_CHANGE = "local-embedding-ruri-v3-30m-q8-v1";

/** `ci.yml` 側がリテラルで持つ接頭辞（下の「配線」の `describe` が現物と突き合わせる）。 */
const PREFIX_IN_WORKFLOW = "local-embedding-";

async function withStub(handler, fn) {
  const state = { hits: 0, paths: [] };
  const server = createServer((req, res) => {
    state.hits += 1;
    state.paths.push(req.url);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn({ origin: `http://127.0.0.1:${server.address().port}`, state });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

const json = (status, body) => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("print-local-embedding-cache-key.mjs: 鍵の接尾辞の組み立て（純関数）", () => {
  it("repo / dtype / sha が全部入る", () => {
    expect(buildCacheKeySuffix({ repo: "owner/model", dtype: "q8", sha: "abc123" })).toBe(
      "owner-model-q8-abc123",
    );
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
  it.concurrent("⭐ HF が sha を返すと、宣言と sha から組み立てた鍵を印字する", async () => {
    await withStub(json(200, { id: repo, sha: "deadbeef" }), async (s) => {
      const r = await runCli(["--api-base", s.origin, "--plain"]);
      expect(r.stdout).toBe(buildCacheKeySuffix({ repo, dtype, sha: "deadbeef" }));
      expect(r.code).toBe(0);
      expect(s.state.paths[0]).toBe(`/api/models/${repo}`);
    });
  });

  it.concurrent("既定では $GITHUB_OUTPUT の行形式（key=…）で出す", async () => {
    await withStub(json(200, { id: repo, sha: "deadbeef" }), async (s) => {
      const r = await runCli(["--api-base", s.origin]);
      expect(r.stdout).toBe(`key=${buildCacheKeySuffix({ repo, dtype, sha: "deadbeef" })}`);
    });
  });

  it.concurrent(
    "🔴 HF に届かないと、**revision を入れる前の鍵**へ落ちる。⛔ ジョブを落とさない（exit 0）",
    async () => {
      const r = await runCli(["--api-base", "http://127.0.0.1:1", "--plain"]);
      // 🔴 ここが一致していないと、HF 障害中に温かいキャッシュを外すことになる。
      expect(PREFIX_IN_WORKFLOW + r.stdout).toBe(KEY_BEFORE_THIS_CHANGE);
      expect(r.code).toBe(0);
    },
  );

  it.concurrent(
    "⭐ 落ちるときは黙らない: ::warning:: に理由と「前と同じ振る舞い」を書く",
    async () => {
      const r = await runCli(["--api-base", "http://127.0.0.1:1", "--plain"]);
      expect(r.stderr).toContain("::warning::キャッシュ鍵:");
      expect(r.stderr).toContain("revision を引けなかった");
      expect(r.stderr).toContain("この変更の前と同じ振る舞いになる");
    },
  );

  it.concurrent(
    "応答に sha が無いときも、落ちずにフォールバックする（HF の形が変わった場合）",
    async () => {
      await withStub(json(200, { id: repo }), async (s) => {
        const r = await runCli(["--api-base", s.origin, "--plain"]);
        expect(PREFIX_IN_WORKFLOW + r.stdout).toBe(KEY_BEFORE_THIS_CHANGE);
        expect(r.stderr).toContain("応答に sha が無かった");
        expect(r.code).toBe(0);
      });
    },
  );

  it.concurrent("404 でも落ちない（鍵を決めるだけで、門ではない）", async () => {
    await withStub(json(404, { error: "no" }), async (s) => {
      const r = await runCli(["--api-base", s.origin, "--plain"]);
      expect(PREFIX_IN_WORKFLOW + r.stdout).toBe(KEY_BEFORE_THIS_CHANGE);
      expect(r.stderr).toContain("HTTP 404");
      expect(r.code).toBe(0);
    });
  });

  it.concurrent("不明な引数 ⟹ 実行時エラー（exit 3）", async () => {
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
