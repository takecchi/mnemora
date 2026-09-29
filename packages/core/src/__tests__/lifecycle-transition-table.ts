import type { Ctx } from "../ctx.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { MemoryId } from "../ids.js";
import type { Memory, NewMemory } from "../memory.js";
import type { MemoryEvent } from "../event.js";
import type { Runtime } from "../runtime.js";
import { ConsolidationLLMResultSchema } from "../strategies/consolidate.js";
import { ExtractionResultSchema } from "../extraction.js";

/**
 * 記憶の状態遷移の期待値の表（`docs/memory-model.md` §11 のライフサイクル）と、それを
 * runtime の公開の口に当てるハーネス。
 *
 * 置き場所と使い方は `recall-invariant-fuzz-harness.ts`（PR #1047）と同じ——この表を1か所にだけ
 * 置き、core Fake のテスト（`lifecycle-transition-table.test.ts`）と Postgres だけのテスト
 * （`packages/postgres/src/__tests__/lifecycle-transition-table.postgres.test.ts`）の両方が
 * 同じ表を走らせる。**1マスを1本の `it` にする**ので、どれか1マスの期待値（または実装）が
 * 変わると、そのマスの `it` だけが赤になる。
 *
 * 表の中身は、2026-09-27 に Postgres と core Fake の両方で総当たりして一致した実測を、
 * 約束（§11・ADR）に照らして確かめたもの（調査の記録は Issue #1079 のコメント）。
 * `docs/memory-model.md` §11 の表と食い違ったら赤になる結び目は {@link DOC_ROW_LINKS}。
 *
 * **`*-conformance.ts` には足していない**（#809）——第三者の adapter にこの表を課してはいない。
 */

export const LIFECYCLE_CTX: Ctx = { tenantId: "lifecycle-transition-table" };

/** 表の出発状態。`purged` は `status` の値ではなく「`forgotten` かつ `purgedAt` あり」（§11 の脚注）。 */
export type LifecycleState =
  "active" | "superseded" | "contested" | "archived" | "forgotten" | "purged";
export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  "active",
  "superseded",
  "contested",
  "archived",
  "forgotten",
  "purged",
];

export type LifecycleOp =
  | "forget"
  | "purge"
  | "restoreArchived"
  | "restoreSuperseded"
  | "markContested"
  | "resolveContested(x勝ち)"
  | "resolveContested(both)"
  | "consolidate"
  | "reflect"
  | "sweepArchive";
export const LIFECYCLE_OPS: readonly LifecycleOp[] = [
  "forget",
  "purge",
  "restoreArchived",
  "restoreSuperseded",
  "markContested",
  "resolveContested(x勝ち)",
  "resolveContested(both)",
  "consolidate",
  "reflect",
  "sweepArchive",
];

/**
 * 1マスの期待値。
 * - `x`: 操作の後の x の状態（`purged` は forgotten かつ purgedAt あり）
 * - `outcome`: 返り値を短く正規化したもの（{@link normalizeOutcome}）。拒む／既に、はここに出る
 * - `events`: この操作で x に積まれたイベント（`kind` または `kind:meta.reason`）
 * - `partner`: 相手（superseded の同じ群の片割れ・contested の対向）が居る出発状態のときだけ
 */
export interface CellExpectation {
  x: LifecycleState;
  outcome: string;
  events: string[];
  partner?: { state: LifecycleState; events: string[] };
}

const NOT_ACTIVE_VS_ELIGIBLE = "ineligible:status_not_active+eligible";
const NOT_CONTESTED_BOTH = "ineligible:status_not_contested+status_not_contested";

/** 操作が受け付けない出発状態で共通の期待値（x も相手も動かず、イベントも積まれない）。 */
function unchanged(
  state: LifecycleState,
  outcome: string,
  partner?: LifecycleState,
): CellExpectation {
  return {
    x: state,
    outcome,
    events: [],
    ...(partner ? { partner: { state: partner, events: [] } } : {}),
  };
}

/** 出発状態 × 操作 → 期待値。**1マスが1本の `it`。** */
export const LIFECYCLE_TABLE: Record<LifecycleState, Record<LifecycleOp, CellExpectation>> = {
  active: {
    forget: { x: "forgotten", outcome: "forgotten", events: ["forgotten"] },
    purge: unchanged("active", "status_not_forgotten"),
    restoreArchived: unchanged("active", "status_not_archived"),
    restoreSuperseded: unchanged("active", "none"),
    markContested: { x: "contested", outcome: "contested", events: ["updated:contested"] },
    "resolveContested(x勝ち)": unchanged("active", NOT_CONTESTED_BOTH),
    "resolveContested(both)": unchanged("active", NOT_CONTESTED_BOTH),
    consolidate: { x: "superseded", outcome: "consolidated", events: ["superseded:consolidated"] },
    reflect: unchanged("active", "reflected"),
    sweepArchive: { x: "archived", outcome: "archived", events: ["archived"] },
  },
  superseded: {
    forget: {
      x: "forgotten",
      outcome: "forgotten",
      events: ["forgotten"],
      partner: { state: "superseded", events: [] },
    },
    purge: unchanged("superseded", "status_not_forgotten", "superseded"),
    restoreArchived: unchanged("superseded", "status_not_archived", "superseded"),
    // 行15: 群ごと戻る（同じ superseded_by_id の片割れも戻る）。
    restoreSuperseded: {
      x: "active",
      outcome: "restored:2",
      events: ["unsuperseded:unsuperseded"],
      partner: { state: "active", events: ["unsuperseded:unsuperseded"] },
    },
    markContested: unchanged("superseded", NOT_ACTIVE_VS_ELIGIBLE, "superseded"),
    "resolveContested(x勝ち)": unchanged("superseded", NOT_CONTESTED_BOTH, "superseded"),
    "resolveContested(both)": unchanged("superseded", NOT_CONTESTED_BOTH, "superseded"),
    consolidate: unchanged(
      "superseded",
      "nothing_to_consolidate:single_eligible_source",
      "superseded",
    ),
    reflect: unchanged("superseded", "nothing_to_reflect:no_eligible_basis", "superseded"),
    // 行8 / ADR 0114 決定2: 掃引は active だけ。
    sweepArchive: unchanged("superseded", "untouched", "superseded"),
  },
  contested: {
    // 行9「任意 → forgotten」。対向は contested のまま孤立する（解くのは resolveOrphanedContested、#825）。
    forget: {
      x: "forgotten",
      outcome: "forgotten",
      events: ["forgotten"],
      partner: { state: "contested", events: [] },
    },
    purge: unchanged("contested", "status_not_forgotten", "contested"),
    restoreArchived: unchanged("contested", "status_not_archived", "contested"),
    restoreSuperseded: unchanged("contested", "none", "contested"),
    markContested: unchanged("contested", NOT_ACTIVE_VS_ELIGIBLE, "contested"),
    // 行7: 勝った側 updated / 負けた側 superseded、どちらも meta.reason='contested_resolved'。
    "resolveContested(x勝ち)": {
      x: "active",
      outcome: "resolved",
      events: ["updated:contested_resolved"],
      partner: { state: "superseded", events: ["superseded:contested_resolved"] },
    },
    "resolveContested(both)": {
      x: "active",
      outcome: "resolved",
      events: ["updated:contested_resolved"],
      partner: { state: "active", events: ["updated:contested_resolved"] },
    },
    consolidate: unchanged(
      "contested",
      "nothing_to_consolidate:single_eligible_source",
      "contested",
    ),
    reflect: unchanged("contested", "nothing_to_reflect:no_eligible_basis", "contested"),
    sweepArchive: unchanged("contested", "untouched", "contested"),
  },
  archived: {
    forget: { x: "forgotten", outcome: "forgotten", events: ["forgotten"] },
    purge: unchanged("archived", "status_not_forgotten"),
    restoreArchived: { x: "active", outcome: "restored", events: ["restored"] },
    restoreSuperseded: unchanged("archived", "none"),
    markContested: unchanged("archived", NOT_ACTIVE_VS_ELIGIBLE),
    "resolveContested(x勝ち)": unchanged("archived", NOT_CONTESTED_BOTH),
    "resolveContested(both)": unchanged("archived", NOT_CONTESTED_BOTH),
    consolidate: unchanged("archived", "nothing_to_consolidate:single_eligible_source"),
    reflect: unchanged("archived", "nothing_to_reflect:no_eligible_basis"),
    sweepArchive: unchanged("archived", "untouched"),
  },
  forgotten: {
    forget: unchanged("forgotten", "already_forgotten"),
    purge: { x: "purged", outcome: "purged", events: ["purged"] },
    restoreArchived: unchanged("forgotten", "status_not_archived"),
    restoreSuperseded: unchanged("forgotten", "none"),
    markContested: unchanged("forgotten", NOT_ACTIVE_VS_ELIGIBLE),
    "resolveContested(x勝ち)": unchanged("forgotten", NOT_CONTESTED_BOTH),
    "resolveContested(both)": unchanged("forgotten", NOT_CONTESTED_BOTH),
    consolidate: unchanged("forgotten", "nothing_to_consolidate:single_eligible_source"),
    reflect: unchanged("forgotten", "nothing_to_reflect:no_eligible_basis"),
    sweepArchive: unchanged("forgotten", "untouched"),
  },
  purged: {
    forget: unchanged("purged", "already_forgotten"),
    purge: unchanged("purged", "already_purged"),
    restoreArchived: unchanged("purged", "status_not_archived"),
    restoreSuperseded: unchanged("purged", "none"),
    markContested: unchanged("purged", NOT_ACTIVE_VS_ELIGIBLE),
    "resolveContested(x勝ち)": unchanged("purged", NOT_CONTESTED_BOTH),
    "resolveContested(both)": unchanged("purged", NOT_CONTESTED_BOTH),
    consolidate: unchanged("purged", "nothing_to_consolidate:single_eligible_source"),
    reflect: unchanged("purged", "nothing_to_reflect:no_eligible_basis"),
    sweepArchive: unchanged("purged", "untouched"),
  },
};

// ---------------------------------------------------------------------------
// reextract（元の Observation 由来の古い Memory の扱い）

export type ReextractOldState = "active" | "contested" | "forgotten" | "purged";
/**
 * 古い Memory（全文フォールバック）の出発状態 → reextract の後の古い Memory と、新しく作られた Memory の件数
 * （ADR 0028 / 0029）。
 *
 * `newMemories`: 利用者の意思で退けた記憶（`contested`・`forgotten`・purge 済み）を持つ Observation では、
 * reextract は抽出をやり直さず、新しい Memory を作らない（Issue #1079・#1149、ADR 0028 の 2026-09-28 追記）。
 * 以前は `contested` でも1件作り、forget・purge 済みは「未決」として表明していなかった。
 */
export const REEXTRACT_TABLE: Record<
  ReextractOldState,
  {
    old: LifecycleState;
    oldEvents: string[];
    superseded: number;
    skipped: string[];
    newMemories: number;
  }
> = {
  active: {
    old: "superseded",
    oldEvents: ["superseded:reextract_superseded"],
    superseded: 1,
    skipped: [],
    newMemories: 1,
  },
  contested: {
    old: "contested",
    oldEvents: [],
    superseded: 0,
    skipped: ["status_not_active:contested"],
    newMemories: 0,
  },
  forgotten: {
    old: "forgotten",
    oldEvents: [],
    superseded: 0,
    skipped: ["status_not_active:forgotten"],
    newMemories: 0,
  },
  purged: {
    old: "purged",
    oldEvents: [],
    superseded: 0,
    skipped: ["status_not_active:forgotten"],
    newMemories: 0,
  },
};

// ---------------------------------------------------------------------------
// ハーネス

/** 表を走らせる器。`makeRuntime` は渡された LLM で runtime を作る（ストアは共有）。 */
export interface LifecycleKit {
  memoryStore: MemoryStore;
  eventStore: EventStore;
  makeRuntime(llmProvider: LLMProvider): Runtime;
}

/** consolidate / reflect に常に成功を返す LLM（本物の provider と同じく schema を通す）。 */
export const lifecycleLlm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) =>
    (req.schema as unknown) === ConsolidationLLMResultSchema
      ? req.schema.parse({ content: "統合した本文" })
      : req.schema.parse({ outcome: "reflected", content: "内省した本文" }),
};

const FAR_FUTURE = new Date("2100-01-01T00:00:00.000Z");
const RECORDED_AT = new Date("2026-01-01T00:00:00.000Z");
/** archived を作る掃引の「いま」（減衰済みの x だけが対象になる）。 */
const SWEEP_TO_ARCHIVE_NOW = new Date("2030-01-01T00:00:00.000Z");
/** `sweepArchive` のマスの「いま」（表の中のすべての Memory の床より後）。 */
const SWEEP_ALL_NOW = new Date("2200-01-01T00:00:00.000Z");

let memorySeq = 0;
async function createMemory(
  kit: LifecycleKit,
  decayed: boolean,
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  memorySeq += 1;
  return kit.memoryStore.createMemory(LIFECYCLE_CTX, {
    tenantId: LIFECYCLE_CTX.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `記憶${memorySeq}`,
    contentHash: `lifecycle-${memorySeq}-${Math.random()}`,
    digest: `記憶${memorySeq}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "lifecycle" },
    tags: [],
    occurredAt: null,
    recordedAt: RECORDED_AT,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: decayed ? new Date("2026-01-02T00:00:00.000Z") : FAR_FUTURE,
    embeddingStatus: "pending",
    ...overrides,
  });
}

interface Setup {
  x: MemoryId;
  partner?: MemoryId;
  superseder?: MemoryId;
}

/**
 * 出発状態を、runtime の公開の口で実際に作る（superseded は consolidate、contested は
 * markContested、archived は sweepArchive、forgotten は forget、purged は forget → purge）。
 * x は減衰済みで作る——`sweepArchive` のマスで「active だけが対象」を意味のある形で見るため。
 */
async function setUp(kit: LifecycleKit, rt: Runtime, state: LifecycleState): Promise<Setup> {
  const ctx = LIFECYCLE_CTX;
  const x = await createMemory(kit, true);
  switch (state) {
    case "active":
      return { x: x.id };
    case "superseded": {
      const y = await createMemory(kit, true);
      const r = await rt.consolidate(ctx, { target: { memoryIds: [x.id, y.id] } });
      return { x: x.id, partner: y.id, superseder: r.consolidatedMemoryId ?? undefined };
    }
    case "contested": {
      const y = await createMemory(kit, true);
      await rt.markContested(ctx, x.id, y.id);
      return { x: x.id, partner: y.id };
    }
    case "archived":
      await rt.sweepArchive(ctx, { now: SWEEP_TO_ARCHIVE_NOW, limit: 100 });
      return { x: x.id };
    case "forgotten":
      await rt.forget(ctx, { memoryId: x.id });
      return { x: x.id };
    case "purged":
      await rt.forget(ctx, { memoryId: x.id });
      await rt.purge(ctx, { memoryId: x.id });
      return { x: x.id };
  }
}

/**
 * 各操作の返り値のうち、表に書くために読む欄だけを持つ緩い形。
 * （操作ごとに返り値の型は違うが、ここで読む欄の名前と意味は揃っている。）
 */
interface LooseResult {
  outcomes?: { kind: string }[];
  outcome?: string | { kind: string; sides?: { kind: string }[]; eligibility?: { kind: string } };
  nothingReason?: string | null;
  archived?: { memoryId: MemoryId }[];
}
const sidesOf = (r: LooseResult): string =>
  typeof r.outcome === "object" && r.outcome.sides
    ? r.outcome.sides.map((side) => side.kind).join("+")
    : "";

/** 返り値を、表に書ける短い文字列へ正規化する。 */
function normalizeOutcome(op: LifecycleOp, result: unknown, x: MemoryId): string {
  const r = result as LooseResult;
  switch (op) {
    case "forget":
    case "purge":
    case "restoreArchived":
      return String(r.outcomes?.[0]?.kind);
    case "restoreSuperseded":
      return r.outcomes?.length ? `restored:${r.outcomes.length}` : "none";
    case "markContested":
    case "resolveContested(x勝ち)":
    case "resolveContested(both)": {
      const kind = typeof r.outcome === "object" ? r.outcome.kind : String(r.outcome);
      return kind === "ineligible" ? `ineligible:${sidesOf(r)}` : kind;
    }
    case "consolidate":
    case "reflect":
      return r.nothingReason ? `${String(r.outcome)}:${r.nothingReason}` : String(r.outcome);
    case "sweepArchive":
      return r.archived?.some((a) => a.memoryId === x) ? "archived" : "untouched";
  }
}

async function runOp(kit: LifecycleKit, rt: Runtime, op: LifecycleOp, s: Setup): Promise<unknown> {
  const ctx = LIFECYCLE_CTX;
  const other = async () => s.partner ?? (await createMemory(kit, false)).id;
  switch (op) {
    case "forget":
      return rt.forget(ctx, { memoryId: s.x });
    case "purge":
      return rt.purge(ctx, { memoryId: s.x });
    case "restoreArchived":
      return rt.restoreArchived(ctx, { memoryId: s.x });
    case "restoreSuperseded":
      // superseded 以外の出発状態では、x 自身を「置き換えた側」として渡す（x の下に群は無い）。
      return rt.restoreSuperseded(ctx, { supersededById: s.superseder ?? s.x });
    case "markContested":
      return rt.markContested(ctx, s.x, (await createMemory(kit, false)).id);
    case "resolveContested(x勝ち)":
      return rt.resolveContested(ctx, s.x, await other(), { kind: "supersede", winnerId: s.x });
    case "resolveContested(both)":
      return rt.resolveContested(ctx, s.x, await other(), { kind: "both_active" });
    case "consolidate":
      return rt.consolidate(ctx, {
        target: { memoryIds: [s.x, (await createMemory(kit, false)).id] },
      });
    case "reflect":
      return rt.reflect(ctx, { target: { seedMemoryId: s.x } });
    case "sweepArchive":
      return rt.sweepArchive(ctx, { now: SWEEP_ALL_NOW, limit: 1000 });
  }
}

/** Memory の状態（`purged` は forgotten かつ purgedAt あり）。 */
export async function stateOf(
  kit: LifecycleKit,
  id: MemoryId,
): Promise<LifecycleState | "missing"> {
  const m = await kit.memoryStore.get(LIFECYCLE_CTX, id);
  if (!m) return "missing";
  if (m.purgedAt !== null) return "purged";
  return m.status as LifecycleState;
}

/** Memory に積まれたイベント（生の行。`id` を持つので、後から「新しく増えた分」を差分で取れる）。 */
export async function eventsOf(kit: LifecycleKit, id: MemoryId): Promise<MemoryEvent[]> {
  return kit.eventStore.list(LIFECYCLE_CTX, { memoryId: id });
}

/** `MemoryEvent` を表の記法（`kind` または `kind:meta.reason`）へ写す。 */
function describeEvent(e: MemoryEvent): string {
  const reason = (e.meta as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? `${e.kind}:${reason}` : e.kind;
}

/**
 * `before`（操作の前に積まれていたイベント）と `after`（操作の後の全イベント）から、
 * この操作が新しく積んだ分だけを表の記法で返す。
 *
 * ⚠ [Issue #1237](https://github.com/takecchi/mnemora/issues/1237): 以前は
 * `after.slice(before.length)` という、`eventStore.list`（`ORDER BY at ASC`）の並びが
 * 積んだ順と一致することに依存した切り出しだった。この表の `archived`（`sweepArchive`
 * が `opts.now` に固定の未来日時 `SWEEP_TO_ARCHIVE_NOW` を使う）と、それに続く操作
 * （`clock.now()` の実際の壁時計）とでは、`archived` の `at` が後続の操作の `at`より
 * 未来になり得る——`slice` は「時刻の順」と「積んだ順」が食い違うと壊れる。`id` の集合差
 * （`before` に無い `id` を持つ行だけを拾う）に切り替えることで、`at` の大小に関わらず
 * 正しく「新しく増えた分」だけを取る。
 */
function newEventKinds(before: readonly MemoryEvent[], after: readonly MemoryEvent[]): string[] {
  const beforeIds = new Set(before.map((e) => e.id));
  return after.filter((e) => !beforeIds.has(e.id)).map(describeEvent);
}

/** 1マスを走らせ、表と同じ形で観測を返す。 */
export async function runCell(
  kit: LifecycleKit,
  state: LifecycleState,
  op: LifecycleOp,
): Promise<CellExpectation> {
  const rt = kit.makeRuntime(lifecycleLlm);
  const s = await setUp(kit, rt, state);
  const xBefore = await eventsOf(kit, s.x);
  const pBefore = s.partner ? await eventsOf(kit, s.partner) : [];
  const result = await runOp(kit, rt, op, s);
  const observed: CellExpectation = {
    x: (await stateOf(kit, s.x)) as LifecycleState,
    outcome: normalizeOutcome(op, result, s.x),
    events: newEventKinds(xBefore, await eventsOf(kit, s.x)),
  };
  if (s.partner) {
    observed.partner = {
      state: (await stateOf(kit, s.partner)) as LifecycleState,
      events: newEventKinds(pBefore, await eventsOf(kit, s.partner)),
    };
  }
  return observed;
}

// ---------------------------------------------------------------------------
// 2手・3手の組

export interface ComboStep {
  label: string;
  run(rt: Runtime, ids: Record<string, MemoryId>): Promise<unknown>;
  /** この手の返り値の正規化（表に書く形）。 */
  outcome(result: unknown): string;
}

export interface Combo {
  label: string;
  setUp(kit: LifecycleKit, rt: Runtime): Promise<Record<string, MemoryId>>;
  steps: ComboStep[];
  /** 各手の後の返り値（`steps` と同じ長さ）。 */
  expectedOutcomes: string[];
  /** 最後の手の後の各 Memory の状態。 */
  expectedStates: Record<string, LifecycleState>;
}

const kindOf = (result: unknown): string => {
  const r = result as LooseResult;
  if (r.outcomes) {
    return r.outcomes.length === 0 ? "none" : r.outcomes.map((o) => o.kind).join("+");
  }
  if (typeof r.outcome === "object") {
    if (r.outcome.kind !== "ineligible") return r.outcome.kind;
    return r.outcome.sides
      ? `ineligible:${sidesOf(r)}`
      : `ineligible:${String(r.outcome.eligibility?.kind)}`;
  }
  if (r.archived) return `archived:${r.archived.length}`;
  return String(r.outcome);
};
const step = (label: string, run: ComboStep["run"]): ComboStep => ({ label, run, outcome: kindOf });

async function contestedPair(kit: LifecycleKit, rt: Runtime, decayed = false) {
  const a = await createMemory(kit, decayed);
  const b = await createMemory(kit, decayed);
  await rt.markContested(LIFECYCLE_CTX, a.id, b.id);
  return { A: a.id, B: b.id };
}
async function consolidatedPair(kit: LifecycleKit, rt: Runtime) {
  const x = await createMemory(kit, false);
  const y = await createMemory(kit, false);
  const r = await rt.consolidate(LIFECYCLE_CTX, { target: { memoryIds: [x.id, y.id] } });
  return { X: x.id, Y: y.id, S: r.consolidatedMemoryId! };
}

const ctx = LIFECYCLE_CTX;
export const LIFECYCLE_COMBOS: Combo[] = [
  {
    label:
      "contested A,B: forget A → resolve は拒む → resolveOrphanedContested(B) → もう一度は拒む",
    setUp: contestedPair,
    steps: [
      step("forget A", (rt, m) => rt.forget(ctx, { memoryId: m.A! })),
      step("resolve(B勝ち)", (rt, m) =>
        rt.resolveContested(ctx, m.A!, m.B!, { kind: "supersede", winnerId: m.B! }),
      ),
      step("resolveOrphanedContested(B)", (rt, m) => rt.resolveOrphanedContested!(ctx, m.B!)),
      step("resolveOrphanedContested(B) 2回目", (rt, m) => rt.resolveOrphanedContested!(ctx, m.B!)),
    ],
    expectedOutcomes: [
      "forgotten",
      "ineligible:status_not_contested+eligible",
      "resolved",
      "ineligible:status_not_contested",
    ],
    expectedStates: { A: "forgotten", B: "active" },
  },
  {
    label: "contested A,B: forget A → purge A → resolveOrphanedContested(B)",
    setUp: contestedPair,
    steps: [
      step("forget A", (rt, m) => rt.forget(ctx, { memoryId: m.A! })),
      step("purge A", (rt, m) => rt.purge(ctx, { memoryId: m.A! })),
      step("resolveOrphanedContested(B)", (rt, m) => rt.resolveOrphanedContested!(ctx, m.B!)),
    ],
    expectedOutcomes: ["forgotten", "purged", "resolved"],
    expectedStates: { A: "purged", B: "active" },
  },
  {
    label: "contested A,B（孤立していない）: resolveOrphanedContested(B) は拒む",
    setUp: contestedPair,
    steps: [
      step("resolveOrphanedContested(B)", (rt, m) => rt.resolveOrphanedContested!(ctx, m.B!)),
    ],
    expectedOutcomes: ["ineligible:opposite_not_orphaned"],
    expectedStates: { A: "contested", B: "contested" },
  },
  {
    label:
      "consolidate X,Y→S: forget S → purge S → restoreSuperseded(S) は統合元を戻し、S には触れない",
    setUp: consolidatedPair,
    steps: [
      step("forget S", (rt, m) => rt.forget(ctx, { memoryId: m.S! })),
      step("purge S", (rt, m) => rt.purge(ctx, { memoryId: m.S! })),
      step("restoreSuperseded(S)", (rt, m) => rt.restoreSuperseded(ctx, { supersededById: m.S! })),
    ],
    expectedOutcomes: ["forgotten", "purged", "restored+restored"],
    expectedStates: { X: "active", Y: "active", S: "purged" },
  },
  {
    label: "consolidate X,Y→S: forget X → restoreSuperseded(S) は Y だけ → 2回目は空",
    setUp: consolidatedPair,
    steps: [
      step("forget X", (rt, m) => rt.forget(ctx, { memoryId: m.X! })),
      step("restoreSuperseded(S)", (rt, m) => rt.restoreSuperseded(ctx, { supersededById: m.S! })),
      step("restoreSuperseded(S) 2回目", (rt, m) =>
        rt.restoreSuperseded(ctx, { supersededById: m.S! }),
      ),
    ],
    expectedOutcomes: ["forgotten", "restored", "none"],
    expectedStates: { X: "forgotten", Y: "active", S: "active" },
  },
  {
    label: "consolidate X,Y→S → consolidate S,Z→T → restoreSuperseded(T) は1段だけ戻す",
    setUp: async (kit, rt) => {
      const first = await consolidatedPair(kit, rt);
      const z = await createMemory(kit, false);
      const r = await rt.consolidate(ctx, { target: { memoryIds: [first.S, z.id] } });
      return { ...first, Z: z.id, T: r.consolidatedMemoryId! };
    },
    steps: [
      step("restoreSuperseded(T)", (rt, m) => rt.restoreSuperseded(ctx, { supersededById: m.T! })),
    ],
    expectedOutcomes: ["restored+restored"],
    expectedStates: { X: "superseded", Y: "superseded", S: "active", Z: "active", T: "active" },
  },
  {
    label:
      "contested A,B → resolve(A勝ち) → restoreSuperseded(A) で B が戻る → もう一度 markContested できる",
    setUp: contestedPair,
    steps: [
      step("resolve(A勝ち)", (rt, m) =>
        rt.resolveContested(ctx, m.A!, m.B!, { kind: "supersede", winnerId: m.A! }),
      ),
      step("restoreSuperseded(A)", (rt, m) => rt.restoreSuperseded(ctx, { supersededById: m.A! })),
      step("markContested(A,B)", (rt, m) => rt.markContested(ctx, m.A!, m.B!)),
    ],
    expectedOutcomes: ["resolved", "restored", "contested"],
    expectedStates: { A: "contested", B: "contested" },
  },
  {
    label: "減衰済みの contested A,B: 掃引は触らない → resolve(both) → 掃引で archived",
    setUp: (kit, rt) => contestedPair(kit, rt, true),
    steps: [
      step("sweepArchive", (rt) => rt.sweepArchive(ctx, { now: SWEEP_TO_ARCHIVE_NOW, limit: 100 })),
      step("resolve(both)", (rt, m) =>
        rt.resolveContested(ctx, m.A!, m.B!, { kind: "both_active" }),
      ),
      step("sweepArchive", (rt) => rt.sweepArchive(ctx, { now: SWEEP_ALL_NOW, limit: 100 })),
    ],
    expectedOutcomes: ["archived:0", "resolved", "archived:2"],
    expectedStates: { A: "archived", B: "archived" },
  },
  {
    label: "archived X: forget → restoreArchived は拒む → purge → restoreArchived も拒む",
    setUp: async (kit, rt) => {
      const x = await createMemory(kit, true);
      await rt.sweepArchive(ctx, { now: SWEEP_TO_ARCHIVE_NOW, limit: 100 });
      return { X: x.id };
    },
    steps: [
      step("forget", (rt, m) => rt.forget(ctx, { memoryId: m.X! })),
      step("restoreArchived", (rt, m) => rt.restoreArchived(ctx, { memoryId: m.X! })),
      step("purge", (rt, m) => rt.purge(ctx, { memoryId: m.X! })),
      step("restoreArchived", (rt, m) => rt.restoreArchived(ctx, { memoryId: m.X! })),
    ],
    expectedOutcomes: ["forgotten", "status_not_archived", "purged", "status_not_archived"],
    expectedStates: { X: "purged" },
  },
  {
    label: "統合元 X（superseded）: purge は拒む → forget → purge → restoreSuperseded(S) は Y だけ",
    setUp: consolidatedPair,
    steps: [
      step("purge X", (rt, m) => rt.purge(ctx, { memoryId: m.X! })),
      step("forget X", (rt, m) => rt.forget(ctx, { memoryId: m.X! })),
      step("purge X", (rt, m) => rt.purge(ctx, { memoryId: m.X! })),
      step("restoreSuperseded(S)", (rt, m) => rt.restoreSuperseded(ctx, { supersededById: m.S! })),
    ],
    expectedOutcomes: ["status_not_forgotten", "forgotten", "purged", "restored"],
    expectedStates: { X: "purged", Y: "active", S: "active" },
  },
];

/** 組を走らせ、各手の返り値と最後の状態を返す。 */
export async function runCombo(
  kit: LifecycleKit,
  combo: Combo,
): Promise<{ outcomes: string[]; states: Record<string, LifecycleState | "missing"> }> {
  const rt = kit.makeRuntime(lifecycleLlm);
  const ids = await combo.setUp(kit, rt);
  const outcomes: string[] = [];
  for (const s of combo.steps) {
    outcomes.push(s.outcome(await s.run(rt, ids)));
  }
  const states: Record<string, LifecycleState | "missing"> = {};
  for (const name of Object.keys(combo.expectedStates)) {
    states[name] = await stateOf(kit, ids[name]!);
  }
  return { outcomes, states };
}

// ---------------------------------------------------------------------------
// reextract のマス

/** 1回目の抽出だけ失敗させ（全文フォールバックの Memory を作る）、2回目（reextract）は成功させる LLM。 */
function failFirstExtractionLlm(): LLMProvider {
  let calls = 0;
  return {
    complete: async () => ({ content: "unused" }),
    completeStructured: async (_ctx, req) => {
      calls += 1;
      if (calls === 1) throw new Error("最初の抽出は失敗させる");
      if ((req.schema as unknown) !== ExtractionResultSchema) {
        return lifecycleLlm.completeStructured(_ctx, req);
      }
      return req.schema.parse({
        memories: [{ content: "抽出し直した事実", provenanceKind: "stated" }],
      });
    },
  };
}

export async function runReextractCell(
  kit: LifecycleKit,
  oldState: ReextractOldState,
): Promise<{
  old: LifecycleState | "missing";
  oldEvents: string[];
  superseded: number;
  skipped: string[];
  newMemories: number;
}> {
  const rt = kit.makeRuntime(failFirstExtractionLlm());
  const o = await rt.observe(ctx, { kind: "utterance", text: `元の発話 ${Math.random()}` });
  const oldId = o.memoryIds[0]!;
  if (oldState === "contested") {
    await rt.markContested(ctx, oldId, (await createMemory(kit, false)).id);
  } else if (oldState === "forgotten") {
    await rt.forget(ctx, { memoryId: oldId });
  } else if (oldState === "purged") {
    await rt.forget(ctx, { memoryId: oldId });
    await rt.purge(ctx, { memoryId: oldId });
  }
  const before = await eventsOf(kit, oldId);
  const r = await rt.reextract(ctx, o.observationId);
  return {
    old: await stateOf(kit, oldId),
    oldEvents: newEventKinds(before, await eventsOf(kit, oldId)),
    superseded: r.supersededMemoryIds.length,
    skipped: r.skipped.map((s) =>
      "status" in s ? `${s.kind}:${(s as { status: string }).status}` : s.kind,
    ),
    newMemories: r.memoryIds.filter((id) => id !== oldId).length,
  };
}

// ---------------------------------------------------------------------------
// docs/memory-model.md §11 の表との結び目

/**
 * §11 の表の行と、この表のマスの対応。**§11 の「遷移」列と「残るイベント」列を読み、
 * 対応するマスと食い違ったら赤にする**（`lifecycle-transition-table.test.ts`）。
 * - `from`: §11 の遷移の左辺（`任意` はどの出発状態でもよい、の意）
 * - `to`: §11 の遷移の右辺。複数（`active | superseded`）なら x と相手のどちらかで満たす
 * - `event`: 「残るイベント」列の最初のバッククォートの語
 */
export const DOC_ROW_LINKS: Array<{ row: number; state: LifecycleState; op: LifecycleOp }> = [
  { row: 5, state: "active", op: "consolidate" },
  { row: 6, state: "active", op: "markContested" },
  { row: 7, state: "contested", op: "resolveContested(x勝ち)" },
  { row: 8, state: "active", op: "sweepArchive" },
  { row: 9, state: "active", op: "forget" },
  { row: 10, state: "forgotten", op: "purge" },
  { row: 14, state: "archived", op: "restoreArchived" },
  { row: 15, state: "superseded", op: "restoreSuperseded" },
];

/** 表のセルの中の `\\|`（エスケープした縦棒）を、列の区切りと区別するための一時的な置き換え先（私用領域の文字）。 */
const ESCAPED_PIPE = "\uE000";

/** §11 の表から、行番号 → { from, to[], event } を読む（`\|` のエスケープを解く）。 */
export function parseLifecycleTable(
  markdown: string,
): Map<number, { from: string; to: string[]; events: string[] }> {
  const rows = new Map<number, { from: string; to: string[]; events: string[] }>();
  const section = markdown.split("## 11. Memory lifecycle")[1] ?? "";
  for (const line of section.split("\n")) {
    const m = /^\| (\d+) \|/.exec(line);
    if (!m) continue;
    const cells = line
      .replaceAll("\\|", ESCAPED_PIPE)
      .split("|")
      .map((c) => c.replaceAll(ESCAPED_PIPE, "|").trim());
    const transition = cells[2] ?? "";
    const [fromRaw, toRaw] = transition.split("→").map((s) => s.trim());
    const to = (toRaw ?? "")
      .replace(/（.*$/, "")
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const events = [...(cells[6] ?? "").matchAll(/`([a-z_]+)`/g)].map((mm) => mm[1]!);
    rows.set(Number(m[1]), { from: (fromRaw ?? "").trim(), to, events });
  }
  return rows;
}
