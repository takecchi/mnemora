import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の歯。PR #1520（ADR 0423）の変異試験で、
 * `InMemoryMemoryStore.createMemoryWithOutbox` が `input.subjectId` の入口検査を外してもすり抜けた
 * （適合テストの識別子の `it` は `createMemory`・`createObservation*` などの代表の口を見て、
 * `createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の `subjectId` は
 * 代表に含まれない）。担当はクローン（miku）の判断で進めている作業であり、オーナーの判断ではない。
 * ADR 0423 決定2は、識別子を入力に持つ口を全部、書き込みより前に断ると決めている（Postgres と揃える）。
 * 同じ型の2つの口も同じ表で見る。公開の適合テスト（`*-conformance.ts`）には足さない。
 *
 * 断る対象: 孤立サロゲートと NUL を含む識別子（`kind: "malformed_identifier"`、message に入力値を入れない）。
 * 書き込みより前に断るので、何も残らない。対をなすサロゲート（絵文字）は受け付ける（陽性対照）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

const MALFORMED: ReadonlyArray<readonly [label: string, value: string]> = [
  ["孤立した上位サロゲート", "id-\uD800"],
  ["孤立した下位サロゲート", "id-\uDC00"],
  ["NUL", "id-\u0000"],
];
const WELL_FORMED_NON_BMP = "id-\u{1F600}";

let counter = 0;
const memoryInput = (subjectId: string) => {
  counter += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    subjectId,
    contentHash: `identifier-write-entries-${counter}`,
  });
};

const createdEvent = (memoryId: string): NewMemoryEvent => ({
  tenantId: ctx.tenantId,
  memoryId,
  kind: "created",
  actor: { type: "system" },
  meta: {},
});

interface Entry {
  name: string;
  call: (store: InMemoryMemoryStore, subjectId: string) => Promise<unknown>;
}

const ENTRIES: Entry[] = [
  {
    name: "createMemoryWithOutbox（input.subjectId）",
    call: (s, v) => s.createMemoryWithOutbox(ctx, memoryInput(v), []),
  },
  {
    name: "createMemoriesWithOutboxAndEvents（news[].input.subjectId）",
    call: (s, v) =>
      s.createMemoriesWithOutboxAndEvents(
        ctx,
        [{ input: memoryInput(v), jobKinds: [] }],
        (memory) => createdEvent(memory.id),
      ),
  },
  {
    name: "supersedeWithNewMemories（news[].input.subjectId）",
    call: (s, v) => s.supersedeWithNewMemories(ctx, [{ input: memoryInput(v), jobKinds: [] }], []),
  },
];

describe("InMemoryMemoryStore: subjectId を入力に持つ書き込みの口は、孤立サロゲート・NUL を入口で断る（ADR 0423 決定2、Issue #1734 / PR #1520 のすり抜け）", () => {
  describe.each(ENTRIES)("$name", ({ call }) => {
    it.each(MALFORMED)(
      "%s は MalformedIdentifierError で断り、message に入力値を入れず、何も書かない",
      async (_label, value) => {
        const store = new InMemoryMemoryStore();
        let reason: unknown;
        try {
          await call(store, value);
        } catch (error) {
          reason = error;
        }
        expect(reason, "reject するはずが、通った").toBeDefined();
        const { kind, message } = reason as { kind?: unknown; message?: unknown };
        expect(kind).toBe("malformed_identifier");
        expect(String(message)).not.toContain(value);
        expect((await store.aggregateScope(ctx, {})).totalInScope).toBe(0);
      },
    );

    it("陽性対照: 対をなすサロゲート（絵文字）は断らない（探り棒が生きている）", async () => {
      const store = new InMemoryMemoryStore();
      await expect(call(store, WELL_FORMED_NON_BMP)).resolves.toBeDefined();
    });
  });
});
