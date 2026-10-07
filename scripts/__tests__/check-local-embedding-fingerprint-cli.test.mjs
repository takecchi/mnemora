import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "./spawn-with-deadline.mjs";

/**
 * 「いまの振る舞い」を固定する。保留（exit 2）を期待する `it` は、Issue #586 が名指しする判定表とのずれを焼いている。
 * #586 の決定が入ったら期待値を意図して書き換える（赤いからという理由だけで直さない）。
 *
 * CLI は `spawnSync` で待たない。スタブのサーバがこのプロセスの中で動くので、同期で待つとイベントループが止まって応答できない。
 */

const script = fileURLToPath(new URL("../check-local-embedding-fingerprint.mjs", import.meta.url));
const providerSource = fileURLToPath(
  new URL("../../packages/local-embedding/src/local-embedding-provider.ts", import.meta.url),
);
const pinnedRevisionDeclaration = fileURLToPath(
  new URL("../local-embedding-pinned-revision.json", import.meta.url),
);

function pinnedRevisionIndependently() {
  const parsed = JSON.parse(readFileSync(pinnedRevisionDeclaration, "utf8"));
  if (typeof parsed?.sha !== "string" || parsed.sha.length === 0) {
    throw new Error(`${pinnedRevisionDeclaration} に sha が無い`);
  }
  return parsed.sha;
}

/** CLI とは別のやり方（行を探して引用符の中を取る）で読む。CLI の正規表現が壊れたのか、宣言が変わったのかを区別するため。 */
function declaredRepoIndependently() {
  const line = readFileSync(providerSource, "utf8")
    .split("\n")
    .find((l) => l.includes("export const DEFAULT_LOCAL_EMBEDDING_REPO"));
  if (!line) throw new Error("宣言の行が見つからない（この歯の前提が崩れている）");
  const parts = line.split('"');
  if (parts.length < 2) throw new Error(`宣言の行から値を取れない: ${line}`);
  return parts[1];
}

/** git の blob hash。CLI/lib とは独立に計算する（被検査体を借りない）。 */
function gitBlobSha1(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const repo = declaredRepoIndependently();
const pinnedRevision = pinnedRevisionIndependently();

/**
 * 共有の `afterEach` を使わず、後始末はテストごとに `finally` で閉じる。`it` は `concurrent` で走り、
 * `afterEach` は他のテストが使用中の資源まで畳みうる。
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

function runCli(args, env) {
  return runNodeScript(script, args, { env });
}

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
          expect(f.state.paths[0]).toBe(`/api/models/${repo}`);
          // この門は `main` を照合し続ける番犬で、固定した revision を見ない。ここを固定 revision に差し替えると、上流の `main` が動いても門が黙る。
          expect(f.state.paths[1]).toBe(`/api/models/${repo}/tree/main?recursive=1&expand=1`);
        },
      );
    },
  );
});

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

describe("check-local-embedding-fingerprint.mjs（CLI）: revision ごとの根（Issue #1403、ADR 0365）", () => {
  it.concurrent("<cacheDir>/<固定revision>/<repo>/<filename> の配置でも一致する", async () => {
    const contents = Buffer.from('{"ok":true}\n', "utf8");
    const oid = gitBlobSha1(contents);
    await withFixture(
      { files: {}, respond: fixed(200, [{ type: "file", path: "config.json", oid }]) },
      async (f) => {
        const path = join(f.cacheDir, encodeURIComponent(pinnedRevision), repo, "config.json");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
        const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.stdout).toContain("一致: 手元の 1 本すべてが宣言された repo の内容と一致した。");
        expect(r.code).toBe(0);
      },
    );
  });

  it.concurrent(
    "平たい配置と <固定revision>/ の根が同居していても、両方を見て、中身が違えば赤になる",
    async () => {
      const contents = Buffer.from('{"ok":true}\n', "utf8");
      const oid = gitBlobSha1(contents);
      await withFixture(
        {
          files: { "config.json": '{"ok":true}\n' },
          respond: fixed(200, [{ type: "file", path: "config.json", oid }]),
        },
        async (f) => {
          const path = join(f.cacheDir, encodeURIComponent(pinnedRevision), repo, "config.json");
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, '{"tampered":true}\n');
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
          expect(r.code).toBe(1);
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

  // root は権限 000 のファイルも読めるので、この場面を作れない。root では skip する。
  it.skipIf(process.getuid?.() === 0)(
    "200 ＋ 1本は一致・1本は読めない ⟹ 赤（exit 1）。読めなかったファイルを名指しする",
    async () => {
      await withFixture(
        {
          files: { "config.json": '{"ok":true}\n', "tokenizer.json": '{"t":1}\n' },
          respond: (e) => ({ status: 200, body: e }),
        },
        async (f) => {
          const locked = join(f.cacheDir, repo, "tokenizer.json");
          chmodSync(locked, 0o000);
          try {
            const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
            expect(r.stderr).toContain("読めなかったファイル 1 本:");
            expect(r.stderr).toContain("tokenizer.json");
            expect(r.code).toBe(1);
          } finally {
            chmodSync(locked, 0o644);
          }
        },
      );
    },
  );

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
          expect(r.stderr).toContain("赤（mismatch）");
          expect(r.stderr).toContain("Hugging Face に存在しない");
          expect(r.code).toBe(1);
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
          // `RETRY_ATTEMPTS` = 3 なので、前段1回 + tree 3回 = 4。本数を焼き込むのはここだけで、変えたときに鳴らすのが狙い。
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

  it.concurrent.each([
    ["repo の宣言が無い", "export const OTHER = 1;\n"],
    ["宣言のファイルが無い", null],
  ])(
    "宣言された repo を読めない（%s）⟹ 赤（exit 1）。HF を1度も叩かない",
    async (_label, provider) => {
      await withFixture({ respond: fixed(200, []) }, async (f) => {
        const root = mkdtempSync(join(tmpdir(), "mnemora-fp-cli-tree-"));
        try {
          mkdirSync(join(root, "scripts"), { recursive: true });
          for (const name of [
            "check-local-embedding-fingerprint.mjs",
            "check-local-embedding-fingerprint-lib.mjs",
          ]) {
            copyFileSync(join(dirname(script), name), join(root, "scripts", name));
          }
          if (provider !== null) {
            const dir = join(root, "packages", "local-embedding", "src");
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "local-embedding-provider.ts"), provider);
          }
          const r = await runNodeScript(
            join(root, "scripts", "check-local-embedding-fingerprint.mjs"),
            ["--cache-dir", f.cacheDir, "--api-base", f.origin],
          );
          expect(r.stderr).toContain("赤（mismatch）");
          expect(r.stderr).toContain("DEFAULT_LOCAL_EMBEDDING_REPO を取り出せなかった");
          expect(r.code).toBe(1);
          expect(f.state.hits).toBe(0);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    },
  );

  it.concurrent(
    "想定外の例外（キャッシュの repo の位置がファイル）⟹ 実行時エラー（exit 3）。緑にしない",
    async () => {
      await withFixture({ respond: (e) => ({ status: 200, body: e }) }, async (f) => {
        const asFile = join(f.cacheDir, repo);
        mkdirSync(dirname(asFile), { recursive: true });
        writeFileSync(asFile, "not a directory\n");
        const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
        expect(r.stderr).toMatch(/ENOTDIR/);
        expect(r.code).toBe(3);
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
          // 429 は赤にしない（外部要因で必須ジョブを止めない）。
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
  /** 文面そのものを assert する。守っているのは exit コードではなく、赤くなったときに読んだ人が真因に辿り着けること。 */

  it.concurrent(
    "⭐ oid も lfs.oid も無いエントリが在ると、件数と『応答の形が変わった可能性』を印字する",
    async () => {
      await withFixture(
        {
          files: { "config.json": '{"ok":true}\n' },
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
            body: [...entries, { type: "file", path: "onnx/model.onnx" }],
          }),
        },
        async (f) => {
          const r = await runCli(["--cache-dir", f.cacheDir, "--api-base", f.origin]);
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
