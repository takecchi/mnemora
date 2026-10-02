import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  Memory,
  MemoryStore,
  NewMemory,
  Runtime,
  StructuredRequest,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryRelationStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  TEST_EMBEDDING_SPACE,
  closeTestClient,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * ADR 0539（ADR 0536 の「次の候補」の3つ目）: claim key と矛盾の検出の読み口と、`observe` で claim key を有効にした経路を、
 * **実 Postgres と InMemory の両方**で `EXPECTED` に突き合わせる。core の Fake の側は `packages/core/src/__tests__/fake-claim-key-parity.test.ts` が
 * 同じ `EXPECTED` を縛る。DB はファイル冒頭で作り直し、tenant はこのファイル専用の名前を使う。
 */
interface Env {
  runtime: Runtime;
  mem: MemoryStore;
  fresh: () => Ctx;
  /** 記憶を1件作る（`over` で `claimKey`・`subjectId`・有効期間・`contentHash` を渡す）。 */
  mk: (ctx: Ctx, tag: string, over: Partial<NewMemory>) => Promise<Memory>;
  /** 抽出の LLM と claim key の導出の LLM が次の `observe` で返す値。 */
  setNext: (content: string, claim: { subject: string; predicate: string }) => void;
}

type Result = Record<string, unknown>;

/**
 * ADR 0539（ADR 0536 の「次の候補」の3つ目）: claim key と矛盾の検出の読み口を3者（core の Fake・testkit の InMemory・Postgres）に流す。
 * (1) store の口（`findActiveByClaimKey`・`findContestedByClaimKey`・`listActiveClaimPredicates`）に同じ記憶と同じ問い合わせを直接。
 * (2) `observe` で claim key を有効にした経路（`detectContested`）。
 * 契約（`MemoryStore.findActiveByClaimKey?` の TSDoc）: 鍵は正規化済みの文字列として**そのまま等値比較**（大文字小文字・空白・Unicode の正規化形を区別する）、
 * `subjectId` は NULL 同士も一致、`active` の行だけ、`excludeMemoryId` と `contentHash` が同じ行は返さない、有効期間は半開区間 `[validFrom, validUntil)`
 * （null は無限）の重なりで、空・逆転した区間は何とも重ならない（問い合わせ側も保存済みの行側も。ADR 0473）、別テナントは見えない。
 */
async function scenario(env: Env): Promise<Result> {
  const { runtime, mem, fresh, mk, setNext } = env;
  const out: Result = {};
  const D = (s: string) => new Date(s);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const NONE = "00000000-0000-4000-8000-000000000000";
  const key = (subject: string, predicate: string) => ({ subject, predicate });

  // ---- (1) store の口 ----
  const ctx = fresh();
  const other = fresh();
  const ids: Record<string, string> = {};
  const add = async (name: string, c: Ctx, over: Partial<NewMemory>) => {
    ids[name] = (await mk(c, name, { contentHash: `hash-${name}`, ...over })).id;
  };
  const K = key("user", "address");
  await add("a1 open", ctx, { claimKey: K, subjectId: "s1" });
  await add("a2 [2020,2022)", ctx, {
    claimKey: K,
    subjectId: "s1",
    validFrom: D("2020-01-01T00:00:00Z"),
    validUntil: D("2022-01-01T00:00:00Z"),
  });
  await add("a3 [2022,2024) touches a2", ctx, {
    claimKey: K,
    subjectId: "s1",
    validFrom: D("2022-01-01T00:00:00Z"),
    validUntil: D("2024-01-01T00:00:00Z"),
  });
  await add("a4 empty [2023,2023)", ctx, {
    claimKey: K,
    subjectId: "s1",
    validFrom: D("2023-01-01T00:00:00Z"),
    validUntil: D("2023-01-01T00:00:00Z"),
  });
  await add("a5 inverted [2026,2025)", ctx, {
    claimKey: K,
    subjectId: "s1",
    validFrom: D("2026-01-01T00:00:00Z"),
    validUntil: D("2025-01-01T00:00:00Z"),
  });
  await add("a6 upper-case key", ctx, { claimKey: key("User", "Address"), subjectId: "s1" });
  await add("a7 trailing space", ctx, { claimKey: key("user ", "address"), subjectId: "s1" });
  await add("a8 subject NFC", ctx, { claimKey: K, subjectId: "café" });
  await add("a9 subject NFD", ctx, { claimKey: K, subjectId: "café" });
  await add("a10 subjectless", ctx, { claimKey: K });
  await add("a11 other subject", ctx, { claimKey: K, subjectId: "s2" });
  await add("a12 key NFC", ctx, { claimKey: key("café", "address"), subjectId: "s1" });
  await add("a13 key NFD", ctx, { claimKey: key("café", "address"), subjectId: "s1" });
  await add("a14 other predicate", ctx, { claimKey: key("user", "job"), subjectId: "s1" });
  await add("a15 no key", ctx, { subjectId: "s1" });
  await add("a16 forgotten", ctx, { claimKey: K, subjectId: "s1" });
  await add("a17 archived", ctx, { claimKey: K, subjectId: "s1" });
  await add("a18 superseded", ctx, { claimKey: K, subjectId: "s1" });
  await add("a19 contested x", ctx, { claimKey: K, subjectId: "s1" });
  await add("a20 contested y", ctx, { claimKey: K, subjectId: "s1" });
  await add("a21 plain active", ctx, { claimKey: K, subjectId: "s1" });
  await add("a22 contested [2030,2032) x", ctx, {
    claimKey: K,
    subjectId: "s1",
    validFrom: D("2030-01-01T00:00:00Z"),
    validUntil: D("2032-01-01T00:00:00Z"),
  });
  await add("a23 contested [2030,2032) y", ctx, {
    claimKey: K,
    subjectId: "s1",
    validFrom: D("2030-01-01T00:00:00Z"),
    validUntil: D("2032-01-01T00:00:00Z"),
  });
  await add("z other tenant", other, { claimKey: K, subjectId: "s1" });
  await mem.updateStatus(ctx, ids["a16 forgotten"]!, "forgotten");
  await mem.updateStatus(ctx, ids["a17 archived"]!, "archived");
  await mem.updateStatus(ctx, ids["a18 superseded"]!, "superseded", {
    supersededById: ids["a1 open"]!,
  });
  const event = (id: string) => ({
    tenantId: ctx.tenantId,
    memoryId: id,
    kind: "updated" as const,
    actor: { type: "system" as const },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
  });
  await mem.markContestedPair!(
    ctx,
    { id: ids["a19 contested x"]!, event: event(ids["a19 contested x"]!) },
    { id: ids["a20 contested y"]!, event: event(ids["a20 contested y"]!) },
  );
  await mem.markContestedPair!(
    ctx,
    { id: ids["a22 contested [2030,2032) x"]!, event: event(ids["a22 contested [2030,2032) x"]!) },
    { id: ids["a23 contested [2030,2032) y"]!, event: event(ids["a23 contested [2030,2032) y"]!) },
  );
  const alias = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? "?";
  const names = (ms: Memory[]) => ms.map((m) => alias(m.id)).sort();
  type Q = {
    subjectId: string | null;
    claimKey: { subject: string; predicate: string };
    excludeMemoryId: string;
    contentHash: string;
    validFrom: Date | null;
    validUntil: Date | null;
  };
  const base: Q = {
    subjectId: "s1",
    claimKey: K,
    excludeMemoryId: NONE,
    contentHash: "hash-query",
    validFrom: null,
    validUntil: null,
  };
  const queries: Array<[string, Partial<Q>, Ctx?]> = [
    ["open interval", {}],
    [
      "[2021,2023)",
      { validFrom: D("2021-01-01T00:00:00Z"), validUntil: D("2023-01-01T00:00:00Z") },
    ],
    ["[2022,null): touching end of a2 does not overlap", { validFrom: D("2022-01-01T00:00:00Z") }],
    [
      "[null,2020): touching start of a2 does not overlap",
      { validUntil: D("2020-01-01T00:00:00Z") },
    ],
    [
      "empty query interval [2022,2022)",
      { validFrom: D("2022-01-01T00:00:00Z"), validUntil: D("2022-01-01T00:00:00Z") },
    ],
    [
      "inverted query interval [2023,2022)",
      { validFrom: D("2023-01-01T00:00:00Z"), validUntil: D("2022-01-01T00:00:00Z") },
    ],
    [
      "[2023,2024): inside a3, at the empty a4",
      { validFrom: D("2023-01-01T00:00:00Z"), validUntil: D("2024-01-01T00:00:00Z") },
    ],
    [
      "[2025,2027): the inverted a5 is never overlapped",
      { validFrom: D("2025-01-01T00:00:00Z"), validUntil: D("2027-01-01T00:00:00Z") },
    ],
    ["subjectless query (null = null)", { subjectId: null }],
    ["subject s2", { subjectId: "s2" }],
    ["subject NFC", { subjectId: "café" }],
    ["subject NFD", { subjectId: "café" }],
    ["upper-case key is a different key", { claimKey: key("User", "Address") }],
    ["trailing space is a different key", { claimKey: key("user ", "address") }],
    ["key NFC", { claimKey: key("café", "address") }],
    ["key NFD", { claimKey: key("café", "address") }],
    ["other predicate", { claimKey: key("user", "job") }],
    [
      "[2031,2033): overlaps only the contested pair a22 a23",
      { validFrom: D("2031-01-01T00:00:00Z"), validUntil: D("2033-01-01T00:00:00Z") },
    ],
    [
      "[2032,null): touches the end of the contested pair",
      { validFrom: D("2032-01-01T00:00:00Z") },
    ],
    ["excludeMemoryId a1", { excludeMemoryId: ids["a1 open"]! }],
    [
      "excludeMemoryId a22 (a contested one)",
      { excludeMemoryId: ids["a22 contested [2030,2032) x"]! },
    ],
    ["contentHash equal to a2's", { contentHash: "hash-a2 [2020,2022)" }],
    [
      "another tenant's id as excludeMemoryId is just unmatched",
      { excludeMemoryId: ids["z other tenant"]! },
    ],
  ];
  for (const [label, over] of queries) {
    const q = { ...base, ...over };
    out[`active: ${label}`] = names(await mem.findActiveByClaimKey!(ctx, q));
    out[`contested: ${label}`] = names(await mem.findContestedByClaimKey!(ctx, q));
  }
  out["active: the other tenant sees only its own"] = names(
    await mem.findActiveByClaimKey!(other, base),
  );

  // listActiveClaimPredicates: 新しい順・重複なし・active だけ・subject（null 同士）・limit・他テナント
  const lp = fresh();
  const lpOther = fresh();
  const addP = async (
    tag: string,
    c: Ctx,
    predicate: string,
    subjectId: string | null,
    status?: "forgotten",
  ) => {
    const m = await mk(c, tag, {
      claimKey: key("user", predicate),
      subjectId,
      contentHash: `hash-lp-${tag}`,
    });
    if (status) await mem.updateStatus(c, m.id, status);
    await sleep(4);
  };
  await addP("p1", lp, "alpha", "s1");
  await addP("p2", lp, "beta", "s1");
  await addP("p3", lp, "gamma", "s1", "forgotten");
  await addP("p4", lp, "alpha", "s1"); // alpha は新しい行で代表される → beta より新しい
  await addP("p5", lp, "delta", null);
  await addP("p6", lp, "eps", "s2");
  await addP("p7", lpOther, "zeta", "s1");
  const nokey = await mk(lp, "no-key", { subjectId: "s1", contentHash: "hash-lp-nokey" });
  void nokey;
  out["predicates: s1, newest first, deduplicated, active only"] =
    await mem.listActiveClaimPredicates!(lp, { subjectId: "s1", limit: 10 });
  out["predicates: s1, limit 1"] = await mem.listActiveClaimPredicates!(lp, {
    subjectId: "s1",
    limit: 1,
  });
  out["predicates: subjectless (null = null)"] = await mem.listActiveClaimPredicates!(lp, {
    subjectId: null,
    limit: 10,
  });
  out["predicates: s2"] = await mem.listActiveClaimPredicates!(lp, { subjectId: "s2", limit: 10 });
  out["predicates: another tenant sees only its own"] = await mem.listActiveClaimPredicates!(
    lpOther,
    { subjectId: "s1", limit: 10 },
  );
  out["predicates: limit 0"] = await mem.listActiveClaimPredicates!(lp, {
    subjectId: "s1",
    limit: 0,
  });

  // ---- (2) observe で claim key を有効にした経路 ----
  const rc = fresh();
  const rcA: Ctx = { ...rc, subjectId: "alice" };
  const rcB: Ctx = { ...rc, subjectId: "bob" };
  const obs = async (
    c: Ctx,
    text: string,
    claim: { subject: string; predicate: string },
    validity: { validFrom?: Date; validUntil?: Date } = {},
  ) => {
    setNext(text, claim);
    const r = await runtime.observe(c, {
      kind: "utterance",
      text,
      claimKey: { enabled: true, detectContested: true },
      ...validity,
    });
    return r;
  };
  const detection = (r: Awaited<ReturnType<typeof obs>>, alias: (id: string) => string) =>
    (r.contestedDetection ?? []).map((d) => {
      const x = d as unknown as {
        matchCount: number;
        result: { kind: string; withMemoryId?: string; matchMemoryIds?: string[] };
      };
      return [
        x.matchCount,
        x.result.kind,
        x.result.withMemoryId ? alias(x.result.withMemoryId) : null,
        (x.result.matchMemoryIds ?? []).map(alias).sort(),
      ];
    });
  const rids: Record<string, string> = {};
  const ralias = (id: string) => Object.entries(rids).find(([, v]) => v === id)?.[0] ?? "?";
  const steps: Array<
    [
      string,
      Ctx,
      string,
      { subject: string; predicate: string },
      { validFrom?: Date; validUntil?: Date }?,
    ]
  > = [
    ["r1 tokyo", rcA, "lives in tokyo", key("alice", "address")],
    [
      "r2 osaka: same key, different content (overlap) -> contested",
      rcA,
      "lives in osaka",
      key("alice", "address"),
    ],
    [
      "r3 nagoya: third arrival against a contested pair -> unresolved",
      rcA,
      "lives in nagoya",
      key("alice", "address"),
    ],
    ["r4 same content again: not a conflict", rcA, "lives in tokyo", key("alice", "address")],
    ["r5 other predicate: no conflict", rcA, "likes tea", key("alice", "likes")],
    [
      "r6 key case differs, normalized by the runtime -> same key",
      rcA,
      "lives in kyoto",
      key("Alice", "Address"),
    ],
    ["r7 other subject: no conflict", rcB, "lives in sapporo", key("alice", "address")],
    ["r8 subjectless: no conflict", rc, "lives in nara", key("alice", "address")],
    [
      "r9 bob tokyo",
      rcB,
      "bob lives in tokyo",
      key("bob", "address"),
      { validFrom: D("2020-01-01T00:00:00Z"), validUntil: D("2022-01-01T00:00:00Z") },
    ],
    [
      "r10 bob later period (touching): no conflict",
      rcB,
      "bob lives in osaka",
      key("bob", "address"),
      { validFrom: D("2022-01-01T00:00:00Z"), validUntil: D("2024-01-01T00:00:00Z") },
    ],
    [
      "r11 bob overlapping period -> contested with the one it overlaps",
      rcB,
      "bob lives in nagoya",
      key("bob", "address"),
      { validFrom: D("2021-06-01T00:00:00Z"), validUntil: D("2021-07-01T00:00:00Z") },
    ],
  ];
  const detections: Record<string, unknown> = {};
  for (const [name, c, text, claim, validity] of steps) {
    const r = await obs(c, text, claim, validity);
    rids[name] = r.memoryIds[0]!;
    detections[name] = detection(r, ralias);
  }
  out["observe: detection per arrival"] = detections;
  const statuses: Record<string, unknown> = {};
  for (const [name, id] of Object.entries(rids)) {
    const m = await mem.get(rc, id);
    statuses[name] = m
      ? [
          m.status,
          m.claimKey ? [m.claimKey.subject, m.claimKey.predicate] : null,
          m.contestedWithId ? ralias(m.contestedWithId) : null,
        ]
      : null;
  }
  out["observe: resulting status, normalized key, contested partner"] = statuses;
  return out;
}

let nextContent = "extracted fact";
let nextClaim = { subject: "user", predicate: "address" };
const llm = {
  name: "canned",
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
    req.schema.parse({
      // 抽出（`memories`）と claim key の導出（`claims`）のどちらの schema にも通る、決め打ちの応答（LLM の実 API は使わない）
      memories: [
        { content: nextContent, digest: nextContent, provenanceKind: "stated", confidence: 1 },
      ],
      claims: [nextClaim],
    }) as T,
};
const setNextImpl = (content: string, claim: { subject: string; predicate: string }) => {
  nextContent = content;
  nextClaim = claim;
};

const EXPECTED: Result = {
  "active: open interval": [
    "a1 open",
    "a2 [2020,2022)",
    "a21 plain active",
    "a3 [2022,2024) touches a2",
  ],
  "contested: open interval": [
    "a19 contested x",
    "a20 contested y",
    "a22 contested [2030,2032) x",
    "a23 contested [2030,2032) y",
  ],
  "active: [2021,2023)": [
    "a1 open",
    "a2 [2020,2022)",
    "a21 plain active",
    "a3 [2022,2024) touches a2",
  ],
  "contested: [2021,2023)": ["a19 contested x", "a20 contested y"],
  "active: [2022,null): touching end of a2 does not overlap": [
    "a1 open",
    "a21 plain active",
    "a3 [2022,2024) touches a2",
  ],
  "contested: [2022,null): touching end of a2 does not overlap": [
    "a19 contested x",
    "a20 contested y",
    "a22 contested [2030,2032) x",
    "a23 contested [2030,2032) y",
  ],
  "active: [null,2020): touching start of a2 does not overlap": ["a1 open", "a21 plain active"],
  "contested: [null,2020): touching start of a2 does not overlap": [
    "a19 contested x",
    "a20 contested y",
  ],
  "active: empty query interval [2022,2022)": [],
  "contested: empty query interval [2022,2022)": [],
  "active: inverted query interval [2023,2022)": [],
  "contested: inverted query interval [2023,2022)": [],
  "active: [2023,2024): inside a3, at the empty a4": [
    "a1 open",
    "a21 plain active",
    "a3 [2022,2024) touches a2",
  ],
  "contested: [2023,2024): inside a3, at the empty a4": ["a19 contested x", "a20 contested y"],
  "active: [2025,2027): the inverted a5 is never overlapped": ["a1 open", "a21 plain active"],
  "contested: [2025,2027): the inverted a5 is never overlapped": [
    "a19 contested x",
    "a20 contested y",
  ],
  "active: subjectless query (null = null)": ["a10 subjectless"],
  "contested: subjectless query (null = null)": [],
  "active: subject s2": ["a11 other subject"],
  "contested: subject s2": [],
  "active: subject NFC": ["a8 subject NFC"],
  "contested: subject NFC": [],
  "active: subject NFD": ["a9 subject NFD"],
  "contested: subject NFD": [],
  "active: upper-case key is a different key": ["a6 upper-case key"],
  "contested: upper-case key is a different key": [],
  "active: trailing space is a different key": ["a7 trailing space"],
  "contested: trailing space is a different key": [],
  "active: key NFC": ["a12 key NFC"],
  "contested: key NFC": [],
  "active: key NFD": ["a13 key NFD"],
  "contested: key NFD": [],
  "active: other predicate": ["a14 other predicate"],
  "contested: other predicate": [],
  "active: [2031,2033): overlaps only the contested pair a22 a23": ["a1 open", "a21 plain active"],
  "contested: [2031,2033): overlaps only the contested pair a22 a23": [
    "a19 contested x",
    "a20 contested y",
    "a22 contested [2030,2032) x",
    "a23 contested [2030,2032) y",
  ],
  "active: [2032,null): touches the end of the contested pair": ["a1 open", "a21 plain active"],
  "contested: [2032,null): touches the end of the contested pair": [
    "a19 contested x",
    "a20 contested y",
  ],
  "active: excludeMemoryId a1": ["a2 [2020,2022)", "a21 plain active", "a3 [2022,2024) touches a2"],
  "contested: excludeMemoryId a1": [
    "a19 contested x",
    "a20 contested y",
    "a22 contested [2030,2032) x",
    "a23 contested [2030,2032) y",
  ],
  "active: excludeMemoryId a22 (a contested one)": [
    "a1 open",
    "a2 [2020,2022)",
    "a21 plain active",
    "a3 [2022,2024) touches a2",
  ],
  "contested: excludeMemoryId a22 (a contested one)": [
    "a19 contested x",
    "a20 contested y",
    "a23 contested [2030,2032) y",
  ],
  "active: contentHash equal to a2's": ["a1 open", "a21 plain active", "a3 [2022,2024) touches a2"],
  "contested: contentHash equal to a2's": [
    "a19 contested x",
    "a20 contested y",
    "a22 contested [2030,2032) x",
    "a23 contested [2030,2032) y",
  ],
  "active: another tenant's id as excludeMemoryId is just unmatched": [
    "a1 open",
    "a2 [2020,2022)",
    "a21 plain active",
    "a3 [2022,2024) touches a2",
  ],
  "contested: another tenant's id as excludeMemoryId is just unmatched": [
    "a19 contested x",
    "a20 contested y",
    "a22 contested [2030,2032) x",
    "a23 contested [2030,2032) y",
  ],
  "active: the other tenant sees only its own": ["z other tenant"],
  "predicates: s1, newest first, deduplicated, active only": ["alpha", "beta"],
  "predicates: s1, limit 1": ["alpha"],
  "predicates: subjectless (null = null)": ["delta"],
  "predicates: s2": ["eps"],
  "predicates: another tenant sees only its own": ["zeta"],
  "predicates: limit 0": [],
  "observe: detection per arrival": {
    "r1 tokyo": [[0, "no_conflict", null, []]],
    "r2 osaka: same key, different content (overlap) -> contested": [
      [1, "contested", "r1 tokyo", []],
    ],
    "r3 nagoya: third arrival against a contested pair -> unresolved": [
      [2, "contested_group", null, []],
    ],
    "r4 same content again: not a conflict": [[2, "contested_group", null, []]],
    "r5 other predicate: no conflict": [[0, "no_conflict", null, []]],
    "r6 key case differs, normalized by the runtime -> same key": [
      [4, "contested_group", null, []],
    ],
    "r7 other subject: no conflict": [[0, "no_conflict", null, []]],
    "r8 subjectless: no conflict": [[0, "no_conflict", null, []]],
    "r9 bob tokyo": [[0, "no_conflict", null, []]],
    "r10 bob later period (touching): no conflict": [[0, "no_conflict", null, []]],
    "r11 bob overlapping period -> contested with the one it overlaps": [
      [1, "contested", "r9 bob tokyo", []],
    ],
  },
  "observe: resulting status, normalized key, contested partner": {
    "r1 tokyo": ["contested", ["alice", "address"], null],
    "r2 osaka: same key, different content (overlap) -> contested": [
      "contested",
      ["alice", "address"],
      null,
    ],
    "r3 nagoya: third arrival against a contested pair -> unresolved": [
      "contested",
      ["alice", "address"],
      null,
    ],
    "r4 same content again: not a conflict": ["contested", ["alice", "address"], null],
    "r5 other predicate: no conflict": ["active", ["alice", "likes"], null],
    "r6 key case differs, normalized by the runtime -> same key": [
      "contested",
      ["alice", "address"],
      null,
    ],
    "r7 other subject: no conflict": ["active", ["alice", "address"], null],
    "r8 subjectless: no conflict": ["active", ["alice", "address"], null],
    "r9 bob tokyo": [
      "contested",
      ["bob", "address"],
      "r11 bob overlapping period -> contested with the one it overlaps",
    ],
    "r10 bob later period (touching): no conflict": ["active", ["bob", "address"], null],
    "r11 bob overlapping period -> contested with the one it overlaps": [
      "contested",
      ["bob", "address"],
      "r9 bob tokyo",
    ],
  },
};
const space = TEST_EMBEDDING_SPACE;

afterAll(async () => {
  await closeTestClient();
});

let hashCounter = 0;
function memoryFixture(ctx: Ctx, tag: string, over: Partial<NewMemory>): NewMemory {
  hashCounter += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `claim-key-${hashCounter}-${tag}`,
    content: tag,
    digest: tag,
    embeddingStatus: "ready",
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    decayFloorAt: new Date("2035-01-01T00:00:00.000Z"),
    ...over,
  });
}

function build(
  base: string,
  stores: {
    mem: MemoryStore;
    vec: PostgresVectorStore | InMemoryVectorStore;
    lex: PostgresLexicalStore | InMemoryLexicalStore;
    ev: PostgresEventStore | InMemoryEventStore;
    ob: PostgresOutboxStore | InMemoryOutboxStore;
    ts: PostgresTenantSettingsStore | InMemoryTenantSettingsStore;
    rel: PostgresRelationStore | InMemoryRelationStore;
  },
): Env {
  const runtime: Runtime = createRuntime({
    memoryStore: stores.mem,
    vectorStore: stores.vec,
    lexicalStore: stores.lex,
    outboxStore: stores.ob,
    eventStore: stores.ev,
    relationStore: stores.rel,
    tenantSettingsStore: stores.ts,
    llmProvider: llm,
    embeddingProvider: { space, embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]) },
    hashContent: (content) => `h(${content})`,
  });
  let n = 0;
  return {
    runtime,
    mem: stores.mem,
    fresh: () => ({ tenantId: `${base}-${(n += 1)}` }),
    mk: (ctx, tag, over) => stores.mem.createMemory(ctx, memoryFixture(ctx, tag, over)),
    setNext: setNextImpl,
  };
}

describe("claim key と矛盾の検出の読み口（InMemory・Postgres）", () => {
  it("InMemory は Postgres で実測した結果（EXPECTED）と一致する", async () => {
    const m = new InMemoryMemoryStore();
    const env = build("claim-key-inmem", {
      mem: m,
      vec: new InMemoryVectorStore(m),
      lex: new InMemoryLexicalStore(m),
      ev: new InMemoryEventStore(m, m.events),
      ob: new InMemoryOutboxStore(m.outboxJobs),
      ts: new InMemoryTenantSettingsStore(
        m.activitySeq,
        m.subjectActivitySeq,
        m.eventRetentionDays,
      ),
      rel: new InMemoryRelationStore(m),
    });
    expect(await scenario(env)).toEqual(EXPECTED);
  });

  it("Postgres は EXPECTED と一致する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const env = build("claim-key-pg", {
      mem: new PostgresMemoryStore(db),
      vec: new PostgresVectorStore(db),
      lex: new PostgresLexicalStore(db),
      ev: new PostgresEventStore(db),
      ob: new PostgresOutboxStore(db),
      ts: new PostgresTenantSettingsStore(db),
      rel: new PostgresRelationStore(db),
    });
    expect(await scenario(env)).toEqual(EXPECTED);
  });
});
