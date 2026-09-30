import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture, DeterministicLLMProvider } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `Runtime.resolveContested`・`markContested`・`resolveOrphanedContested` が、大文字の id を store の `get` に従って
 * 扱い、イベントの `meta` に載せる id を store の列の値（`@mnemora/postgres` では小文字）と揃えるか
 * （#1324・#1327 の続き）。
 *
 * - `resolveContested`: `getMany` の戻りを渡された id でそのまま引き、`contestedWithId !== otherId`・
 *   `winnerId !== firstId` を文字列で比べていた → `@mnemora/postgres` では在る対を `not_found`・`pair_broken` に
 *   したり、同じ記憶を指す `winnerId` で `RangeError` を投げたりしていた。
 * - `markContested`・`resolveContested` のイベントの `meta.contestedWithId`（と敗者の `meta.supersededById`）は、
 *   渡された id をそのまま載せていた → 大文字で渡すと列の値（小文字）と食い違っていた。
 * - `resolveOrphanedContested`: 生存側も対向も store から読んだ値だけを使い、渡された id と比べる箇所は無い
 *   （確かめの歯。直す前から緑）。
 *
 * testkit の fixture の id は大文字小文字を区別するので、fixture では大文字は今どおり `not_found`・`RangeError`。
 */
afterAll(async () => {
  await closeTestClient();
});

const upper = (id: string) => id.toUpperCase();

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
  caseInsensitive: boolean;
}

const shared = {
  llmProvider: new DeterministicLLMProvider(),
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の fixture",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        caseInsensitive: false,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        eventStore,
        caseInsensitive: true,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          vectorStore: new PostgresVectorStore(db),
          eventStore,
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

describe.each(KITS)(
  "contested の Runtime は大文字の id を store に従って扱う（%s）",
  (_name, makeKit) => {
    const ctx: Ctx = { tenantId: "tenant-upper-contested-runtime" };
    const create = (kit: Kit, contentHash: string) =>
      kit.memoryStore.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash }),
      );
    const contestedPair = async (kit: Kit, prefix: string) => {
      const a = await create(kit, `${prefix}-a`);
      const b = await create(kit, `${prefix}-b`);
      const marked = await kit.runtime.markContested(ctx, a.id, b.id);
      expect(marked.outcome.kind).toBe("contested");
      return { a, b };
    };
    const lastEventMeta = async (kit: Kit, memoryId: string) => {
      const events = await kit.eventStore.list(ctx, { memoryId });
      return events[events.length - 1]!.meta;
    };

    it("markContested: 大文字の id で対にすると、イベントの meta.contestedWithId は store の列の値（相手の id）になる", async () => {
      const kit = await makeKit();
      const a = await create(kit, "mark-a");
      const b = await create(kit, "mark-b");

      const result = await kit.runtime.markContested(ctx, upper(a.id), upper(b.id));

      if (kit.caseInsensitive) {
        expect(result.outcome.kind).toBe("contested");
        const [after, metaA, metaB] = await Promise.all([
          kit.memoryStore.get(ctx, a.id),
          lastEventMeta(kit, a.id),
          lastEventMeta(kit, b.id),
        ]);
        expect(after?.contestedWithId).toBe(b.id);
        expect([metaA.contestedWithId, metaB.contestedWithId]).toEqual([b.id, a.id]);
      } else {
        expect(result.outcome.kind).toBe("ineligible");
      }
    });

    it("resolveContested（both_active）: 大文字の id でも、store が在ると言う対を解決し、meta.contestedWithId は相手の列の値", async () => {
      const kit = await makeKit();
      const { a, b } = await contestedPair(kit, "both");

      const result = await kit.runtime.resolveContested(ctx, upper(a.id), upper(b.id), {
        kind: "both_active",
      });

      if (kit.caseInsensitive) {
        expect(result.outcome.kind).toBe("resolved");
        const [metaA, metaB] = await Promise.all([
          lastEventMeta(kit, a.id),
          lastEventMeta(kit, b.id),
        ]);
        expect([metaA.contestedWithId, metaB.contestedWithId]).toEqual([b.id, a.id]);
      } else {
        expect(result.outcome).toEqual({
          kind: "ineligible",
          sides: [
            { memoryId: upper(a.id), kind: "not_found" },
            { memoryId: upper(b.id), kind: "not_found" },
          ],
        });
      }
    });

    it("resolveContested（supersede）: 大文字の id と大文字の winnerId でも解決し、敗者の meta は勝者の列の値を持つ", async () => {
      const kit = await makeKit();
      const { a, b } = await contestedPair(kit, "sup");

      const result = await kit.runtime.resolveContested(ctx, upper(a.id), upper(b.id), {
        kind: "supersede",
        winnerId: upper(a.id),
      });

      if (kit.caseInsensitive) {
        expect(result.outcome.kind).toBe("resolved");
        const loser = await kit.memoryStore.get(ctx, b.id);
        expect([loser?.status, loser?.supersededById]).toEqual(["superseded", a.id]);
        const metaB = await lastEventMeta(kit, b.id);
        expect([metaB.contestedWithId, metaB.supersededById]).toEqual([a.id, a.id]);
      } else {
        expect(result.outcome.kind).toBe("ineligible");
      }
    });

    it("resolveContested: winnerId が片側と大文字小文字だけ違うとき、store が同じ記憶と言えば勝者として扱う（言わなければ今どおり RangeError）", async () => {
      const kit = await makeKit();
      const { a, b } = await contestedPair(kit, "win");

      const run = () =>
        kit.runtime.resolveContested(ctx, a.id, b.id, { kind: "supersede", winnerId: upper(a.id) });

      if (kit.caseInsensitive) {
        const result = await run();
        expect(result.outcome.kind).toBe("resolved");
        const loser = await kit.memoryStore.get(ctx, b.id);
        expect([loser?.status, loser?.supersededById]).toEqual(["superseded", a.id]);
      } else {
        await expect(run()).rejects.toBeInstanceOf(RangeError);
        expect((await kit.memoryStore.get(ctx, a.id))?.status).toBe("contested");
      }
    });

    it("やりすぎの歯: 小文字の入力の結果は変わらない（解決・meta）", async () => {
      const kit = await makeKit();
      const { a, b } = await contestedPair(kit, "lower");

      const result = await kit.runtime.resolveContested(ctx, a.id, b.id, {
        kind: "supersede",
        winnerId: b.id,
      });

      expect(result.outcome.kind).toBe("resolved");
      const metaA = await lastEventMeta(kit, a.id);
      expect([metaA.contestedWithId, metaA.supersededById]).toEqual([b.id, b.id]);
    });

    it("やりすぎの歯: どちらの側とも違う winnerId は今どおり RangeError（store を読まずに落とす）", async () => {
      const kit = await makeKit();
      const { a, b } = await contestedPair(kit, "bad-winner");

      await expect(
        kit.runtime.resolveContested(ctx, a.id, b.id, {
          kind: "supersede",
          winnerId: "someone-else",
        }),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it("やりすぎの歯: 同じ記憶を小文字と大文字で渡すと、渡された文字列どおりに突き合わせる（今どおり ineligible、投げない）", async () => {
      const kit = await makeKit();
      const { a, b } = await contestedPair(kit, "self");

      const result = await kit.runtime.resolveContested(ctx, a.id, upper(a.id), {
        kind: "both_active",
      });

      expect(result.outcome).toEqual({
        kind: "ineligible",
        sides: [
          { memoryId: a.id, kind: "pair_broken", contestedWithId: b.id },
          { memoryId: upper(a.id), kind: "not_found" },
        ],
      });
    });

    it("やりすぎの歯: 同じ記憶を大文字を先に渡しても、not_found になるのは大文字の側で、どちらの綴りも store の id と違えば両側とも not_found（位置によらない）", async () => {
      const kit = await makeKit();
      const { a, b } = await contestedPair(kit, "self-order");
      const capitalized = a.id.replace(/[a-z]/, (c) => c.toUpperCase());
      expect([capitalized === a.id, capitalized === upper(a.id)]).toEqual([false, false]);

      const upperFirst = await kit.runtime.resolveContested(ctx, upper(a.id), a.id, {
        kind: "both_active",
      });
      const noExact = await kit.runtime.resolveContested(ctx, capitalized, upper(a.id), {
        kind: "both_active",
      });

      expect(upperFirst.outcome).toEqual({
        kind: "ineligible",
        sides: [
          { memoryId: upper(a.id), kind: "not_found" },
          { memoryId: a.id, kind: "pair_broken", contestedWithId: b.id },
        ],
      });
      expect(noExact.outcome).toEqual({
        kind: "ineligible",
        sides: [
          { memoryId: capitalized, kind: "not_found" },
          { memoryId: upper(a.id), kind: "not_found" },
        ],
      });
      const statuses = [
        (await kit.memoryStore.get(ctx, a.id))?.status,
        (await kit.memoryStore.get(ctx, b.id))?.status,
      ];
      expect(statuses).toEqual(["contested", "contested"]);
    });

    it("確かめ: resolveOrphanedContested は大文字の id でも store が在ると言う生存側を解決し、meta.contestedWithId は列の値", async () => {
      const kit = await makeKit();
      const { a, b } = await contestedPair(kit, "orphan");
      await kit.runtime.forget(ctx, { memoryIds: [b.id] });

      const result = await kit.runtime.resolveOrphanedContested!(ctx, upper(a.id));

      if (kit.caseInsensitive) {
        expect(result.outcome.kind).toBe("resolved");
        expect((await lastEventMeta(kit, a.id)).contestedWithId).toBe(b.id);
      } else {
        expect(result.outcome).toEqual({
          kind: "ineligible",
          eligibility: { kind: "not_found" },
        });
      }
    });

    // Issue #1449 項目6: 群版 `resolveContestedGroup` の winnerId も、2者版と同じ規則で大文字小文字を救済する
    // （一致しなければ小文字化で memberIds から候補を集め、ちょうど1件かつ store の `get` が同じ記憶と言うときだけ、
    // その memberId の綴りを勝者として使う）。
    const contestedTrio = async (kit: Kit, prefix: string) => {
      const a = await create(kit, `${prefix}-a`);
      const b = await create(kit, `${prefix}-b`);
      const c = await create(kit, `${prefix}-c`);
      const marked = await kit.runtime.markContestedGroup!(ctx, [a.id, b.id, c.id]);
      expect(marked.outcome.kind).toBe("contested_group");
      return { a, b, c };
    };

    it("resolveContestedGroup（supersede）: 大文字の winnerId でも、store が同じ記憶と言えば通り、敗者の supersededById は列の値（小文字）", async () => {
      const kit = await makeKit();
      const { a, b, c } = await contestedTrio(kit, "grp-win");

      const run = () =>
        kit.runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
          kind: "supersede",
          winnerId: upper(a.id),
        });

      if (kit.caseInsensitive) {
        const result = await run();
        expect(result.outcome.kind).toBe("resolved");
        const [sa, sb, sc] = await Promise.all(
          [a.id, b.id, c.id].map((id) => kit.memoryStore.get(ctx, id)),
        );
        expect([sa?.status, sb?.status, sc?.status]).toEqual([
          "active",
          "superseded",
          "superseded",
        ]);
        expect([sb?.supersededById, sc?.supersededById]).toEqual([a.id, a.id]);
        // 敗者のイベントの meta.supersededById も同じ値（ADR 0150 追記・ADR 0421）。
        const metaB = await lastEventMeta(kit, b.id);
        const metaC = await lastEventMeta(kit, c.id);
        expect([metaB.supersededById, metaC.supersededById]).toEqual([a.id, a.id]);
      } else {
        await expect(run()).rejects.toBeInstanceOf(RangeError);
        expect((await kit.memoryStore.get(ctx, a.id))?.status).toBe("contested");
      }
    });

    it("やりすぎの歯（群）: 小文字の winnerId の結果は変わらない", async () => {
      const kit = await makeKit();
      const { a, b, c } = await contestedTrio(kit, "grp-lower");

      const result = await kit.runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
        kind: "supersede",
        winnerId: c.id,
      });

      expect(result.outcome.kind).toBe("resolved");
      const [sa, sc] = await Promise.all([a.id, c.id].map((id) => kit.memoryStore.get(ctx, id)));
      expect([sa?.status, sa?.supersededById, sc?.status]).toEqual(["superseded", c.id, "active"]);
    });

    it("やりすぎの歯（群）: どの member とも違う winnerId は今どおり RangeError（何も書かない）", async () => {
      const kit = await makeKit();
      const { a, b, c } = await contestedTrio(kit, "grp-bad");

      await expect(
        kit.runtime.resolveContestedGroup!(ctx, [a.id, b.id, c.id], {
          kind: "supersede",
          winnerId: "someone-else",
        }),
      ).rejects.toBeInstanceOf(RangeError);
      const statuses = await Promise.all(
        [a.id, b.id, c.id].map(async (id) => (await kit.memoryStore.get(ctx, id))?.status),
      );
      expect(statuses).toEqual(["contested", "contested", "contested"]);
    });

    it("やりすぎの歯（群）: 大文字小文字だけ違う候補が2件以上あるとき（memberIds に同じ記憶の2つの綴り）は救済しない", async () => {
      const kit = await makeKit();
      const { a, b, c } = await contestedTrio(kit, "grp-ambiguous");
      const capitalized = a.id.replace(/[a-z]/, (ch) => ch.toUpperCase());
      expect(capitalized).not.toBe(a.id);

      // memberIds は文字列として重複していないので入口は通るが、勝者の綴りに合う候補が2件ある。
      await expect(
        kit.runtime.resolveContestedGroup!(ctx, [a.id, upper(a.id), b.id, c.id], {
          kind: "supersede",
          winnerId: capitalized,
        }),
      ).rejects.toBeInstanceOf(RangeError);
      const statuses = await Promise.all(
        [a.id, b.id, c.id].map(async (id) => (await kit.memoryStore.get(ctx, id))?.status),
      );
      expect(statuses).toEqual(["contested", "contested", "contested"]);
    });
  },
);
