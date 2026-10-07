import { describe, expect, it } from "vitest";
import {
  MemoryStatusConflictError,
  isMemoryStatusConflictError,
} from "../interfaces/memory-store.js";

describe("MemoryStatusConflictError の文面と種類", () => {
  it("どの口から投げても同じ名乗りで、特定の口（updateStatus）の名前を名乗らない", () => {
    const error = new MemoryStatusConflictError("m-1", "archived", "active");

    expect(error.message.startsWith("MemoryStore: ")).toBe(true);
    expect(error.message).not.toContain("updateStatus");
  });

  it("起きたこと: 期待した status・観測した status・記憶の id を書く", () => {
    const error = new MemoryStatusConflictError("m-1", "archived", "active");

    expect(error.message).toContain('expected status "archived"');
    expect(error.message).toContain("memory m-1");
    expect(error.message).toContain('but observed "active"');
    expect(error.message).toContain("the write was rejected");
  });

  it("起きたこと: 観測した status が無い（記憶が消えた）ときは (memory disappeared) と書く", () => {
    const error = new MemoryStatusConflictError("m-2", "active", null);

    expect(error.message).toContain("but observed (memory disappeared)");
    expect(error.message).not.toContain('"null"');
  });

  it("直し方: 読み直して判断し直す旨を書き、盲目的な再試行を勧めない", () => {
    const error = new MemoryStatusConflictError("m-1", "archived", "active");

    expect(error.message).toContain("Re-read the memory and decide again");
    expect(error.message).toContain("instead of retrying blindly");
  });

  it("種類・名前・公開のフィールドは文面と関係なく変わらない", () => {
    const error = new MemoryStatusConflictError("m-1", "archived", "active");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MemoryStatusConflictError");
    expect(error.kind).toBe("memory_status_conflict");
    expect(error.memoryId).toBe("m-1");
    expect(error.expectedStatus).toBe("archived");
    expect(error.observedStatus).toBe("active");
    expect(isMemoryStatusConflictError(error)).toBe(true);
    expect(new MemoryStatusConflictError("m-2", "active", null).observedStatus).toBeNull();
  });
});
