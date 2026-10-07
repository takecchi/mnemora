import { afterAll, describe, expect, it } from "vitest";
import { createExampleRuntime } from "../runtime-factory.js";
import { closeTestClient, getTestClient, requireDatabaseUrl } from "./test-db.js";

describe("examples/chat: createExampleRuntime は Pool 構築後の失敗で Pool を閉じ忘れる（本物の Postgres）", () => {
  afterAll(async () => {
    await closeTestClient();
  });

  it("Pool を使い切った後の同期検証エラー（不正な MNEMORA_LEXICAL_STORE）で reject しても、Pool のコネクションが Postgres 側に残らない", async () => {
    // 接続は固有の application_name を付けて数える。同じ DB への全接続を数えると autovacuum 等で間欠的に赤くなる（Issue #974）。
    const applicationName = `mnemora-close-on-throw-${process.pid}-${Date.now()}`;
    const url = new URL(requireDatabaseUrl());
    url.searchParams.set("application_name", applicationName);
    const databaseUrl = url.toString();
    const { pool: sharedPool } = await getTestClient();

    const countPoolBackends = async (): Promise<number> => {
      const { rows } = await sharedPool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = $1",
        [applicationName],
      );
      return Number(rows[0]?.n ?? "0");
    };

    expect(await countPoolBackends()).toBe(0);

    await expect(
      createExampleRuntime(databaseUrl, {
        MNEMORA_LLM: "deterministic",
        MNEMORA_EMBEDDING: "deterministic",
        MNEMORA_LEXICAL_STORE: "bogus-value-that-does-not-exist",
      }),
    ).rejects.toThrow(/MNEMORA_LEXICAL_STORE/);

    // pool.end() の直後に1回だけ数えない。backend が消えるのは少し後になりうるので、数え直して0を待つ（Issue #974）。
    // 期限 BACKEND_EXIT_DEADLINE_MS は Pool の既定 idleTimeoutMillis（10秒）より十分短く保つ。長いと閉じ忘れを見逃す。
    const BACKEND_EXIT_DEADLINE_MS = 2_000;
    const BACKEND_EXIT_POLL_MS = 50;
    const deadline = Date.now() + BACKEND_EXIT_DEADLINE_MS;
    let remaining = await countPoolBackends();
    while (remaining > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, BACKEND_EXIT_POLL_MS));
      remaining = await countPoolBackends();
    }
    expect(remaining).toBe(0);
  });
});
