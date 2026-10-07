// 孤立サロゲートは扱わない（`jsonb` 列では Postgres が例外にし、`text` 列では U+FFFD に置き換えるので、揃える向きが決まっていない）。

import { describe, expect, it } from "vitest";
import type { Ctx, NewObservation } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const ctx: Ctx = { tenantId: "tenant-1" };

function observation(overrides: Partial<NewObservation> = {}): NewObservation {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    externalId: null,
    kind: "utterance",
    payload: { text: "こんにちは" },
    occurredAt: null,
    validFrom: null,
    validUntil: null,
    attributes: {},
    ...overrides,
  };
}

const NUL_OBSERVATIONS: [label: string, overrides: Partial<NewObservation>][] = [
  ["subjectId", { subjectId: "subject\u0000" }],
  ["externalId", { externalId: "ext\u0000" }],
  ["kind", { kind: "utterance\u0000" }],
  ["payload の値", { payload: { text: "a\u0000b" } }],
  ["payload のキー", { payload: { "te\u0000xt": "a" } }],
  ["payload の入れ子", { payload: { name: "n", data: { deep: ["ok", { v: "a\u0000" }] } } }],
  ["attributes の値", { attributes: { k: "a\u0000b" } }],
];

describe("InMemoryMemoryStore: Observation の口は、NUL を含む値を Postgres と同じく拒み、何も書かない", () => {
  for (const [label, overrides] of NUL_OBSERVATIONS) {
    it(`createObservationWithOutbox: ${label} に NUL → 例外、Observation も extract ジョブも増えない`, async () => {
      const store = new InMemoryMemoryStore();
      await expect(
        store.createObservationWithOutbox(ctx, observation(overrides), ["extract"]),
      ).rejects.toThrow(/must not contain NUL characters|contains a NUL character/);
      expect(store.outboxJobs).toHaveLength(0);
    });

    it(`createObservation: ${label} に NUL → 例外`, async () => {
      const store = new InMemoryMemoryStore();
      await expect(store.createObservation(ctx, observation(overrides))).rejects.toThrow(
        /must not contain NUL characters|contains a NUL character/,
      );
    });
  }

  it("同じ externalId の Observation が既に在っても、NUL を含む再送は例外になる（Postgres はクエリの時点で拒む）", async () => {
    const store = new InMemoryMemoryStore();
    await store.createObservation(ctx, observation({ externalId: "ext-1" }));
    await expect(
      store.createObservation(
        ctx,
        observation({ externalId: "ext-1", payload: { text: "\u0000" } }),
      ),
    ).rejects.toThrow(/must not contain NUL characters/);
  });

  it("NUL でない値は、これまでどおり受け入れる（回帰確認: 結合文字・ZWJ・RTL・異体字セレクタ・文字どおりの \\u0000）", async () => {
    const store = new InMemoryMemoryStore();
    const text = "é 👨‍👩‍👧 שלום 葛\u{E0100} \\u0000";
    const created = await store.createObservation(
      ctx,
      observation({ payload: { text }, attributes: { k: text } }),
    );
    const got = await store.getObservation(ctx, created.id);
    expect(got?.payload).toEqual({ text });
    expect(got?.attributes).toEqual({ k: text });
  });

  // jsonb の判定は `JSON.stringify` した結果を辿る（Postgres が受け取る形）ので、`toJSON` による変換も同じ形になる。
  it("toJSON が NUL を返す値は拒む（元の値には NUL が無くても、Postgres が受け取る JSON に NUL がある）", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createObservation(
        ctx,
        observation({ payload: { toJSON: () => ({ text: "a\u0000b" }) } as never }),
      ),
    ).rejects.toThrow(/payload must not contain NUL characters/);
    await expect(
      store.createObservation(
        ctx,
        observation({ attributes: { toJSON: () => ({ k: "a\u0000" }) } as never }),
      ),
    ).rejects.toThrow(/attributes must not contain NUL characters/);
  });

  it("元の値に NUL があっても、toJSON が消すなら通す（Postgres が受け取る JSON に NUL が無い）", async () => {
    const store = new InMemoryMemoryStore();
    const created = await store.createObservation(
      ctx,
      observation({ payload: { text: "a\u0000b", toJSON: () => ({ text: "ok" }) } as never }),
    );
    expect(created.payload).toEqual({ text: "ok" });
  });
});

describe("InMemoryMemoryStore.createMemory: jsonb 列（attributes・provenance）の NUL を Postgres と同じく拒む", () => {
  it("attributes の値に NUL → 例外", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, attributes: { k: "a\u0000" } }),
      ),
    ).rejects.toThrow(/attributes must not contain NUL characters/);
  });

  it("provenance の値に NUL → 例外", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          provenance: { kind: "imported", batchId: "b\u0000" },
        }),
      ),
    ).rejects.toThrow(/provenance must not contain NUL characters/);
  });
});
