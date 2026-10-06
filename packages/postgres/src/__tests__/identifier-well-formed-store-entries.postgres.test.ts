import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewRecallRecord } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の歯。PR #1520（ADR 0423）の変異試験で、Postgres の
 * `aggregateScope`（`scope.subjectId`）・`listActiveClaimPredicates`（`query.subjectId`）・`createRecall`
 * （`record.subjectId`）が識別子の入口検査を外してもすり抜けた。担当はクローン（miku）の判断で進めている作業であり、
 * オーナーの判断ではない。
 * PR 本文が「store の各メソッドは1つずつは確かめていない（conformance は代表の口）」と書いていた通りの穴で、
 * ADR 0423 決定2は、識別子を入力に持つ口を全部、書き込みより前に断ると決めている。同じ型の
 * `findActiveByClaimKey`・`findContestedByClaimKey`・`createMemoryWithOutbox` も、同じ表で見る。
 * `memory-store-conformance.ts` には足さない（公開の適合テストは触らない）。
 *
 * 断る対象: 孤立サロゲートと NUL を含む識別子（`kind: "malformed_identifier"`、message に入力値を入れない）。
 * 対をなすサロゲート（絵文字）は受け付ける（陽性対照）。
 */

const ctx: Ctx = { tenantId: "identifier-well-formed-store-entries" };

const MALFORMED: ReadonlyArray<readonly [label: string, value: string]> = [
  ["孤立した上位サロゲート", "id-\uD800"],
  ["孤立した下位サロゲート", "id-\uDC00"],
  ["NUL", "id-\u0000"],
];
const WELL_FORMED_NON_BMP = "id-\u{1F600}";
const SOME_ID = "00000000-0000-4000-8000-000000000001" as MemoryId;

function newRecallRecord(subjectId: string | null): NewRecallRecord {
  return {
    tenantId: ctx.tenantId,
    subjectId,
    query: { text: "q" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
  };
}

const claimQuery = (subjectId: string) => ({
  subjectId,
  claimKey: { subject: "user", predicate: "favorite_color" },
  excludeMemoryId: SOME_ID,
  contentHash: "h",
  validFrom: null,
  validUntil: null,
});

interface Entry {
  name: string;
  call: (store: PostgresMemoryStore, subjectId: string) => Promise<unknown>;
}

const ENTRIES: Entry[] = [
  {
    name: "aggregateScope（scope.subjectId）",
    call: (s, v) => s.aggregateScope(ctx, { subjectId: v }),
  },
  {
    name: "listActiveClaimPredicates（query.subjectId）",
    call: (s, v) => s.listActiveClaimPredicates(ctx, { subjectId: v, limit: 5 }),
  },
  {
    name: "createRecall（record.subjectId）",
    call: (s, v) => s.createRecall(ctx, newRecallRecord(v)),
  },
  {
    name: "findActiveByClaimKey（query.subjectId）",
    call: (s, v) => s.findActiveByClaimKey(ctx, claimQuery(v)),
  },
  {
    name: "findContestedByClaimKey（query.subjectId）",
    call: (s, v) => s.findContestedByClaimKey(ctx, claimQuery(v)),
  },
  {
    name: "createMemoryWithOutbox（input.subjectId）",
    call: (s, v) =>
      s.createMemoryWithOutbox(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          subjectId: v,
          contentHash: `identifier-entries-${Math.random()}`,
        }),
        [],
      ),
  },
];

describe("PostgresMemoryStore: 識別子（subjectId）を入力に持つ口は、孤立サロゲート・NUL を入口で断る（ADR 0423 決定2、Issue #1734 / PR #1520 のすり抜け）", () => {
  let store: PostgresMemoryStore;

  beforeEach(async () => {
    const client = await getTestClient();
    store = new PostgresMemoryStore(client.db);
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestClient();
  });

  describe.each(ENTRIES)("$name", ({ call }) => {
    it.each(MALFORMED)(
      "%s は MalformedIdentifierError で断り、message に入力値を入れない",
      async (_label, value) => {
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
      },
    );

    it("陽性対照: 対をなすサロゲート（絵文字）は断らない（探り棒が生きている）", async () => {
      let reason: unknown;
      try {
        await call(store, WELL_FORMED_NON_BMP);
      } catch (error) {
        reason = error;
      }
      expect((reason as { kind?: unknown } | undefined)?.kind).not.toBe("malformed_identifier");
    });
  });
});
