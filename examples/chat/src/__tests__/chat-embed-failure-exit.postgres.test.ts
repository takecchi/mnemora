import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPENAI_EMBEDDING_DIMENSIONS } from "../providers.js";
import { requireDatabaseUrl } from "./test-db.js";

/**
 * `cli.ts chat` が、取り込み（observe → tick）で embed に失敗した件があるとき、
 * 標準エラーへ警告を出して終了コード 1 で終わる（以降の recall の表示は止めない）こと。
 * 失敗が無いときは、警告も終了コード 1 も出さないこと。
 *
 * `cli.ts` は末尾で `main()` を無条件に実行するので、子プロセスで観る（`cli-verify-no-key.test.ts` と同じ）。
 * 宛先は、この試験が立てた手元の HTTP サーバー（`OPENAI_BASE_URL`）で、実 API には出ない。
 * 埋め込みの呼び出しのうち `failOnCalls` に入る番号だけを 400（再送されない）で落とし、
 * ほかは正しい形の応答を返す。埋め込み以外の経路は、呼ばれたら 400 にする。
 * 本物の Postgres を使う（`chat` が `DATABASE_URL` を要るため）。
 */

const chatDir = fileURLToPath(new URL("../..", import.meta.url));
const CLI_TIMEOUT_MS = 90_000;

interface StubServer {
  server: Server;
  baseUrl: string;
  embeddingCalls: () => number;
}

async function startStub(failOnCalls: ReadonlySet<number>): Promise<StubServer> {
  let embeddingCalls = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (!(req.url ?? "").endsWith("/embeddings")) {
        send(400, { error: { message: "stub: only /embeddings is served", type: "stub" } });
        return;
      }
      embeddingCalls += 1;
      if (failOnCalls.has(embeddingCalls)) {
        send(400, { error: { message: "stub: refused", type: "invalid_request_error" } });
        return;
      }
      const parsed = JSON.parse(body) as { input: string | string[]; encoding_format?: string };
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      // SDK は encoding_format を省くと "base64" を要求し、応答の文字列を float32 として復号する。
      const encode = (vector: number[]): number[] | string =>
        parsed.encoding_format === "base64"
          ? Buffer.from(new Float32Array(vector).buffer).toString("base64")
          : vector;
      send(200, {
        object: "list",
        model: "text-embedding-3-small",
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        data: inputs.map((_, index) => ({
          object: "embedding",
          index,
          embedding: encode(
            Array.from({ length: OPENAI_EMBEDDING_DIMENSIONS }, (_v, i) =>
              i === index % OPENAI_EMBEDDING_DIMENSIONS ? 1 : 0,
            ),
          ),
        })),
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    embeddingCalls: () => embeddingCalls,
  };
}

function runChat(
  baseUrl: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  delete env.MNEMORA_LLM;
  delete env.MNEMORA_EMBEDDING;
  delete env.MNEMORA_PROVIDER_SOURCE;
  env.DATABASE_URL = requireDatabaseUrl();
  env.OPENAI_API_KEY = "dummy-key-for-stub";
  env.OPENAI_BASE_URL = baseUrl;
  return new Promise((resolve) => {
    execFile(
      "pnpm",
      ["exec", "tsx", "src/cli.ts", "chat"],
      { cwd: chatDir, env, encoding: "utf8", timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe("examples/chat cli.ts chat: embed の失敗を画面と終了コードで言う", () => {
  it(
    "embed が1件だけ失敗したとき、標準エラーに警告を出し、件数を数え、終了コード 1 で、recall の表示まで進む",
    async () => {
      const stub = await startStub(new Set([3]));
      try {
        const result = await runChat(stub.baseUrl);
        expect(stub.embeddingCalls()).toBeGreaterThanOrEqual(3);
        expect(result.stderr).toContain("🔴 embed に失敗した件がある(1件)");
        expect(result.stdout).toContain("失敗 1 件");
        // 失敗しても打ち切らない: 以降の recall の表示まで出す。
        expect(result.stdout).toContain("=== recall()（budget 無し） ===");
        expect(result.code).toBe(1);
      } finally {
        await new Promise<void>((resolve) => stub.server.close(() => resolve()));
      }
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "陽性対照: embed が1件も失敗しないときは、警告を出さず終了コード 0",
    async () => {
      const stub = await startStub(new Set());
      try {
        const result = await runChat(stub.baseUrl);
        expect(stub.embeddingCalls()).toBeGreaterThanOrEqual(1);
        expect(result.stderr).not.toContain("🔴 embed に失敗した件がある");
        expect(result.stdout).toContain("失敗 0 件");
        expect(result.code).toBe(0);
      } finally {
        await new Promise<void>((resolve) => stub.server.close(() => resolve()));
      }
    },
    CLI_TIMEOUT_MS,
  );
});
