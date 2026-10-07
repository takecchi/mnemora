import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

describe("InMemoryMemoryStore の supportsAddOwnSubjectSeq", () => {
  it("true を宣言している", () => {
    expect(new InMemoryMemoryStore().supportsAddOwnSubjectSeq?.()).toBe(true);
  });
});
