import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runComparison } from "../compare.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

const chatDir = fileURLToPath(new URL("../..", import.meta.url));
const CLI_TIMEOUT_MS = 90_000;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runChatCli(extraEnv: Record<string, string>): Promise<CliResult> {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.MNEMORA_LLM;
  delete env.MNEMORA_EMBEDDING;
  delete env.MNEMORA_PROVIDER_SOURCE;
  Object.assign(env, extraEnv);
  env.DATABASE_URL = requireDatabaseUrl();
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

/** `chat` は `example-chat-<起動時刻のミリ秒>` のテナントを使う。起動前に取った時刻以上のものだけを、この実行のテナントとして拾う。 */
const CHAT_TENANT_SINCE = (startedAt: number) =>
  `tenant_id ~ '^example-chat-[0-9]+$' AND substring(tenant_id from 14)::bigint >= ${String(startedAt)}`;

async function startEmbeddingRefusingStub(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "stub: refused", type: "invalid_request_error" } }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(port)}/v1` };
}

describe("examples/chat の chat サブコマンドは、載せた記憶を使用報告する", () => {
  it(
    "budget 無しの recall が返した記憶だけを、1回だけ報告する（budget 有りの recall は報告しない）",
    async () => {
      await resetTestDatabase();
      const { pool } = await getTestClient();
      const startedAt = Date.now();

      const result = await runChatCli({});

      expect(result.code).toBe(0);
      const reported =
        /\[memory_usage\] (\d+) 件の Memory を使用報告した（recallId=([0-9a-f-]{36})）/.exec(
          result.stdout,
        );
      expect(reported, result.stdout).not.toBeNull();
      const reportedCount = Number(reported![1]);
      const recallId = reported![2];
      const afterHeader = result.stdout.slice(
        result.stdout.indexOf("=== recall()（budget 無し） ==="),
      );
      const withoutBudgetCount = /memories: (\d+) 件返却/.exec(afterHeader);
      expect(withoutBudgetCount, result.stdout).not.toBeNull();
      expect(reportedCount).toBe(Number(withoutBudgetCount![1]));
      expect(reportedCount).toBeGreaterThan(0);

      const recall = await pool.query<{ tenant_id: string; budget: unknown }>(
        "SELECT tenant_id, budget FROM recalls WHERE id = $1",
        [recallId],
      );
      expect(recall.rows[0]?.budget).toBeNull();
      const tenantId = recall.rows[0]!.tenant_id;

      const usages = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM recall_usages WHERE tenant_id = $1",
        [tenantId],
      );
      expect(Number(usages.rows[0]?.count)).toBe(reportedCount);
      const forThisRecall = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM recall_usages WHERE recall_id = $1",
        [recallId],
      );
      expect(Number(forThisRecall.rows[0]?.count)).toBe(reportedCount);

      const usageObservations = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM observations WHERE kind = 'usage' AND ${CHAT_TENANT_SINCE(startedAt)}`,
      );
      expect(Number(usageObservations.rows[0]?.count)).toBe(1);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "載せる記憶が0件なら、観測を1件も書かず、報告しなかったと言う",
    async () => {
      await resetTestDatabase();
      const { pool } = await getTestClient();
      const stub = await startEmbeddingRefusingStub();
      const startedAt = Date.now();
      try {
        const result = await runChatCli({
          OPENAI_API_KEY: "dummy-key-for-stub",
          OPENAI_BASE_URL: stub.baseUrl,
          MNEMORA_LLM: "deterministic",
        });

        expect(result.stdout).toContain(
          "[memory_usage] 載せる Memory が0件だったため、報告しなかった。",
        );
        expect(result.stdout).not.toContain("件の Memory を使用報告した");
        const usageObservations = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM observations WHERE kind = 'usage' AND ${CHAT_TENANT_SINCE(startedAt)}`,
        );
        expect(Number(usageObservations.rows[0]?.count)).toBe(0);
      } finally {
        await new Promise<void>((resolve) => stub.server.close(() => resolve()));
      }
    },
    CLI_TIMEOUT_MS,
  );
});

describe("examples/chat の compare は、行ごとに1回だけ使用報告する", () => {
  it("各行のテナントに、使用報告の観測が1件・recalls が1件・recall_usages が返した件数ぶん入る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const rows = await runComparison(handle.runtime, {
        fillerPairsSequence: [0, 3, 10],
        tenantPrefix: "example-compare-single-report",
        memoryStore: handle.memoryStore,
      });

      for (const row of rows) {
        const tenantId = `example-compare-single-report-${row.fillerPairs}`;
        const count = async (sql: string): Promise<number> =>
          Number((await handle.pool.query<{ count: string }>(sql, [tenantId])).rows[0]?.count);
        expect(
          await count(
            "SELECT COUNT(*)::text AS count FROM observations WHERE tenant_id = $1 AND kind = 'usage'",
          ),
          `fillerPairs=${row.fillerPairs}`,
        ).toBe(1);
        expect(
          await count("SELECT COUNT(*)::text AS count FROM recalls WHERE tenant_id = $1"),
        ).toBe(1);
        expect(
          await count("SELECT COUNT(*)::text AS count FROM recall_usages WHERE tenant_id = $1"),
        ).toBe(row.returnedCount);
      }
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
