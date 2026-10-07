import { describe, expect, it } from "vitest";
import { ContestedWithoutCompanionError } from "@mnemora/core";
import type { Ctx, NewMemory, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";

/**
 * ガードは `this.db.execute`/`this.db.transaction` を一度も呼ぶ前に投げるので、このファイルの `store` は本物の接続を持たない `Db`（型だけ満たすスタブ）で構築する。
 * ガードを通過してしまえば必ず `this.db.execute is not a function` で落ちるので、例外の型が {@link ContestedWithoutCompanionError} であることそのものが「ガードが本体のクエリより先に発火した」証拠になる。
 * 手元でDB無しに実行するときは、このファイルを名指しで直接 vitest に渡すこと。
 */
const UNREACHABLE_DB = {} as unknown as Db;

const ctx: Ctx = { tenantId: "tenant-1" };

function contestedInput(overrides: Partial<NewMemory> = {}): NewMemory {
  return buildNewMemoryFixture({
    tenantId: "tenant-1",
    status: "contested",
    ...overrides,
  });
}

function event(memoryId: string): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId,
    kind: "updated",
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: {},
  };
}

describe("PostgresMemoryStore — ADR 0140 書き込み側ガード（DB 不要）", () => {
  it("createMemory: status='contested' かつ contestedWithId 無し を拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(store.createMemory(ctx, contestedInput())).rejects.toBeInstanceOf(
      ContestedWithoutCompanionError,
    );
  });

  it("createMemory: status='contested' かつ contestedWithId が null でも拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.createMemory(ctx, contestedInput({ contestedWithId: null })),
    ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("createMemory: status='contested' かつ contestedWithId 有り は素通しする（DB スタブに実際に到達する＝TypeError）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    // ガードを通過した先で `this.db.execute` を呼ぼうとして落ちる。ContestedWithoutCompanionError ではないことで、ガードが誤って発火していないと分かる。
    await expect(
      store.createMemory(ctx, contestedInput({ contestedWithId: "mem-companion" })),
    ).rejects.not.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("createMemory: status='active'（既定）は contestedWithId 無しでも拒否しない（DB スタブに到達する）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.createMemory(ctx, buildNewMemoryFixture({ tenantId: "tenant-1" })),
    ).rejects.not.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("createMemoryWithOutbox: status='contested' かつ contestedWithId 無し を拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.createMemoryWithOutbox(ctx, contestedInput(), ["embed"]),
    ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("updateStatus: status='contested' への書き込みを常に拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(store.updateStatus(ctx, "mem-1", "contested")).rejects.toBeInstanceOf(
      ContestedWithoutCompanionError,
    );
  });

  it("updateStatus: status='active'/'archived'/'superseded'/'forgotten' は拒否しない（DB スタブに到達する）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    for (const status of ["active", "archived", "superseded", "forgotten"] as const) {
      await expect(store.updateStatus(ctx, "mem-1", status)).rejects.not.toBeInstanceOf(
        ContestedWithoutCompanionError,
      );
    }
  });

  it("updateStatusWithEvent: status='contested' への書き込みを常に拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.updateStatusWithEvent(ctx, "mem-1", "contested", {}, event("mem-1")),
    ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("supersedeWithNewMemories: news に1件でも status='contested' かつ contestedWithId 無し があれば拒否する", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.supersedeWithNewMemories!(
        ctx,
        [
          { input: buildNewMemoryFixture({ tenantId: "tenant-1" }), jobKinds: [] },
          { input: contestedInput(), jobKinds: [] },
        ],
        [],
      ),
    ).rejects.toBeInstanceOf(ContestedWithoutCompanionError);
  });

  it("supersedeWithNewMemories: news が全件 lone contested でなければ拒否しない（DB スタブに到達する）", async () => {
    const store = new PostgresMemoryStore(UNREACHABLE_DB);
    await expect(
      store.supersedeWithNewMemories!(
        ctx,
        [{ input: buildNewMemoryFixture({ tenantId: "tenant-1" }), jobKinds: [] }],
        [],
      ),
    ).rejects.not.toBeInstanceOf(ContestedWithoutCompanionError);
  });
});
