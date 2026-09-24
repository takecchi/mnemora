import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `scripts/check-local-embedding-fingerprint.mjs`（CLI 入口）の歯。
 *
 * 🔴🔴 **この歯は「いまの振る舞い」を固定している。「あるべき姿」ではない。**
 *
 * [Issue #586](https://github.com/takecchi/mnemora/issues/586) が、この CLI の
 * `fetchTreeWithRetry` の分岐について**判定表と実装の射程がずれている**ことを
 * 名指ししている——CLI の docstring の判定表は逐語で
 * 「HF API に届かない（再試行3回を尽くしても**ネットワーク失敗**）| 保留 | `2`」と
 * 書いているが、実装は **HTTP 404 も 5xx も 429 も「200 だが応答が配列でない」も、
 * すべて同じ保留（exit 2）へ倒す。**
 *
 * ⟹ **下の `it` のうち「保留（exit 2）」を期待しているものは、その *ずれたままの
 * 現状* を焼いている。** ⛔ **正しい姿を書いているのではない。**
 *
 * ⭐ **だから Issue #586 の判断が降りたら、この歯は赤くなる。それでよい。**
 * **赤くなったら「壊れた」ではなく「#586 の決定が入った」と読むこと**——そのときは
 * 期待値を**意図して**書き換える（決定を運ぶ PR の中で、その ADR と一緒に）。
 * ⛔ **決定が無いまま、赤いからという理由でここを書き換えないこと。**
 *
 * ## なぜこの歯が要るか
 *
 * 【実測 2026-09-21】この CLI（335行）には単体の歯が1本も無かった。判定ロジックの
 * 純関数側は `check-local-embedding-fingerprint-lib.test.mjs` が13本で守っており、
 * `ci.yml` の配線は `ci-yml-local-embedding-fingerprint-wiring.test.mjs` が8本で
 * 守っているが、**「どの事象がどの exit になるか」を決めている `fetchTreeWithRetry` は、
 * そのどちらの守備範囲にも入っていなかった。** ⟹ Issue #586 のずれは、そこに歯が
 * 無かったから誰にも気づかれなかった。
 *
 * ⚠ **ADR 0253「測ったこと」7 の変異試験 A〜G は、この CLI を端から端まで測っている。**
 * ⛔ **しかしそれは ADR の中の1回の実測であって、回帰を守る歯ではない。** 次に誰かが
 * `fetchTreeWithRetry` を触っても、それでは何も鳴らない。
 *
 * ## 測り方
 *
 * CLI の docstring が `--api-base` を逐語でこう名乗っている——「**到達不能な URL を
 * 渡せば到達失敗を、その場で・決定的に再現できる**」。その注入点へ**手元の HTTP
 * スタブ**を向ける。⟹ Hugging Face にも、4ファイル計42MB のモデル一式にも、一切触らない。
 *
 * ⚠ **`spawnSync` を使わない。** スタブのサーバはこのプロセスの中で動くので、
 * 同期的に子プロセスを待つとイベントループが止まってスタブが応答できない。
 */

const script = fileURLToPath(new URL("../check-local-embedding-fingerprint.mjs", import.meta.url));
const providerSource = fileURLToPath(
  new URL("../../packages/local-embedding/src/local-embedding-provider.ts", import.meta.url),
);
const pinnedRevisionDeclaration = fileURLToPath(
  new URL("../local-embedding-pinned-revision.json", import.meta.url),
);

/**
 * 固定した revision を、CLI（`readPinnedRevisionForCacheLayout`）とは別のやり方
 * （`JSON.parse` を直接呼ぶだけ）で読む。
 */
function pinnedRevisionIndependently() {
  const parsed = JSON.parse(readFileSync(pinnedRevisionDeclaration, "utf8"));
  if (typeof parsed?.sha !== "string" || parsed.sha.length === 0) {
    throw new Error(`${pinnedRevisionDeclaration} に sha が無い`);
  }
  return parsed.sha;
}

/**
 * 宣言された repo 名を、**CLI とは別のやり方で**読む。
 *
 * ⭐ CLI 側は正規表現1本で抜いている。ここでは行を探して引用符の中を取る——
 * **わざと違う読み方にしてある。** 両方が同じ値に着くことを下の `it` が確かめるので、
 * 「CLI の正規表現が壊れた」と「宣言そのものが変わった」を区別できる。
 */
function declaredRepoIndependently() {
  const line = readFileSync(providerSource, "utf8")
    .split("\n")
    .find((l) => l.includes("export const DEFAULT_LOCAL_EMBEDDING_REPO"));
  if (!line) throw new Error("宣言の行が見つからない（この歯の前提が崩れている）");
  const parts = line.split('"');
  if (parts.length < 2) throw new Error(`宣言の行から値を取れない: ${line}`);
  return parts[1];
}

/** git の blob hash。CLI/lib とは独立にここで計算する（歯が被検査体を借りない）。 */
function gitBlobSha1(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const repo = declaredRepoIndependently();
const pinnedRevision = pinnedRevisionIndependently();

/**
 * 手元の HTTP スタブと一時キャッシュを1組だけ用意して `fn` に渡し、**必ず後始末する。**
 *
 * ⚠ **共有の `afterEach` を使わない。** 下の `it` は `concurrent` で走る——失敗系は
 * CLI の再試行（3回・2秒間隔）を待つので、直列にすると1本あたり約4秒かかり、
 * CI の `Test` ステップを無視できない幅で伸ばす【実測 2026-09-21: 直列 26.0s → 並行 8.8s】。
 * 並行にすると `afterEach` は他のテストが使っている最中の資源まで畳みうるので、
 * **後始末はテストごとに `finally` で閉じる。**
 *
 * @param {{ files?: Record<string,string>, respond: (entries: object[], url: string) => { status: number, body: unknown } }} setup
 */
async function withFixture(setup, fn) {
  const state = { hits: 0, paths: [] };
  const cacheDir = mkdtempSync(join(tmpdir(), "mnemora-fp-cli-"));
  const entries = [];
  for (const [relPath, contents] of Object.entries(setup.files ?? {})) {
    const abs = join(cacheDir, repo, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    const bytes = Buffer.from(contents, "utf8");
    writeFileSync(abs, bytes);
    entries.push({ type: "file", path: relPath, oid: gitBlobSha1(bytes) });
  }
  const server = createServer((req, res) => {
    state.hits += 1;
    state.paths.push(req.url);
    const { status, body } = setup.respond(entries, req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    return await fn({ origin, state, cacheDir, entries });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

/** CLI を子プロセスで起動して、終了コードと出力を返す。 */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** HTTP 状態コードと固定の body を返す `respond`。 */
const fixed = (status, body) => () => ({ status, body });

describe("check-local-embedding-fingerprint.mjs（CLI）: 宣言された repo の読み取り", () => {
  it.concurrent(
    "CLI が印字する repo 名が、宣言の唯一の出所（local-embedding-provider.ts）と一致する",
    async () => {
      await withFixture(
        { files: { "config.json": "{}\n" }, respond: fixed(200, []) },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.stdout).toContain(
            `宣言された repo（唯一の出所: local-embedding-provider.ts）: ${repo}`,
          );
        },
      );
    },
  );

  it.concurrent(
    "問い合わせは2段になる: 先に存在確認（モデル情報 API）、次に tree API",
    async () => {
      await withFixture(
        { files: { "config.json": "{}\n" }, respond: fixed(200, []) },
        async (f) => {
          await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          // ⭐ Issue #586 / ADR 0253 追記1 で前段が入った。1本目が「在るか」、2本目が「読めたか」。
          expect(f.state.paths[0]).toBe(`/api/models/${repo}`);
          // 🔴 Issue #597 案(a)（ADR 0253 追記4）: この門は `main` を照合し続ける番犬として
          // 残る決定である。CI が使う revision は
          // `scripts/local-embedding-pinned-revision.json` に固定したが、**この門はそちらを
          // 見ない**。⟹ ここが `tree/main` のリテラルのままであることが、その決定の歯である
          // ——固定した revision へ差し替えると、上流の `main` が動いても門が黙ってしまう。
          expect(f.state.paths[1]).toBe(`/api/models/${repo}/tree/main?recursive=1&expand=1`);
        },
      );
    },
  );
});

/**
 * `<repo>/<revision>/<filename>` というキャッシュの置き場所（Issue #597 案(a)、
 * ADR 0253 追記5）の正規化。
 *
 * 【背景・実測】CI run 35953212055 で、`examples/chat` が固定した revision を渡す
 * ようになった結果、`@huggingface/transformers` の `FileCache` がこの配置でファイルを
 * 書くようになり、この門が「素性不明」を報告して赤くなった。ここでは
 * `withFixture` の `setup.files`（`repoDir` 直下へ書く）を使わず、`f.cacheDir` へ
 * 直接、revision サブディレクトリを掘って書く——**HF の tree（模擬）の `path` は
 * プレフィックス無しのまま**にすることで、「照合対象は変えていない」ことを歯自体でも
 * 固定する。
 */
describe("check-local-embedding-fingerprint.mjs（CLI）: revision サブディレクトリの正規化（Issue #597 案(a)、ADR 0253 追記5）", () => {
  it.concurrent(
    "@huggingface/transformers が revision 指定時に書く <repo>/<revision>/<filename> の配置でも一致する",
    async () => {
      const contents = Buffer.from('{"ok":true}\n', "utf8");
      const oid = gitBlobSha1(contents);
      await withFixture(
        { files: {}, respond: fixed(200, [{ type: "file", path: "config.json", oid }]) },
        async (f) => {
          const nestedPath = join(f.cacheDir, repo, pinnedRevision, "config.json");
          mkdirSync(dirname(nestedPath), { recursive: true });
          writeFileSync(nestedPath, contents);
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.stdout).toContain("一致: 手元の 1 本すべてが宣言された repo の内容と一致した。");
          expect(r.code).toBe(0);
        },
      );
    },
  );

  it.concurrent(
    "フラット配置（revision=main）と revision サブディレクトリ配置が同居していても、両方一致として数える" +
      "（CI の example-chat ジョブで実際に起きている形——embedding-fingerprint サブコマンドは" +
      "revision を渡さず、test:db は渡すため、同じキャッシュディレクトリに両方の配置が並ぶ）",
    async () => {
      const contents = Buffer.from('{"ok":true}\n', "utf8");
      const oid = gitBlobSha1(contents);
      await withFixture(
        {
          files: { "config.json": '{"ok":true}\n' },
          respond: fixed(200, [{ type: "file", path: "config.json", oid }]),
        },
        async (f) => {
          const nestedPath = join(f.cacheDir, repo, pinnedRevision, "config.json");
          mkdirSync(dirname(nestedPath), { recursive: true });
          writeFileSync(nestedPath, contents);
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.stdout).toContain("一致: 手元の 2 本すべてが宣言された repo の内容と一致した。");
          expect(r.code).toBe(0);
        },
      );
    },
  );

  it.concurrent(
    "⚠ 陰性対照: 宣言と違う revision のサブディレクトリは正規化されず、素性不明のまま赤になる",
    async () => {
      const contents = Buffer.from('{"ok":true}\n', "utf8");
      const oid = gitBlobSha1(contents);
      const wrongRevision = "0".repeat(40);
      await withFixture(
        { files: {}, respond: fixed(200, [{ type: "file", path: "config.json", oid }]) },
        async (f) => {
          const nestedPath = join(f.cacheDir, repo, wrongRevision, "config.json");
          mkdirSync(dirname(nestedPath), { recursive: true });
          writeFileSync(nestedPath, contents);
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.stdout).toContain("素性不明");
          expect(r.code).toBe(1);
        },
      );
    },
  );

  it.concurrent(
    "CLI は固定した revision の宣言を印字する（キャッシュの置き場所の解釈にのみ使うことの開示）",
    async () => {
      await withFixture(
        { files: { "config.json": '{"ok":true}\n' }, respond: (e) => ({ status: 200, body: e }) },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.stdout).toContain(
            `固定した revision の宣言（キャッシュの置き場所の解釈にのみ使う。照合対象は main のまま）: ${pinnedRevision}`,
          );
        },
      );
    },
  );
});

describe("check-local-embedding-fingerprint.mjs（CLI）: tree API の応答ごとの終了コード", () => {
  it.concurrent("200 ＋ 手元のファイルと一致する tree ⟹ 一致（exit 0）", async () => {
    await withFixture(
      { files: { "config.json": '{"ok":true}\n' }, respond: (e) => ({ status: 200, body: e }) },
      async (f) => {
        const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.stdout).toContain("一致: 手元の 1 本すべてが宣言された repo の内容と一致した。");
        expect(r.code).toBe(0);
        // ⭐ 存在確認1回 ＋ tree 1回。**正常系で増える往復はちょうど1回である**
        // （200 を見た時点で返すので、前段の再試行の待ち時間は発生しない）。
        expect(f.state.hits).toBe(2);
      },
    );
  });

  it.concurrent("200 ＋ hash が食い違う tree ⟹ 赤（exit 1）", async () => {
    await withFixture(
      {
        files: { "config.json": '{"ok":true}\n' },
        respond: (e) => ({ status: 200, body: e.map((x) => ({ ...x, oid: "0".repeat(40) })) }),
      },
      async (f) => {
        const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.stdout).toContain("hash 食い違い: config.json");
        expect(r.code).toBe(1);
      },
    );
  });

  it.concurrent("200 ＋ 手元のファイルが tree に無い ⟹ 素性不明で赤（exit 1）", async () => {
    await withFixture(
      { files: { "config.json": '{"ok":true}\n' }, respond: fixed(200, []) },
      async (f) => {
        const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.stdout).toContain("素性不明（HF の tree に無い）: config.json");
        expect(r.code).toBe(1);
      },
    );
  });

  it.concurrent(
    "⭐ 404（宣言された repo が存在しない）⟹ **赤（exit 1）**。⛔ 保留にしない（Issue #586 / ADR 0253 追記1）",
    async () => {
      await withFixture(
        {
          files: { "config.json": "{}\n" },
          respond: fixed(404, { error: "Repository not found" }),
        },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          // 🔴 **この期待値は 2026-09-21 に 2 から 1 へ意図して書き換えた。**
          // 元は「届いているのに保留になる」という #586 が名指ししたずれを固定していた。
          // ⟹ その決定（ADR 0253 追記1）が入ったので、歯もそれに合わせた。
          // ⛔ **黙って直したのではない。**
          expect(r.stderr).toContain("赤（mismatch）");
          expect(r.stderr).toContain("Hugging Face に存在しない");
          expect(r.code).toBe(1);
          // 前段が3回とも 404 を見て初めて赤になる（一過性の 404 で必須ジョブを止めない）。
          expect(f.state.hits).toBe(3);
        },
      );
    },
  );

  it.concurrent(
    "🔴 429（レート制限）⟹ 保留（exit 2）。⭐ こちらは外部要因なので、#586 の判断でも保留のままになる公算が高い",
    async () => {
      await withFixture(
        { files: { "config.json": "{}\n" }, respond: fixed(429, { error: "Too Many Requests" }) },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.stderr).toContain("保留（undetermined）");
          expect(r.stderr).toContain("HTTP 429");
          expect(r.code).toBe(2);
        },
      );
    },
  );

  it.concurrent("500 ⟹ 保留（exit 2）", async () => {
    await withFixture(
      { files: { "config.json": "{}\n" }, respond: fixed(500, { error: "boom" }) },
      async (f) => {
        const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.stderr).toContain("保留（undetermined）");
        expect(r.stderr).toContain("HTTP 500");
        expect(r.code).toBe(2);
      },
    );
  });

  it.concurrent(
    "🔴 200 だが応答が配列でない ⟹ 保留（exit 2）。⛔ 到達失敗ではない——#586 が名指ししているもう1つの経路",
    async () => {
      await withFixture(
        { files: { "config.json": "{}\n" }, respond: fixed(200, { error: "not an array" }) },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.stderr).toContain("保留（undetermined）");
          expect(r.stderr).toContain("tree API の応答が配列でなかった");
          expect(r.code).toBe(2);
        },
      );
    },
  );

  it.concurrent(
    "接続が拒否される（誰も listen していない）⟹ 保留（exit 2）。⭐ 判定表が唯一名指ししている事象",
    async () => {
      await withFixture(
        { files: { "config.json": "{}\n" }, respond: fixed(200, []) },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", "http://127.0.0.1:1"]);
          expect(r.stderr).toContain("保留（undetermined）");
          expect(r.code).toBe(2);
          // スタブは立てたが、届き先が違うので1度も叩かれていない。
          expect(f.state.hits).toBe(0);
        },
      );
    },
  );
});

describe("check-local-embedding-fingerprint.mjs（CLI）: 再試行", () => {
  it.concurrent(
    "503 のとき tree API をちょうど3回叩く（前段は 404 でないので1回で抜ける）",
    async () => {
      await withFixture(
        { files: { "config.json": "{}\n" }, respond: fixed(503, { error: "unavailable" }) },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.code).toBe(2);
          // CLI の RETRY_ATTEMPTS = 3。前段1回（503 ⟹「在るか」に答えない・再試行しない）
          // ＋ tree 3回 = 4。⚠ 本数を焼き込んでいるのはここだけで、変えたときに鳴るのが
          // 狙いである（変えるなら判定表の文言も一緒に見ること）。
          expect(f.state.hits).toBe(4);
        },
      );
    },
  );

  it.concurrent(
    "⚠ 陰性対照: 一致する応答では1回しか叩かない（回数の主張が空回りしていないこと）",
    async () => {
      await withFixture(
        { files: { "config.json": '{"ok":true}\n' }, respond: (e) => ({ status: 200, body: e }) },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.code).toBe(0);
          expect(f.state.hits).toBe(2);
        },
      );
    },
  );
});

describe("check-local-embedding-fingerprint.mjs（CLI）: HF へ問い合わせる前に決まるもの", () => {
  it.concurrent("--cache-dir も env も無い ⟹ 赤（exit 1）。HF を1度も叩かない", async () => {
    await withFixture({ respond: fixed(200, []) }, async (f) => {
      const env = { ...process.env };
      delete env.MNEMORA_LOCAL_EMBEDDING_CACHE_DIR;
      const r = await runCli(["--api-base", f.origin], env);
      expect(r.stderr).toContain("赤（mismatch）");
      expect(r.stderr).toContain("キャッシュの場所が指定されていない");
      expect(r.code).toBe(1);
      expect(f.state.hits).toBe(0);
    });
  });

  it.concurrent(
    "キャッシュに検査対象のファイルが1本も無い ⟹ 赤（exit 1）。⛔ 保留にしない",
    async () => {
      await withFixture({ respond: fixed(200, []) }, async (f) => {
        const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.stdout).toContain("不一致: 手元に検査対象のファイルが1本も無い");
        expect(r.code).toBe(1);
      });
    },
  );

  it.concurrent("不明な引数 ⟹ 実行時エラー（exit 3）", async () => {
    const r = await runCli(["--no-such-flag"]);
    expect(r.stderr).toContain("不明な引数: --no-such-flag");
    expect(r.code).toBe(3);
  });
});

describe("check-local-embedding-fingerprint.mjs（CLI）: 前段「宣言が指す先が在るか」（Issue #586 / ADR 0253 追記1）", () => {
  /** モデル情報 API と tree API で別々の応答を返す respond。 */
  const byPath = (info, tree) => (entries, url) =>
    url.includes("/tree/") ? tree(entries) : info(entries);

  it.concurrent(
    "⭐ 前段が 200・tree が 404 ⟹ **保留（exit 2）のまま**。repo は在るので、tree だけの 404 は外部要因である",
    async () => {
      await withFixture(
        {
          files: { "config.json": "{}\n" },
          respond: byPath(
            () => ({ status: 200, body: { id: repo } }),
            () => ({ status: 404, body: { error: "not found" } }),
          ),
        },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.stderr).toContain("保留（undetermined）");
          expect(r.code).toBe(2);
        },
      );
    },
  );

  it.concurrent(
    "🔴 前段が 429 ⟹ 赤にしない（「在るか」に答えていない）。続行して tree 側の判定に委ねる",
    async () => {
      await withFixture(
        {
          files: { "config.json": "{}\n" },
          respond: fixed(429, { error: "Too Many Requests" }),
        },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          // ⛔ 429 を赤にしてはならない——外部要因で必須ジョブを止めることになる。
          expect(r.stderr).not.toContain("Hugging Face に存在しない");
          expect(r.stdout).toContain("宣言された repo の存在確認: undetermined（HTTP 429）");
          expect(r.code).toBe(2);
        },
      );
    },
  );

  it.concurrent("前段が 200 なら、存在確認は present として印字される", async () => {
    await withFixture(
      {
        files: { "config.json": '{"ok":true}\n' },
        respond: byPath(
          () => ({ status: 200, body: { id: repo } }),
          (entries) => ({ status: 200, body: entries }),
        ),
      },
      async (f) => {
        const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.stdout).toContain("宣言された repo の存在確認: present（HTTP 200）");
        expect(r.code).toBe(0);
      },
    );
  });

  it.concurrent(
    "⚠ 陰性対照: 前段が 404 なら tree を1度も叩かない（前段で止まっていることの根拠）",
    async () => {
      await withFixture(
        { files: { "config.json": "{}\n" }, respond: fixed(404, { error: "nope" }) },
        async (f) => {
          await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(f.state.paths.filter((u) => u.includes("/tree/"))).toEqual([]);
        },
      );
    },
  );
});

describe("check-local-embedding-fingerprint.mjs（CLI）: tree の形が変わったときの診断（Issue #586 発見2 / ADR 0253 追記2）", () => {
  /**
   * ⭐ **ここは文面そのものを assert する。**
   *
   * この検査が守っているのは exit コードではない——**判定は1つも変えていない**。
   * 守っているのは「赤くなったときに、読んだ人が真因に辿り着けるか」である。
   * ⟹ **赤の逐語は、欠陥の中身を人間の言葉で残す唯一の場所**なので、そこを固定する。
   *
   * 🔴 **以前の文面は「素性不明（HF の tree に無い）」だけで、読んだ人を
   * 「キャッシュが汚れた」へ誘導していた**（真因は HF の応答の形の変化）。
   */

  it.concurrent(
    "⭐ oid も lfs.oid も無いエントリが在ると、件数と『応答の形が変わった可能性』を印字する",
    async () => {
      await withFixture(
        {
          files: { "config.json": '{"ok":true}\n' },
          // HF が hash の返し方を変えた状況: path は在るが oid が無い。
          respond: (entries) => ({
            status: 200,
            body: entries.map(({ oid, ...rest }) => ({ ...rest, sha: oid })),
          }),
        },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.stderr).toContain("hash を取れないエントリが 1 件あった");
          expect(r.stderr).toContain("Hugging Face の応答の形が変わった可能性がある");
          expect(r.stderr).toContain("hash を取れなかった tree エントリ: config.json");
          // ⛔ 判定は変えていない。手元のファイルが素性不明になるので、従来どおり赤。
          expect(r.stdout).toContain("素性不明（HF の tree に無い）: config.json");
          expect(r.code).toBe(1);
        },
      );
    },
  );

  it.concurrent(
    "⭐ file でも directory でもないエントリが在ると、その件数も印字する（HF がフィールド名を変えた場合）",
    async () => {
      await withFixture(
        {
          files: { "config.json": '{"ok":true}\n' },
          respond: (entries) => ({
            status: 200,
            body: [...entries, { kind: "blob", name: "x" }, { kind: "blob", name: "y" }],
          }),
        },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.stderr).toContain("file でも directory でもないエントリが 2 件あった");
          expect(r.stderr).toContain("Hugging Face の応答の形が変わった可能性がある");
          // 手元のファイルは正しく一致しているので、判定は緑のまま。
          expect(r.code).toBe(0);
        },
      );
    },
  );

  it.concurrent(
    "🔴 緑のときでも黙らない: 手元に対応するファイルが無い tree エントリの hash が取れなくても印字する",
    async () => {
      await withFixture(
        {
          files: { "config.json": '{"ok":true}\n' },
          respond: (entries) => ({
            status: 200,
            // 手元に無いファイル（onnx/model.onnx）のほうだけ oid を落とす。
            body: [...entries, { type: "file", path: "onnx/model.onnx" }],
          }),
        },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          // ⭐ 判定は緑（手元の1本は一致している）。それでも理由は出る。
          expect(r.code).toBe(0);
          expect(r.stderr).toContain("hash を取れないエントリが 1 件あった");
          expect(r.stderr).toContain("hash を取れなかった tree エントリ: onnx/model.onnx");
        },
      );
    },
  );

  it.concurrent("⚠ 陰性対照: 形が正常なら、読み飛ばしの文面は1行も出ない", async () => {
    await withFixture(
      {
        files: { "config.json": '{"ok":true}\n' },
        // ⭐ directory エントリは正常なので、数に入ってはならない。
        respond: (entries) => ({
          status: 200,
          body: [...entries, { type: "directory", path: "onnx" }],
        }),
      },
      async (f) => {
        const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.code).toBe(0);
        expect(r.stderr).not.toContain("応答の形が変わった可能性がある");
        expect(r.stderr).not.toContain("エントリが");
      },
    );
  });

  it.concurrent("--json に読み飛ばしの内訳が載る", async () => {
    await withFixture(
      {
        files: { "config.json": '{"ok":true}\n' },
        respond: (entries) => ({
          status: 200,
          body: entries.map(({ oid, ...rest }) => ({ ...rest, sha: oid })),
        }),
      },
      async (f) => {
        const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin, "--json"]);
        const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
        expect(parsed.skippedTreeEntries).toEqual({ noOid: ["config.json"], unrecognized: 0 });
      },
    );
  });
});
