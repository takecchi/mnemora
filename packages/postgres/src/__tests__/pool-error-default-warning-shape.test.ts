import { afterEach, describe, expect, it, vi } from "vitest";
import { createPostgresClient } from "../client.js";
import { POOL_ERROR_WARNING_HEAD } from "../pool-error-warning.js";

/** DB には繋がない（`pool.emit` で直接起こす）。警告が名乗る中身を見る: 1つ目の引数は固定の頭 + `: ` + `error.message`（message が落ちると原因が読めない警告になる）、2つ目の引数は `error` そのもの（`code`（SQLSTATE）はここでだけ読める）。 */

function poolError(): Error & { code: string } {
  return Object.assign(new Error("boom: connection terminated"), { code: "57P01" });
}

describe("createPostgresClient の pool の error: 既定の警告の中身", () => {
  const clients: Array<ReturnType<typeof createPostgresClient>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (clients.length > 0) {
      await clients.pop()!.pool.end();
    }
  });

  function open(config?: Parameters<typeof createPostgresClient>[1]) {
    const client = createPostgresClient("postgresql://nobody@127.0.0.1:1/none", config);
    clients.push(client);
    return client;
  }

  it("既定では console.warn が1回。頭と error.message を名乗り、2つ目の引数は error そのもの（code を保つ）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = open();
    const error = poolError();

    client.pool.emit("error", error);

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, second] = warn.mock.calls[0]!;
    expect(message).toBe(`${POOL_ERROR_WARNING_HEAD}: boom: connection terminated`);
    expect(second).toBe(error);
    expect((second as { code?: string }).code).toBe("57P01");
  });

  it("onPoolError を渡すと、その関数が error そのもので1回呼ばれ、console.warn は出ない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onPoolError = vi.fn();
    const client = open({ onPoolError });
    const error = poolError();

    client.pool.emit("error", error);

    expect(onPoolError).toHaveBeenCalledTimes(1);
    expect(onPoolError).toHaveBeenCalledWith(error);
    expect(warn).not.toHaveBeenCalled();
  });
});
