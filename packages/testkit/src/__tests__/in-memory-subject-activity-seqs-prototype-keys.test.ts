import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

const ctx: Ctx = { tenantId: "t1" };
const KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

describe("InMemoryTenantSettingsStore.getSubjectActivitySeqs: Object.prototype のキー名", () => {
  it.each(KEYS)("⭐ '%s' の行の値をそのまま返す", async (key) => {
    const backing = new Map([["t1", new Map([[key, 4]])]]);
    const store = new InMemoryTenantSettingsStore(undefined, backing);
    const seqs = await store.getSubjectActivitySeqs(ctx, [key, "plain"]);
    expect(Object.hasOwn(seqs, key)).toBe(true);
    expect(seqs[key]).toBe(4);
    expect(Object.hasOwn(seqs, "plain")).toBe(false);
  });

  it("陽性対照: plain の行は返る", async () => {
    const backing = new Map([["t1", new Map([["plain", 2]])]]);
    const store = new InMemoryTenantSettingsStore(undefined, backing);
    expect(await store.getSubjectActivitySeqs(ctx, ["plain"])).toEqual({ plain: 2 });
  });
});
