import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

/**
 * ADR 0630 決定8: `supersedeWithNewMemories` で「壊れた `news`」と「存在しない `supersede` の対象」が同時にあるときは、
 * 壊れた値の例外が先に出る。conformance・fixture の歯は、壊れた news が**先頭**の1件のときしか見ていなかった。
 * 入口の検査が先頭の1件（または先頭と末尾）だけを見る変異は、2件目以降が壊れているとき、対象の not found が先に出る形になるが、
 * どの歯も赤にしなかった。壊れた news を先頭・真ん中・末尾に置いて、壊れた値の例外が先であることを縛る。
 */
const ctx: Ctx = { tenantId: "in-memory-supersede-malformed-position" };
const MISSING = randomUUID();

describe("InMemoryMemoryStore.supersedeWithNewMemories: 壊れた news は、どの位置でも、存在しない対象の not found より先に断られる", () => {
  it.each([0, 1, 2])("壊れた news が %s 番目", async (broken) => {
    const store = new InMemoryMemoryStore();
    const news = [0, 1, 2].map((i) => ({
      input: buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `n${i}`,
        ...(i === broken ? { digest: "" } : {}),
      } as Partial<NewMemory>),
      jobKinds: [] as never[],
    }));
    const error = await store
      .supersedeWithNewMemories(ctx, news, [
        {
          id: MISSING as never,
          supersededByIndex: 0,
          event: {
            tenantId: ctx.tenantId,
            memoryId: MISSING as never,
            kind: "superseded",
            actor: { type: "system" },
            digestSnapshot: "d",
            sizeBeforeBytes: null,
            meta: { reason: "test" },
          },
        },
      ])
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(String(error)).toMatch(/digest is malformed/);
    expect(String(error)).not.toMatch(/not found/);
    expect(store.listByTenant(ctx)).toHaveLength(0);
  });
});
