import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import {
  DECAY_CLOCK_UNSUPPORTED_MESSAGE,
  TAXONOMY_MODE_UNSUPPORTED_MESSAGE,
  readActivitySeq,
  readDecayClock,
  readDefaultHalfLifeRecalls,
  readHasSubjectActivityCounters,
  readSubjectActivitySeq,
  readSubjectActivitySeqs,
  readTaxonomyMode,
  writeDecayClock,
  writeTaxonomyMode,
} from "../interfaces/tenant-settings-store.js";
import type { TenantSettingsStore } from "../interfaces/tenant-settings-store.js";

/**
 * ADR 0437 決定1: `TenantSettingsStore` を受け取る公開ヘルパー（`read*` / `write*`）9本も、
 * store が投げた例外から drizzle の `params:` より後ろを落とす（ADR 0430 決定3 の対象を広げた）。
 *
 * ⭐ 9本は手で数えたのではなく、公開 API の snapshot（`scripts/__snapshots__/public-api/core.d.ts`）の
 * 「第1引数が `store: TenantSettingsStore` の公開関数」から引く。ヘルパーが増えたのにこの表へ足し忘れると、
 * 最初の it が赤になる。
 */

const SECRET = "問いの本文-SECRET-孤立サロゲート\uD800-末尾";
const ctx: Ctx = { tenantId: "tenant-1" };

function drizzleShapedError(): Error {
  return new Error(`Failed query: SELECT 1 FROM tenant_settings\nparams: ${SECRET}`, {
    cause: new Error(`Failed query: inner\nparams: ${SECRET}`),
  });
}

/** 全メソッドが drizzle 形の例外を投げる store。 */
function throwingStore(make: () => Error = drizzleShapedError): TenantSettingsStore {
  const fail = async (): Promise<never> => {
    throw make();
  };
  return {
    getDecayClock: fail,
    setDecayClock: fail,
    getActivitySeq: fail,
    getDefaultHalfLifeRecalls: fail,
    hasSubjectActivityCounters: fail,
    getSubjectActivitySeqs: fail,
    getTaxonomyMode: fail,
    setTaxonomyMode: fail,
  } as unknown as TenantSettingsStore;
}

const HELPERS: Record<string, (store: TenantSettingsStore) => Promise<unknown>> = {
  readDecayClock: (s) => readDecayClock(s, ctx),
  readActivitySeq: (s) => readActivitySeq(s, ctx),
  readDefaultHalfLifeRecalls: (s) => readDefaultHalfLifeRecalls(s, ctx),
  readHasSubjectActivityCounters: (s) => readHasSubjectActivityCounters(s, ctx),
  readSubjectActivitySeqs: (s) => readSubjectActivitySeqs(s, ctx, ["alice"]),
  readSubjectActivitySeq: (s) => readSubjectActivitySeq(s, ctx, "alice"),
  writeDecayClock: (s) => writeDecayClock(s, ctx, "activity"),
  readTaxonomyMode: (s) => readTaxonomyMode(s, ctx),
  writeTaxonomyMode: (s) => writeTaxonomyMode(s, ctx, "strict"),
};

function publicHelpersFromSnapshot(): string[] {
  const path = fileURLToPath(
    new URL("../../../../scripts/__snapshots__/public-api/core.d.ts", import.meta.url),
  );
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/^export declare function (\w+)\(store: TenantSettingsStore\b/gm)]
    .map((m) => m[1] as string)
    .sort();
}

function messagesOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message, current.stack ?? "");
    current = current.cause;
  }
  return parts.join("\n");
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error("reject するはずだった");
}

describe("TenantSettingsStore を取る公開ヘルパーが投げる例外に、params が載らない（ADR 0437）", () => {
  it("公開 API の snapshot にある『第1引数が TenantSettingsStore の公開関数』は、この表の9本と一致する", () => {
    const fromSnapshot = publicHelpersFromSnapshot();
    expect(fromSnapshot).toHaveLength(9);
    expect(fromSnapshot).toEqual(Object.keys(HELPERS).sort());
  });

  for (const [name, call] of Object.entries(HELPERS)) {
    it(`${name}: store が drizzle 形の例外を投げても、message・stack・cause に params が載らない`, async () => {
      const error = await rejectionOf(call(throwingStore()));
      const text = messagesOf(error);
      expect(text).toContain("Failed query: SELECT 1 FROM tenant_settings");
      expect(text).not.toContain("SECRET");
      expect(text).toMatch(/params: \(omitted by mnemora, \d+ chars\)/);
    });
  }

  // stack ではなく message を見る。stack は params を落とす前の文面から作られた先頭の行を持つので、message を最初の
  // 改行で切っても、上のループ（message と stack を連結して見る）は緑のままになる。
  const MULTILINE_SQL = "Failed query: SELECT 1\n  FROM tenant_settings\n WHERE tenant_id = $1";

  for (const [name, call] of Object.entries(HELPERS)) {
    it(`${name}: params を落としても message は切られない（複数行の SQL の文が message にそのまま残る）`, async () => {
      const error = await rejectionOf(
        call(
          throwingStore(
            () =>
              new Error(`${MULTILINE_SQL}\nparams: ${SECRET}`, {
                cause: new Error(`${MULTILINE_SQL}\nparams: ${SECRET}`),
              }),
          ),
        ),
      );
      const expected = `${MULTILINE_SQL}\nparams: (omitted by mnemora, ${SECRET.length} chars)`;
      expect((error as Error).message).toBe(expected);
      expect(((error as Error).cause as Error).message).toBe(expected);
    });
  }

  it("陽性対照（やりすぎ）: params の無い message・独自の欄は書き換えない（同じ例外オブジェクトのまま）", async () => {
    const original = Object.assign(new Error("connection terminated"), { kind: "custom" });
    const error = await rejectionOf(
      readDecayClock(
        throwingStore(() => original),
        ctx,
      ),
    );
    expect(error).toBe(original);
    expect((error as Error).message).toBe("connection terminated");
    expect((error as { kind?: string }).kind).toBe("custom");
  });

  it("陽性対照（やりすぎ）: 『未実装』の明示の失敗は、今までの message のまま", async () => {
    const bare = {} as unknown as TenantSettingsStore;
    const w1 = await rejectionOf(writeDecayClock(bare, ctx, "activity"));
    expect((w1 as Error).message).toBe(DECAY_CLOCK_UNSUPPORTED_MESSAGE);
    const w2 = await rejectionOf(writeTaxonomyMode(bare, ctx, "strict"));
    expect((w2 as Error).message).toBe(TAXONOMY_MODE_UNSUPPORTED_MESSAGE);
  });

  it("陽性対照（やりすぎ）: 成功したときの値は変えない", async () => {
    const ok = {
      getDecayClock: async () => "activity",
      getSubjectActivitySeqs: async () => ({ alice: 3 }),
    } as unknown as TenantSettingsStore;
    expect(await readDecayClock(ok, ctx)).toBe("activity");
    expect(await readSubjectActivitySeq(ok, ctx, "alice")).toBe(3);
  });
});
