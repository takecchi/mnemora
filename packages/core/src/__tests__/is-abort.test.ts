import { describe, expect, it } from "vitest";
import { abortReason, isAbort, runAbortable } from "../abort.js";

describe("isAbort", () => {
  it("signal が undefined なら false", () => {
    expect(isAbort(undefined)).toBe(false);
  });

  it("abort されていない signal は false、abort 済みなら true（理由の有無・値を問わない）", () => {
    const controller = new AbortController();
    expect(isAbort(controller.signal)).toBe(false);
    controller.abort();
    expect(isAbort(controller.signal)).toBe(true);

    for (const reason of [new Error("stop"), "stop", 0, null]) {
      const c = new AbortController();
      c.abort(reason);
      expect(isAbort(c.signal), String(reason)).toBe(true);
    }
  });

  it("AbortSignal.abort() で作った既に abort 済みの signal は true", () => {
    expect(isAbort(AbortSignal.abort())).toBe(true);
  });

  it("runAbortable が abort で reject した時点で true で、例外は abortReason（catch 節での使い方）", async () => {
    const controller = new AbortController();
    const pending = runAbortable(controller.signal, () => new Promise<never>(() => undefined));
    controller.abort(new Error("cancelled"));
    const error = await pending.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAbort(controller.signal)).toBe(true);
    expect(error).toBe(abortReason(controller.signal));
  });

  it("runAbortable が provider の本当の失敗で reject したときは false", async () => {
    const controller = new AbortController();
    const failure = new Error("provider failed");
    const error = await runAbortable(controller.signal, () => Promise.reject(failure)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBe(failure);
    expect(isAbort(controller.signal)).toBe(false);
  });
});
