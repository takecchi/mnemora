import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunnerTask } from "vitest";
import { closeTestClient, getTestClient } from "./test-db.js";
// Why not 文字列検査: 渡し方（展開・条件式）が変わっても、登録された it の mode で見る。
// 取り込むと適合 suite 全体がこのファイルにも登録されるので、beforeAll で全部 skip に倒して二重に走らせない。
import "./conformance.postgres.test.js";

const CONCURRENT_IT_NAME = "並行に撃った claimBatch が、同じジョブを二重に claim しない";
const CONCURRENT_CLAIM_CONCURRENCY = 8;

const modes: { concurrentItModes: string[] } = { concurrentItModes: [] };

function collect(task: RunnerTask, path: string[], out: RunnerTask[]): void {
  if (task.type === "test") {
    if (
      task.name === CONCURRENT_IT_NAME &&
      path.some((p) => p.includes("OutboxStore conformance (postgres)"))
    ) {
      out.push(task);
    }
    return;
  }
  for (const child of task.tasks) collect(child, [...path, task.name], out);
}

function skipEverything(task: RunnerTask): void {
  if (task.type === "test") {
    task.mode = "skip";
    return;
  }
  for (const child of task.tasks) skipEverything(child);
}

// vitest は 1 つ目の引数に分割代入を要求する（suite は 2 つ目）。
// eslint-disable-next-line no-empty-pattern
beforeAll(({}, suite) => {
  const found: RunnerTask[] = [];
  collect(suite.file, [], found);
  modes.concurrentItModes = found.map((t) => t.mode);
  // 下の自分の it だけを残して、取り込んだ suite を走らせない。
  for (const child of suite.file.tasks) {
    if (child.type === "suite" && child.name.startsWith("Postgres outbox 並行 claim の配線"))
      continue;
    skipEverything(child);
  }
});

afterAll(async () => {
  await closeTestClient();
});

describe("Postgres outbox 並行 claim の配線", () => {
  it("Postgres の OutboxStore 適合は、並行 claim の it を skip せず走らせる", () => {
    expect(modes.concurrentItModes).toEqual(["run"]);
  });

  it("適合テストが使う共有 pool は、並行数ぶんの接続を持てる", async () => {
    const { pool } = await getTestClient();
    expect(pool.options.max).toBeGreaterThanOrEqual(CONCURRENT_CLAIM_CONCURRENCY);
  });

  it("共有 pool 上で並行数ぶん同時に撃った文は、別々のバックエンドで時間的に重なる", async () => {
    const { pool } = await getTestClient();
    const spans = await Promise.all(
      Array.from({ length: CONCURRENT_CLAIM_CONCURRENCY }, async () => {
        const result = await pool.query<{ pid: number; started: string; finished: string }>(
          "SELECT pg_backend_pid() AS pid, clock_timestamp()::text AS started, (SELECT pg_sleep(0.2))::text AS slept, clock_timestamp()::text AS finished",
        );
        return result.rows[0]!;
      }),
    );
    expect(new Set(spans.map((s) => s.pid)).size).toBe(CONCURRENT_CLAIM_CONCURRENCY);
    const latestStart = Math.max(...spans.map((s) => Date.parse(s.started)));
    const earliestFinish = Math.min(...spans.map((s) => Date.parse(s.finished)));
    expect(latestStart).toBeLessThan(earliestFinish);
  });
});
