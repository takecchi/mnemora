import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  acquireAdvisoryLockOnClient,
  deriveAdvisoryLockKey,
  type AdvisoryLockErrorFactories,
} from "../advisory-lock.js";
import { closePostgresClient, createPostgresClient } from "../client.js";
import { EXTENSION_LOCK_KEY } from "../migrate.js";

function recordingErrors() {
  const calls: string[] = [];
  const errors: AdvisoryLockErrorFactories = {
    timeout: (_waitedMs, cause) => {
      calls.push("timeout");
      return Object.assign(new Error("timeout"), { cause });
    },
    unavailable: (cause) => {
      calls.push("unavailable");
      return Object.assign(new Error("unavailable"), { cause });
    },
  };
  return { calls, errors };
}

function clientThrowing(error: unknown): PoolClient {
  return {
    query: async () => {
      throw error;
    },
  } as unknown as PoolClient;
}

describe("B3: acquireAdvisoryLockOnClient は SQLSTATE で timeout と unavailable を投げ分ける", () => {
  it("55P03（lock_timeout 超過）なら errors.timeout", async () => {
    const { calls, errors } = recordingErrors();
    const pgError = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });
    await expect(acquireAdvisoryLockOnClient(clientThrowing(pgError), 1n, errors)).rejects.toThrow(
      "timeout",
    );
    expect(calls).toEqual(["timeout"]);
  });

  it.each([
    [
      "別の SQLSTATE（42501 権限不足）",
      Object.assign(new Error("permission denied"), { code: "42501" }),
    ],
    ["SQLSTATE の無い例外（接続断など）", new Error("Connection terminated unexpectedly")],
  ])("%s なら errors.unavailable（元の例外を cause に渡す）", async (_label, raised) => {
    const { calls, errors } = recordingErrors();
    const error = await acquireAdvisoryLockOnClient(clientThrowing(raised), 1n, errors).then(
      () => expect.fail("例外が投げられなかった"),
      (reason: unknown) => reason as Error,
    );
    expect(error.message).toBe("unavailable");
    expect(error.cause).toBe(raised);
    expect(calls).toEqual(["unavailable"]);
  });
});

describe("B5: createPostgresClient の extensionSchema は schema を指定したときだけ効く", () => {
  it("schema を省けば、不正な extensionSchema でも検査せず、pool の options にも触らない", async () => {
    const client = createPostgresClient("postgresql://unused@127.0.0.1:1/unused", {
      extensionSchema: "BAD-NAME",
    });
    try {
      const options = (client.pool as unknown as { options: { options?: string } }).options;
      expect(options.options).toBeUndefined();
    } finally {
      await closePostgresClient(client);
    }
  });

  it("schema を指定すると、extensionSchema も検査し、不正なら構築の時点で投げる", () => {
    expect(() =>
      createPostgresClient("postgresql://unused@127.0.0.1:1/unused", {
        schema: "ok_ns",
        extensionSchema: "BAD-NAME",
      }),
    ).toThrow(/^unsafe SQL identifier: BAD-NAME/);
  });
});

describe("B7: EXTENSION_LOCK_KEY は doc に書いた固定文字列から導いた値", () => {
  it("deriveAdvisoryLockKey('mnemora:runMigrations:extension-lock') と一致する", () => {
    expect(deriveAdvisoryLockKey("mnemora:runMigrations:extension-lock")).toBe(EXTENSION_LOCK_KEY);
  });
});
