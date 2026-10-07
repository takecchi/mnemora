import { describe, expect, it } from "vitest";
import type {
  ClaimOutboxJobsOptions,
  Ctx,
  MemoryEvent,
  MemoryStore,
  NewMemory,
  NewMemoryEvent,
  OutboxJobRecord,
} from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";

export interface LoneSurrogateKit {
  store: MemoryStore;
  jsonbRejectsLoneSurrogate: boolean;
  listEvents(ctx: Ctx): Promise<MemoryEvent[]>;
  claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]>;
  searchByLabels?(
    ctx: Ctx,
    memoryId: string,
    labels: string[],
  ): Promise<{ vector: string[]; lexical: string[] }>;
}

export const LEXICAL_PROBE = {
  content: "obsidian shards glimmer in the cave",
  query: "obsidian shards",
};

const CTX: Ctx = { tenantId: "lone-fffd" };

export const LONE_CASES: ReadonlyArray<readonly [label: string, input: string, expected: string]> =
  [
    ["孤立した上位サロゲート（後ろに文字）", "a\uD800b", "a�b"],
    ["孤立した上位サロゲート（末尾）", "ab\uD83D", "ab�"],
    ["孤立した下位サロゲート", "a\uDC00b", "a�b"],
    ["逆順のサロゲート（1単位ずつ置き換わる）", "x\uDC00\uD800y", "x��y"],
    ["上位サロゲートが2つ続く", "\uD800\uD800", "��"],
  ];

export const UNCHANGED_CASES: ReadonlyArray<readonly [label: string, value: string]> = [
  ["対をなすサロゲート（絵文字）", "ok-\u{1F600}-ok"],
  ["対をなすサロゲートの直後に孤立（絵文字は残る）", "\u{1F600}"],
  ["普通の文字列", "plain text 日本語"],
  ["U+FFFD そのもの", "a�b"],
  ["空文字", ""],
];

let counter = 0;
function mem(over: Partial<NewMemory> = {}): NewMemory {
  counter += 1;
  return buildNewMemoryFixture({
    tenantId: CTX.tenantId,
    contentHash: `lone-fffd-${counter}`,
    ...over,
  });
}

function ev(memoryId: string, digestSnapshot: string): NewMemoryEvent {
  return {
    tenantId: CTX.tenantId,
    memoryId,
    kind: "created",
    actor: { type: "system" },
    digestSnapshot,
    meta: {},
  };
}

export function describeLoneSurrogateFffd(
  name: string,
  makeKit: () => Promise<LoneSurrogateKit>,
): void {
  describe(`孤立サロゲートは U+FFFD に置き換わる（ADR 0543）: ${name}`, () => {
    describe.each(LONE_CASES)("%s", (_label, input, expected) => {
      it("createMemory の content・digest・tags・contentHash・extractorVersion・claimKey が置き換わって返り、get でも同じ", async () => {
        const { store } = await makeKit();
        const m = await store.createMemory(
          CTX,
          mem({
            content: input,
            digest: input,
            tags: [input],
            extractorVersion: input,
            claimKey: { subject: input, predicate: input },
          }),
        );
        expect(m.content).toBe(expected);
        expect(m.digest).toBe(expected);
        expect(m.tags).toEqual([expected]);
        expect(m.extractorVersion).toBe(expected);
        expect(m.claimKey).toEqual({ subject: expected, predicate: expected });
        const got = await store.get(CTX, m.id);
        expect(got?.content).toBe(expected);
        expect(got?.digest).toBe(expected);
        expect(got?.tags).toEqual([expected]);
        expect(got?.extractorVersion).toBe(expected);
        expect(got?.claimKey).toEqual({ subject: expected, predicate: expected });
      });

      it("contentHash が置き換わって返る", async () => {
        const { store } = await makeKit();
        const m = await store.createMemory(CTX, mem({ contentHash: `h-${input}` }));
        expect(m.contentHash).toBe(`h-${expected}`);
      });

      it("createObservation の kind が置き換わって返り、getObservation でも同じ", async () => {
        const { store } = await makeKit();
        const o = await store.createObservation(
          CTX,
          buildNewObservationFixture({ tenantId: CTX.tenantId, kind: input }),
        );
        expect(o.kind).toBe(expected);
        expect((await store.getObservation(CTX, o.id))?.kind).toBe(expected);
      });

      it("registerLabel の name が置き換わって返り、listLabels でも同じ", async () => {
        const { store } = await makeKit();
        const l = await store.registerLabel!(CTX, input);
        expect(l.name).toBe(expected);
        expect((await store.listLabels!(CTX)).map((x) => x.name)).toContain(expected);
      });

      it("イベントの digestSnapshot が置き換わる（updateStatusWithEvent・purgeMemory の event）", async () => {
        const { store, listEvents } = await makeKit();
        const m = await store.createMemory(CTX, mem());
        const r = await store.updateStatusWithEvent(CTX, m.id, "forgotten", {}, ev(m.id, input));
        expect(r.event.digestSnapshot).toBe(expected);
        expect((await listEvents(CTX)).map((e) => e.digestSnapshot)).toEqual([expected]);
      });

      it("createMemoryWithOutbox・createMemoriesWithOutboxAndEvents（実装していれば）・supersedeWithNewMemories（実装していれば）の新しい行も置き換わる", async () => {
        const { store } = await makeKit();
        const viaOutbox = await store.createMemoryWithOutbox(CTX, mem({ content: input }), []);
        expect(viaOutbox.memory.content).toBe(expected);
        if (store.createMemoriesWithOutboxAndEvents !== undefined) {
          const r = await store.createMemoriesWithOutboxAndEvents(
            CTX,
            [{ input: mem({ content: input, tags: [input] }), jobKinds: [] }],
            (m) => ev(m.id, input),
          );
          expect(r.written[0]?.memory.content).toBe(expected);
          expect(r.written[0]?.memory.tags).toEqual([expected]);
        }
        if (store.supersedeWithNewMemories !== undefined) {
          const old = await store.createMemory(CTX, mem());
          const r = await store.supersedeWithNewMemories(
            CTX,
            [{ input: mem({ digest: input }), jobKinds: [] }],
            [{ id: old.id, supersededByIndex: 0, event: ev(old.id, input) }],
          );
          expect(r.created[0]?.memory.digest).toBe(expected);
          expect(r.superseded.map((e) => e.digestSnapshot)).toEqual([expected]);
        }
      });

      it("outbox の jobKinds・claimedBy が置き換わる（createObservationWithOutbox）", async () => {
        const { store } = await makeKit();
        const r = await store.createObservationWithOutbox(
          CTX,
          buildNewObservationFixture({ tenantId: CTX.tenantId }),
          [input],
          { claimedBy: input },
        );
        expect(r.jobs.map((j) => j.kind)).toEqual([expected]);
        for (const j of r.jobs) {
          if (j.claimedBy != null) expect(j.claimedBy).toBe(expected);
        }
      });

      it("OutboxStore.claimBatch の kinds（絞り）・claimedBy（書く値）も置き換わる", async () => {
        for (const probe of [input, expected]) {
          const { store: s2, claimBatch: claim2 } = await makeKit();
          await s2.createMemoryWithOutbox(CTX, mem(), [input]);
          const jobs = await claim2(CTX, {
            kinds: [probe],
            limit: 10,
            now: new Date(Date.now() + 86_400_000),
            claimedBy: input,
            leaseMs: 60_000,
          });
          expect(
            jobs.map((j) => j.kind),
            `kinds probe=${JSON.stringify(probe)}`,
          ).toEqual([expected]);
          expect(jobs.map((j) => j.claimedBy)).toEqual([expected]);
        }
      });

      it("purgeMemory の墓石の content・digest が置き換わる", async () => {
        const { store } = await makeKit();
        const m = await store.createMemory(CTX, mem({ status: "forgotten" }));
        const r = await store.purgeMemory!(
          CTX,
          m.id,
          { content: input, digest: input },
          ev(m.id, "x"),
        );
        expect(r.memory.content).toBe(expected);
        expect(r.memory.digest).toBe(expected);
      });

      it("読み取りの引数も同じく置き換わる: claimKey（findActiveByClaimKey）・extractorVersion（listBySourceObservation）・labels（aggregateScope）", async () => {
        const { store } = await makeKit();
        const obs = await store.createObservation(
          CTX,
          buildNewObservationFixture({ tenantId: CTX.tenantId }),
        );
        const m = await store.createMemory(
          CTX,
          mem({
            sourceObservationId: obs.id,
            provenance: {
              kind: "stated",
              sourceObservationId: obs.id,
              at: "2026-01-01T00:00:00.000Z",
            },
            extractorVersion: input,
            tags: [input],
            claimKey: { subject: input, predicate: input },
          }),
        );
        for (const probe of [input, expected]) {
          const hits = await store.findActiveByClaimKey!(CTX, {
            subjectId: null,
            claimKey: { subject: probe, predicate: probe },
            excludeMemoryId: "00000000-0000-4000-8000-000000000000",
            contentHash: "no-such-hash",
            validFrom: null,
            validUntil: null,
          });
          expect(
            hits.map((h) => h.id),
            `claimKey probe=${JSON.stringify(probe)}`,
          ).toEqual([m.id]);
          const listed = await store.listBySourceObservation(CTX, obs.id, probe);
          expect(
            listed.map((h) => h.id),
            `extractorVersion probe=${JSON.stringify(probe)}`,
          ).toEqual([m.id]);
          const agg = await store.aggregateScope(CTX, { labels: [probe] });
          expect(agg.totalInScope, `labels probe=${JSON.stringify(probe)}`).toBe(1);
        }
      });
      it("読み取りの引数も同じく置き換わる（続き）: claimKey（findContestedByClaimKey）・taxonomyGroupCandidates（aggregateScope）", async () => {
        const { store } = await makeKit();
        const other = await store.createMemory(CTX, mem());
        const m = await store.createMemory(
          CTX,
          mem({
            status: "contested",
            contestedWithId: other.id,
            tags: [input],
            claimKey: { subject: input, predicate: input },
          }),
        );
        for (const probe of [input, expected]) {
          if (store.findContestedByClaimKey !== undefined) {
            const hits = await store.findContestedByClaimKey(CTX, {
              subjectId: null,
              claimKey: { subject: probe, predicate: probe },
              excludeMemoryId: "00000000-0000-4000-8000-000000000000",
              contentHash: "no-such-hash",
              validFrom: null,
              validUntil: null,
            });
            expect(
              hits.map((h) => h.id),
              `findContestedByClaimKey probe=${JSON.stringify(probe)}`,
            ).toEqual([m.id]);
          }
          const agg = await store.aggregateScope(CTX, { taxonomyGroupCandidates: [probe] });
          const tax = agg.groups.filter((g) => g.axis === "taxonomy" && g.key !== null);
          expect(
            tax.map((g) => [g.key, g.count]),
            `taxonomyGroupCandidates probe=${JSON.stringify(probe)}`,
          ).toEqual([[expected, 1]]);
        }
      });
      it("読み取りの引数 contentHash（findActiveByClaimKey・findContestedByClaimKey の `content_hash <>`）も置き換えてから比べる: 保存側と同じ値は除外され、別の値だけが当たる", async () => {
        const { store } = await makeKit();
        const claimKey = { subject: "s-hash", predicate: "p-hash" };
        const other = await store.createMemory(CTX, mem());
        const active = await store.createMemory(
          CTX,
          mem({ contentHash: `h-${input}`, claimKey: { ...claimKey, subject: "s-active" } }),
        );
        await store.createMemory(
          CTX,
          mem({
            contentHash: `h-${input}`,
            status: "contested",
            contestedWithId: other.id,
            claimKey: { ...claimKey, subject: "s-contested" },
          }),
        );
        expect(active.contentHash).toBe(`h-${expected}`);
        const find = async (
          kind: "active" | "contested",
          contentHash: string,
        ): Promise<boolean> => {
          const q = {
            subjectId: null,
            claimKey: { ...claimKey, subject: kind === "active" ? "s-active" : "s-contested" },
            excludeMemoryId: "00000000-0000-4000-8000-000000000000",
            contentHash,
            validFrom: null,
            validUntil: null,
          };
          const hits =
            kind === "active"
              ? await store.findActiveByClaimKey!(CTX, q)
              : await store.findContestedByClaimKey!(CTX, q);
          return hits.length > 0;
        };
        const observed = {
          activeRaw: await find("active", `h-${input}`),
          activeReplaced: await find("active", `h-${expected}`),
          activeDifferent: await find("active", "h-different"),
          contestedRaw: await find("contested", `h-${input}`),
          contestedReplaced: await find("contested", `h-${expected}`),
          contestedDifferent: await find("contested", "h-different"),
        };
        expect(observed).toEqual({
          activeRaw: false,
          activeReplaced: false,
          activeDifferent: true,
          contestedRaw: false,
          contestedReplaced: false,
          contestedDifferent: true,
        });
      });
      it("VectorStore.search・LexicalStore.search の filter.labels も置き換わる（保存側の tags と同じ規則）", async () => {
        const { store, searchByLabels } = await makeKit();
        if (searchByLabels === undefined) return;
        const m = await store.createMemory(
          CTX,
          mem({ content: LEXICAL_PROBE.content, tags: [input] }),
        );
        for (const probe of [input, expected]) {
          const hits = await searchByLabels(CTX, m.id, [probe]);
          expect(hits.vector, `vector labels probe=${JSON.stringify(probe)}`).toEqual([m.id]);
          expect(hits.lexical, `lexical labels probe=${JSON.stringify(probe)}`).toEqual([m.id]);
        }
      });
    });

    describe.each(UNCHANGED_CASES)("対照: %s", (_label, value) => {
      it("変わらない（content・digest・tags・claimKey・kind・label name）", async () => {
        const { store } = await makeKit();
        const digest = value === "" ? "d" : value;
        const claimKey = value === "" ? null : { subject: value, predicate: value };
        const m = await store.createMemory(
          CTX,
          mem({
            content: value,
            digest,
            tags: [value],
            claimKey,
          }),
        );
        expect(m.content).toBe(value);
        expect(m.digest).toBe(digest);
        expect(m.tags).toEqual([value]);
        expect(m.claimKey).toEqual(claimKey);
        const o = await store.createObservation(
          CTX,
          buildNewObservationFixture({ tenantId: CTX.tenantId, kind: value || "k" }),
        );
        expect(o.kind).toBe(value || "k");
        const l = await store.registerLabel!(CTX, value);
        expect(l.name).toBe(value);
      });
    });

    it("孤立サロゲートの異なる2つの tag は、置き換えの後で同じ値に潰れる（Postgres と同じ。区別できない）", async () => {
      const { store } = await makeKit();
      const m = await store.createMemory(CTX, mem({ tags: ["a\uD800b", "a\uDC00b"] }));
      expect(m.tags).toEqual(["a�b", "a�b"]);
    });

    it("対照（対象外）: jsonb 列の欄（attributes・provenance）は置き換えない——断る（Postgres）か、そのまま保持する（IM・Fake）かのどちらかで、U+FFFD にはならない", async () => {
      const { store } = await makeKit();
      const lone = "a\uD800b";
      const viaAttributes = await store.createMemory(CTX, mem({ attributes: { k: lone } })).then(
        (m) => m,
        () => undefined,
      );
      if (viaAttributes !== undefined) expect(viaAttributes.attributes).toEqual({ k: lone });
      const viaProvenance = await store
        .createMemory(CTX, mem({ provenance: { kind: "imported", batchId: lone } }))
        .then(
          (m) => m,
          () => undefined,
        );
      if (viaProvenance !== undefined) {
        expect(viaProvenance.provenance).toEqual({ kind: "imported", batchId: lone });
      }
    });

    it("対照（対象外・S2）: Observation の payload（jsonb。observe の口）は置き換えない——Postgres は断り、InMemory・Fake はそのまま保持する", async () => {
      const kit = await makeKit();
      const { store } = kit;
      const lone = "a\uD800b";
      const viaCreate = await store
        .createObservation(
          CTX,
          buildNewObservationFixture({ tenantId: CTX.tenantId, payload: { text: lone } }),
        )
        .then(
          (o) => o,
          () => undefined,
        );
      const viaOutbox = await store
        .createObservationWithOutbox(
          CTX,
          buildNewObservationFixture({
            tenantId: CTX.tenantId,
            payload: { nested: [{ text: lone }] },
          }),
          [],
        )
        .then(
          (r) => r.observation,
          () => undefined,
        );
      if (kit.jsonbRejectsLoneSurrogate) {
        expect(viaCreate).toBeUndefined();
        expect(viaOutbox).toBeUndefined();
      } else {
        expect(viaCreate?.payload).toEqual({ text: lone });
        expect(viaOutbox?.payload).toEqual({ nested: [{ text: lone }] });
        expect((await store.getObservation(CTX, viaCreate!.id))?.payload).toEqual({ text: lone });
      }
    });

    it("対照（対象外・S3）: イベントの actor（jsonb）は置き換えない——3実装とも書く前に断り、U+FFFD で通して保存することも、状態を書き換えることもしない", async () => {
      const { store, listEvents } = await makeKit();
      const lone = "a\uD800b";
      const m = await store.createMemory(CTX, mem());
      const actor = { type: "human", id: lone } as const;
      await expect(
        store.updateStatusWithEvent(CTX, m.id, "forgotten", {}, { ...ev(m.id, "x"), actor }),
      ).rejects.toThrow(/actor/);
      await expect(
        store.updateStatusWithEvent(
          CTX,
          m.id,
          "forgotten",
          {},
          { ...ev(m.id, "x"), meta: { k: lone } },
        ),
      ).rejects.toThrow(/meta/);
      expect(await listEvents(CTX)).toEqual([]);
      expect((await store.get(CTX, m.id))?.status).toBe("active");
    });

    it("入力のオブジェクトは書き換えない（置き換えは保存する値だけ）", async () => {
      const { store } = await makeKit();
      const input = mem({ content: "a\uD800b", tags: ["t\uD800"] });
      await store.createMemory(CTX, input);
      expect(input.content).toBe("a\uD800b");
      expect(input.tags).toEqual(["t\uD800"]);
    });
  });
}
