import { createHash } from "node:crypto";
import type { Ctx } from "../ctx.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { MemoryEvent } from "../event.js";
import { ExtractionResultSchema } from "../extraction.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import type { Memory } from "../memory.js";
import type { Observation } from "../observation.js";
import type { OutboxJobRecord } from "../outbox.js";
import { createRuntime } from "../runtime.js";
import type { createRuntime as CreateRuntime, RuntimeDeps } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 書き込み側の差分ファズの本体。seed を固定した操作列を2つの store 一式に同じ順で流し、
 * **1手ごとに**両方の状態を突き合わせる。recall の検査器（`recall-invariant-fuzz-harness.ts`、
 * #1030・#1047）が読む側を縛るのに対して、こちらは書く側を縛る。
 *
 * 使うところ:
 * - `write-diff-fuzz.test.ts`（core）: Fake と Fake を突き合わせて、検査器そのものが決定的に
 *   動くことを見る。陽性対照（片方の `reinforce` を壊すと食い違いが出る）もここに在る。
 * - `packages/postgres/src/__tests__/write-diff-fuzz.postgres.test.ts`: Postgres と Fake を
 *   突き合わせる。陽性対照も同じ形で置く。
 *
 * ## 操作
 * observe（sync・deferred・`externalId` の重複あり）、usage の observe（`recordUsage` と
 * `reinforceMany`）、tick（extract・embed）、reextract、抽出器の出力を変える epoch の切り替え、
 * consolidate、reflect、forget、purge、restoreArchived、restoreSuperseded、reinforce
 * （store の口）、sweepArchive、時計を進める。LLM と埋め込みは、この下の決定的な偽物を使う。
 *
 * ## 比べるもの
 * 1手ごとの、その手の戻り値（id を伏せた形）と、次の状態。
 * - 記憶: status・本文・digest・tags・subject・由来の Observation・抽出器の版・provenance・
 *   superseded_by・contested_with・埋め込みの状態・strength・半減期・lastReinforcedAt・
 *   decayFloorAt・purge 済みか。
 * - Observation（`externalId`）、outbox（kind・payload・attempts・完了/失敗/未処理）、
 *   イベント（記憶ごとの kind と meta）。
 *
 * id は backend ごとに形が違う（Postgres は uuid、Fake は連番）ので、別名に置き換える。
 * Observation は observe が返した順、記憶はその手で初めて現れた順と安定なキー
 * （recordedAt・由来・版・content_hash・subject・由来の別名を入れた provenance）で別名を付け、
 * 一度付けた別名は変えない。
 *
 * ## 比べないもの（約束の外。どちらの結果も正しい）
 * - **id に落ちる同点の決着。** id の形が backend ごとに違うので、同点の並びは違ってよい。
 *   - `archiveDecayed` の `ORDER BY decay_floor_at, id` の切れ目: sweep の上限を十分に大きく
 *     して、切れ目が同点の間に来ないようにしている。
 *   - 近傍の recall の並びから来る `provenance.sources`（と `created` イベントの
 *     `meta.sources`）の順序: 先頭（種）と、残りを整列したものとで比べる。
 *   - `reextract` の `skipped` の順序: 整列して比べる。
 * - **同じ tick の中の consolidate / reflect の自動ジョブ。** `claimBatch` の順序は
 *   `available_at`（同じトランザクションで積まれた行は同時刻）の同点で id に落ちるので、
 *   どちらが先に元を吸うかが backend で変わりうる。自動ジョブは積まない
 *   （`autoQueueConsolidateReflectOnExtract` を立てない）。consolidate / reflect の本体は、
 *   直接の操作として当てている。
 * - **usage の Observation への reextract**（Issue #1099）。usage は抽出器を通らない約束だが、
 *   今の `reextract` は抽出してしまう。本文に id が入るので backend で食い違う。直すまでは
 *   reextract の対象から外す。
 * - **境界の時刻。** 時計は1手ごとに1秒進み、`advance` で1時間〜400日進む。
 *   `decay_floor_at` と「いま」がちょうど一致する形はまず作れない。【実測】`archiveDecayed` の
 *   `<=` を `<` に壊す変異は、20シード × 60手で捕まらなかった。境界は、それぞれの口の歯が見る。
 * - **並行。** 操作は1本ずつ順に流す。リース切れの二重処理などは #1092 の範囲。
 * - 時計に依らない時刻（outbox の `created_at` / `available_at`、イベントの `at`、
 *   `updated_at`）。Postgres は `now()`、Fake は `new Date()` で埋める。
 */

export const WRITE_FUZZ_CTX: Ctx = { tenantId: "tenant-write-fuzz" };
const ctx = WRITE_FUZZ_CTX;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const TEXTS = [
  "猫が好き。犬も好き。",
  "明日は雨。傘を持つ。",
  "東京に住んでいる。",
  "猫が好き。",
  "コーヒーを毎朝飲む。紅茶は飲まない。",
  "青が好きな色。",
];

export type WriteOp =
  | { k: "observe"; t: number; deferred: boolean; ext: number | null }
  | { k: "usage"; i: number; j: number; ext: number | null }
  | { k: "tick"; kinds: ("extract" | "embed")[] }
  | { k: "reextract"; o: number }
  | { k: "epoch" }
  | { k: "consolidate"; i: number; j: number }
  | { k: "reflect"; i: number; j: number }
  | { k: "forget"; i: number }
  | { k: "purge"; i: number }
  | { k: "restoreArchived"; i: number }
  | { k: "restoreSuperseded"; i: number }
  | { k: "reinforce"; i: number }
  | { k: "sweep" }
  | { k: "advance"; hours: number };

export function genWriteOps(seed: number, n: number): WriteOp[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const idx = () => Math.floor(r() * 1000);
  const ops: WriteOp[] = [];
  for (let i = 0; i < n; i++) {
    const x = r();
    if (i < 3 || x < 0.25) {
      ops.push({
        k: "observe",
        t: Math.floor(r() * TEXTS.length),
        deferred: r() < 0.3,
        ext: r() < 0.4 ? Math.floor(r() * 4) : null,
      });
    } else if (x < 0.4) {
      ops.push({ k: "tick", kinds: pick([["extract"], ["embed"], ["extract", "embed"]] as const) });
    } else if (x < 0.46) ops.push({ k: "reextract", o: idx() });
    else if (x < 0.5) ops.push({ k: "epoch" });
    else if (x < 0.56) ops.push({ k: "consolidate", i: idx(), j: idx() });
    else if (x < 0.6) ops.push({ k: "reflect", i: idx(), j: idx() });
    else if (x < 0.67) ops.push({ k: "forget", i: idx() });
    else if (x < 0.71) ops.push({ k: "purge", i: idx() });
    else if (x < 0.75) ops.push({ k: "restoreArchived", i: idx() });
    else if (x < 0.8) ops.push({ k: "restoreSuperseded", i: idx() });
    else if (x < 0.84) ops.push({ k: "reinforce", i: idx() });
    else if (x < 0.88) {
      ops.push({ k: "usage", i: idx(), j: idx(), ext: r() < 0.5 ? Math.floor(r() * 3) : null });
    } else if (x < 0.93) ops.push({ k: "sweep" });
    else ops.push({ k: "advance", hours: pick([1, 24, 24 * 30, 24 * 400]) });
  }
  return ops;
}

/**
 * 決定的な LLM。抽出は、元の発話を「。」で切った候補を返す。`epoch` が奇数なら候補の末尾に
 * 印を付ける——reextract が既存を置き換える形（supersede）を作るため。consolidate / reflect は
 * プロンプトのハッシュから本文を作る。
 */
export class WriteFuzzLLM implements LLMProvider {
  epoch = 0;
  async complete() {
    return { content: "" };
  }
  async completeStructured<T>(_c: Ctx, req: StructuredRequest<T>): Promise<T> {
    const user = req.prompt.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    const mark = this.epoch % 2 === 1 ? "（改）" : "";
    if (req.schema === (ExtractionResultSchema as unknown)) {
      const src = TEXTS.find((t) => user.includes(t)) ?? user.slice(-20);
      const parts = src.split("。").filter((p) => p.length > 0);
      return req.schema.parse({
        memories: parts.map((p) => ({ content: p + mark, provenanceKind: "stated" })),
      });
    }
    const h = sha256(user).slice(0, 6);
    const consolidation = req.schema.safeParse({ content: `統合-${h}${mark}` });
    if (consolidation.success) return consolidation.data;
    return req.schema.parse({ outcome: "reflected", content: `内省-${h}${mark}` });
  }
}

/** 決定的な埋め込み。本文のハッシュから角度を作り、空間の次元の残りは0で埋める。 */
export function writeFuzzEmbedding(space: EmbeddingSpaceId): EmbeddingProvider {
  return {
    space,
    embed: async (_c, texts) =>
      texts.map((t) => {
        const a = (parseInt(sha256(t).slice(0, 4), 16) / 65535) * Math.PI;
        return [Math.cos(a), Math.sin(a), ...Array<number>(space.dimensions - 2).fill(0)];
      }),
  };
}

export interface WriteFuzzState {
  memories: Memory[];
  observations: Observation[];
  outbox: OutboxJobRecord[];
  events: MemoryEvent[];
}

export type WriteFuzzStores = Pick<
  RuntimeDeps,
  "memoryStore" | "outboxStore" | "vectorStore" | "eventStore" | "tenantSettingsStore"
> & { lexicalStore?: RuntimeDeps["lexicalStore"] };

export interface WriteFuzzBackend {
  name: string;
  /** 前の実行の状態を持ち越さない store 一式と、そのテナントの状態を丸ごと読む関数。 */
  setup(): Promise<{
    stores: WriteFuzzStores;
    space: EmbeddingSpaceId;
    read: () => Promise<WriteFuzzState>;
    createRuntime: typeof CreateRuntime;
  }>;
}

const round = (x: number) => Number(x.toPrecision(6));
const ID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:mem|obs|rcl|job|evt)-\d+/g;
const hideIds = (s: string) => s.replace(ID_PATTERN, "ID");

/** provenance / meta の `sources` は、先頭（種）と残りを整列したものとで比べる（doc 参照）。 */
function canonicalSources(sources: string[]): string[] {
  return sources.length === 0 ? sources : [sources[0]!, ...sources.slice(1).sort()];
}

function aliasDeep(v: unknown, alias: (id: string) => string | undefined): unknown {
  if (typeof v === "string") return alias(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => aliasDeep(x, alias));
  if (v instanceof Date) return v.getTime();
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== "at")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => {
          const aliased = aliasDeep(x, alias);
          return [
            k,
            k === "sources" && Array.isArray(aliased)
              ? canonicalSources(aliased as string[])
              : aliased,
          ];
        }),
    );
  }
  return v;
}

export interface WriteRunOutcome {
  /** 1手ごとの戻り値（id を伏せた形）。 */
  results: string[];
  /** 1手ごとの、その手の後の状態（backend に依らない形）。 */
  snapshots: string[];
}

export interface WriteRunOptions {
  /** 時計の起点。Postgres の outbox は `available_at` を `now()` で埋めるので、それ以降にする。 */
  t0: number;
  /** `stores.memoryStore` を差し替える（陽性対照が `reinforce` を壊すのに使う）。 */
  wrapMemoryStore?: (store: WriteFuzzStores["memoryStore"]) => WriteFuzzStores["memoryStore"];
}

export async function runWriteOps(
  backend: WriteFuzzBackend,
  ops: readonly WriteOp[],
  opts: WriteRunOptions,
): Promise<WriteRunOutcome> {
  const { stores, space, read, createRuntime } = await backend.setup();
  const memoryStore = opts.wrapMemoryStore
    ? opts.wrapMemoryStore(stores.memoryStore)
    : stores.memoryStore;
  const llm = new WriteFuzzLLM();
  const clock = {
    t: opts.t0,
    now() {
      return new Date(this.t);
    },
  };
  const runtime = createRuntime({
    ...stores,
    memoryStore,
    llmProvider: llm,
    embeddingProvider: writeFuzzEmbedding(space),
    hashContent: sha256,
    clock,
  });

  const observationOrder: string[] = [];
  const usageObservations = new Set<string>();
  const memAliases = new Map<string, string>();
  const obsAlias = (id: string) => {
    const n = observationOrder.indexOf(id);
    return n < 0 ? undefined : `o${n}`;
  };
  const alias = (id: string) => memAliases.get(id) ?? obsAlias(id);

  /** まだ別名の無い記憶に、安定なキーの順で別名を付ける。 */
  const assignAliases = async (): Promise<WriteFuzzState> => {
    const state = await read();
    const key = (m: Memory) =>
      JSON.stringify([
        m.recordedAt.getTime(),
        obsAlias(m.sourceObservationId ?? "") ?? "-",
        m.extractorVersion ?? "-",
        m.contentHash,
        m.subjectId ?? null,
        aliasDeep(m.provenance, alias),
      ]);
    state.memories
      .filter((m) => !memAliases.has(m.id))
      .map((m) => ({ m, k: key(m) }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .forEach(({ m }) => memAliases.set(m.id, `m${memAliases.size}`));
    return state;
  };

  const normalize = (state: WriteFuzzState) => {
    const num = (id: string) => Number(memAliases.get(id)!.slice(1));
    const memories = [...state.memories].sort((a, b) => num(a.id) - num(b.id));
    const A = (id: string | null | undefined) => (id == null ? null : (alias(id) ?? "?"));
    return JSON.stringify({
      memories: memories.map((m) => ({
        a: memAliases.get(m.id),
        status: m.status,
        content: m.content,
        digest: m.digest,
        tags: [...m.tags].sort(),
        subject: m.subjectId ?? null,
        source: A(m.sourceObservationId),
        version: m.extractorVersion ?? null,
        provenance: aliasDeep(m.provenance, alias),
        supersededBy: A(m.supersededById),
        contestedWith: A(m.contestedWithId),
        embedding: m.embeddingStatus,
        strength: round(m.strength),
        halfLifeHours: round(m.halfLifeHours),
        lastReinforcedAt: m.lastReinforcedAt?.getTime() ?? null,
        decayFloorAt: m.decayFloorAt.getTime(),
        purged: (m.purgedAt ?? null) !== null,
      })),
      observations: state.observations.map((o) => `${A(o.id)}:${o.externalId ?? ""}`).sort(),
      outbox: state.outbox
        .map(
          (j) =>
            `${j.kind}:${JSON.stringify(aliasDeep(j.payload, alias))}:a${j.attempts}:` +
            (j.completedAt ? "done" : j.failedAt ? "failed" : "pending"),
        )
        .sort(),
      events: state.events
        .map((e) => `${A(e.memoryId)}:${e.kind}:${JSON.stringify(aliasDeep(e.meta, alias))}`)
        .sort(),
    });
  };

  const results: string[] = [];
  const snapshots: string[] = [];
  for (const op of ops) {
    clock.t += 1000;
    await assignAliases();
    const byAlias = new Map([...memAliases].map(([id, a]) => [a, id] as const));
    const memAt = (i: number) => (byAlias.size === 0 ? null : byAlias.get(`m${i % byAlias.size}`)!);
    let result: unknown;
    try {
      switch (op.k) {
        case "observe": {
          const r = await runtime.observe(ctx, {
            kind: "utterance",
            text: TEXTS[op.t]!,
            extract: op.deferred ? "deferred" : "sync",
            ...(op.ext !== null ? { externalId: `e${op.ext}` } : {}),
          });
          if (!observationOrder.includes(r.observationId)) observationOrder.push(r.observationId);
          result = [r.extraction, r.memoryIds.length];
          break;
        }
        case "usage": {
          const a = memAt(op.i);
          const b = memAt(op.j);
          if (!a || !b) {
            result = "skip";
            break;
          }
          const recalled = await runtime.recall(ctx, { text: TEXTS[op.i % TEXTS.length]! });
          const r = await runtime.observe(ctx, {
            kind: "memory_usage",
            recallId: recalled.recallId,
            usedMemoryIds: [a, b],
            ...(op.ext !== null ? { externalId: `u${op.ext}` } : {}),
          });
          if (!observationOrder.includes(r.observationId)) observationOrder.push(r.observationId);
          usageObservations.add(r.observationId);
          result = [r.extraction, r.memoryIds.length];
          break;
        }
        case "tick": {
          const r = await runtime.tick(ctx, { leaseMs: 60_000, kinds: op.kinds });
          result = [r.processed, r.failed, r.unsupported.length, r.leaseConflicts.length];
          break;
        }
        case "reextract": {
          // Issue #1099 が直るまで、usage の Observation は対象から外す（doc 参照）。
          const targets = observationOrder.filter((id) => !usageObservations.has(id));
          if (targets.length === 0) {
            result = "skip";
            break;
          }
          const r = await runtime.reextract(ctx, targets[op.o % targets.length]!);
          result = [
            r.extraction,
            r.memoryIds.length,
            r.supersededMemoryIds.length,
            r.skipped
              .map((s) => (s.kind === "not_examined" ? `${s.kind}:${s.reason}` : s.kind))
              .sort(),
          ];
          break;
        }
        case "epoch":
          llm.epoch += 1;
          result = llm.epoch;
          break;
        case "consolidate": {
          const a = memAt(op.i);
          const b = memAt(op.j);
          if (!a || !b) {
            result = "skip";
            break;
          }
          const r = await runtime.consolidate(ctx, { target: { memoryIds: [a, b] } });
          result = [r.outcome, r.nothingReason, r.sources.map((s) => s.kind)];
          break;
        }
        case "reflect": {
          const a = memAt(op.i);
          const b = memAt(op.j);
          if (!a || !b) {
            result = "skip";
            break;
          }
          const r = await runtime.reflect(ctx, { target: { memoryIds: [a, b] } });
          result = [r.outcome, r.basis.map((s) => s.kind)];
          break;
        }
        case "forget":
        case "purge":
        case "restoreArchived":
        case "restoreSuperseded": {
          const a = memAt(op.i);
          if (!a) {
            result = "skip";
            break;
          }
          const r =
            op.k === "forget"
              ? await runtime.forget(ctx, { memoryId: a })
              : op.k === "purge"
                ? await runtime.purge(ctx, { memoryId: a })
                : op.k === "restoreArchived"
                  ? await runtime.restoreArchived(ctx, { memoryId: a })
                  : await runtime.restoreSuperseded(ctx, { supersededById: a });
          result = hideIds(JSON.stringify(r));
          break;
        }
        case "reinforce": {
          const a = memAt(op.i);
          if (!a) {
            result = "skip";
            break;
          }
          const m = await memoryStore.reinforce(ctx, a, clock.now());
          result = m.status;
          break;
        }
        case "sweep": {
          // 上限を十分に大きくして、切れ目が同点の間に来ないようにする（doc 参照）。
          const r = await runtime.sweepArchive(ctx, { now: clock.now(), limit: 1000 });
          result = hideIds(JSON.stringify(r)).replace(/"\d{4}-\d\d-\d\dT[^"]*"/g, "T");
          break;
        }
        case "advance":
          clock.t += op.hours * 3_600_000;
          result = op.hours;
          break;
      }
    } catch (error) {
      result = `THROW ${(error as Error).name}: ${hideIds((error as Error).message).slice(0, 200)}`;
    }
    results.push(JSON.stringify(result));
    snapshots.push(normalize(await assignAliases()));
  }
  return { results, snapshots };
}

export interface WriteDiff {
  op: number;
  opDescription: string;
  detail: string;
}

/** 同じ操作列を2つの backend に流し、戻り値か状態が最初に食い違った手を返す。無ければ `null`。 */
export async function diffWriteBackends(
  a: WriteFuzzBackend,
  b: WriteFuzzBackend,
  ops: readonly WriteOp[],
  opts: { t0: number; wrapB?: WriteRunOptions["wrapMemoryStore"] },
): Promise<WriteDiff | null> {
  const ra = await runWriteOps(a, ops, { t0: opts.t0 });
  const rb = await runWriteOps(b, ops, { t0: opts.t0, wrapMemoryStore: opts.wrapB });
  for (let i = 0; i < ops.length; i++) {
    if (ra.results[i] !== rb.results[i]) {
      return {
        op: i,
        opDescription: JSON.stringify(ops[i]),
        detail: `result ${a.name}=${ra.results[i]} ${b.name}=${rb.results[i]}`,
      };
    }
    if (ra.snapshots[i] !== rb.snapshots[i]) {
      return {
        op: i,
        opDescription: JSON.stringify(ops[i]),
        detail: firstStateMismatch(ra.snapshots[i]!, rb.snapshots[i]!, a.name, b.name),
      };
    }
  }
  return null;
}

function firstStateMismatch(sa: string, sb: string, na: string, nb: string): string {
  const ja = JSON.parse(sa) as Record<string, unknown[]>;
  const jb = JSON.parse(sb) as Record<string, unknown[]>;
  for (const key of Object.keys(ja)) {
    const xa = ja[key]!;
    const xb = jb[key]!;
    const n = Math.max(xa.length, xb.length);
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(xa[i]) !== JSON.stringify(xb[i])) {
        return `${key}[${i}] ${na}=${JSON.stringify(xa[i])} ${nb}=${JSON.stringify(xb[i])}`;
      }
    }
  }
  return "(state differs)";
}

/** 陽性対照: `reinforce` が何も書かない（今の値を返すだけの）memoryStore にする。 */
export function breakReinforce(
  store: WriteFuzzStores["memoryStore"],
): WriteFuzzStores["memoryStore"] {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "reinforce") {
        return async (c: Ctx, id: string) => {
          const current = await target.get(c, id);
          if (current === null) throw new Error("breakReinforce: memory not found");
          return current;
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** 複数のシードを流し、食い違いを1行ずつの報告にまとめる（無ければ空文字列）。 */
export async function diffWriteSeeds(
  a: WriteFuzzBackend,
  b: WriteFuzzBackend,
  opts: {
    seeds: number;
    len: number;
    firstSeed?: number;
    t0: number;
    wrapB?: WriteRunOptions["wrapMemoryStore"];
  },
): Promise<string> {
  const lines: string[] = [];
  const first = opts.firstSeed ?? 1;
  for (let seed = first; seed < first + opts.seeds; seed++) {
    const diff = await diffWriteBackends(a, b, genWriteOps(seed, opts.len), opts);
    if (diff) lines.push(`seed ${seed} op#${diff.op} ${diff.opDescription}: ${diff.detail}`);
  }
  return lines.join("\n");
}

/**
 * core の Fake（`createFakeRuntimeStores`）を backend にする。状態は Fake の内部（`backing`）を
 * 直接読む——`MemoryStore` には、テナントの記憶を丸ごと列挙する口が無いため。
 * `space` を渡すと、埋め込みの空間をそれに合わせる（Postgres と突き合わせるとき）。
 */
export function fakeWriteFuzzBackend(name: string, space?: EmbeddingSpaceId): WriteFuzzBackend {
  return {
    name,
    async setup() {
      const stores = createFakeRuntimeStores();
      const backing = (
        stores.memoryStore as unknown as {
          backing: {
            memories: Map<string, Memory>;
            observations: Map<string, Observation>;
            outboxJobs: OutboxJobRecord[];
            events: MemoryEvent[];
          };
        }
      ).backing;
      const tenant = WRITE_FUZZ_CTX.tenantId;
      return {
        stores,
        space: space ?? stores.embeddingProvider.space,
        createRuntime,
        read: async () => ({
          memories: [...backing.memories.values()].filter((m) => m.tenantId === tenant),
          observations: [...backing.observations.values()].filter((o) => o.tenantId === tenant),
          outbox: backing.outboxJobs.filter((j) => j.tenantId === tenant),
          events: backing.events.filter((e) => e.tenantId === tenant),
        }),
      };
    },
  };
}
