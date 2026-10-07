import { describe, expect, it } from "vitest";
import type { Ctx, Memory, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/** fixture の id は `nextId("mem")` の連番で、id を指定して記憶を作る口は無い。連番はモジュールごとに 0 から数えるので、この歯だけを別ファイルに置き、他の歯が数えを進めない状態で `mem-1`〜`mem-25` を作る。Postgres の id は uuid で部分文字列の関係を作れないので、parity の歯には入れない。 */

const A: Ctx = { tenantId: "superseded-by-substring" };

const ev = (memoryId: string): NewMemoryEvent => ({
  tenantId: A.tenantId,
  memoryId: memoryId as MemoryId,
  kind: "superseded",
  actor: { type: "system" },
  meta: { probe: true },
});

describe("testkit の InMemory: id が部分文字列の関係にある別の記憶を supersededById に渡すと通る（ADR 0558）", () => {
  const callers = [
    [
      "updateStatus",
      (s: InMemoryMemoryStore, id: string, by: string) =>
        s.updateStatus(A, id as MemoryId, "superseded", { supersededById: by } as never),
    ],
    [
      "updateStatusWithEvent",
      (s: InMemoryMemoryStore, id: string, by: string) =>
        s.updateStatusWithEvent(
          A,
          id as MemoryId,
          "superseded",
          { supersededById: by } as never,
          ev(id),
        ),
    ],
  ] as const;

  {
    // 連番を 0 から数える前提なので、it は 1 本にして中で 2 つの口を回す。
    it("updateStatus・updateStatusWithEvent: id が前方一致の関係にある別の記憶（mem-10 → mem-1、mem-1 → mem-10）は、小文字でも大文字でも通る", async () => {
      const store = new InMemoryMemoryStore();
      const made: Memory[] = [];
      for (let i = 1; i <= 25; i += 1) {
        made.push(
          await store.createMemory(
            A,
            buildNewMemoryFixture({
              tenantId: A.tenantId,
              content: `body-${i}`,
              digest: `digest-${i}`,
              contentHash: `hash-${i}`,
            }),
          ),
        );
      }
      const byName = (id: string) => made.find((m) => m.id === id)!;
      expect(made.map((m) => m.id).slice(0, 2)).toEqual(["mem-1", "mem-2"]);
      expect(byName("mem-10")).toBeDefined();
      for (const [, call] of callers) {
        for (const [selfId, byId] of [
          ["mem-10", "mem-1"],
          ["mem-1", "mem-10"],
        ] as const) {
          for (const spelled of [byId, byId.toUpperCase()]) {
            await store.updateStatus(A, selfId as MemoryId, "active");
            await call(store, selfId, spelled);
            const after = (await store.get(A, selfId as MemoryId))!;
            expect([after.status, after.supersededById]).toEqual(["superseded", byId]);
          }
        }
      }
    });
  }
});
