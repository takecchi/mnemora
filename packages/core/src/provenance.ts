import { z } from "zod";

/**
 * Memory がどこから来たかを表す判別可能ユニオン（docs/memory-model.md §2）。
 *
 * AI の推論とユーザーが言った事実の区別は、追加のフラグではなく `kind` の値そのもので表す。
 */
export type ProvenanceKind = "stated" | "inferred" | "consolidated" | "reflected" | "imported";

/** `ProvenanceKind` の綴りを1箇所にまとめた zod 表現（`recall.ts` の `excludeProvenanceKinds` も使う）。 */
export const ProvenanceKindSchema = z.enum([
  "stated",
  "inferred",
  "consolidated",
  "reflected",
  "imported",
]) satisfies z.ZodType<ProvenanceKind>;

/** 話者が言ったこととして記録された Memory の出所（抽出が `provenanceKind: "stated"` にした候補）。 */
export interface StatedProvenance {
  /** 常に `"stated"`。 */
  kind: "stated";
  /** 元になった Observation の id。 */
  sourceObservationId: string;
  /** 話者（Observation に話者があるときだけ入る）。 */
  speaker?: string;
  /** 元の Observation の時刻（`occurredAt`、無ければ `recordedAt`）の ISO 8601 文字列。 */
  at: string;
}

/** LLM が推論した Memory の出所。推論は根拠（`basis`）と一緒に持つ（docs/memory-model.md §2）。 */
export interface InferredProvenance {
  /** 常に `"inferred"`。 */
  kind: "inferred";
  /** 推論した LLM のモデル名（`RuntimeConfig.llmModelId`。省略時は `"unknown"`）。 */
  model: string;
  /** 推論に使ったプロンプトの版。 */
  promptVersion: string;
  /** 推論の根拠。抽出が作る推論では、元の Observation 1件を `observationIds` に持ち、`memoryIds` は空。 */
  basis: { memoryIds: string[]; observationIds: string[] };
  /** 確信度（抽出の候補が付けた値。無ければ `0.5`）。 */
  confidence: number;
}

/** `consolidate` が複数の Memory を統合して作った Memory の出所。 */
export interface ConsolidatedProvenance {
  /** 常に `"consolidated"`。 */
  kind: "consolidated";
  /** 統合元の Memory の id。 */
  sources: string[]; // memoryIds
}

/** `reflect` が作った Memory の出所。 */
export interface ReflectedProvenance {
  /** 常に `"reflected"`。 */
  kind: "reflected";
  /** 土台になった Memory の id（省略できる）。 */
  sources?: string[]; // memoryIds, 省略可
}

/** 外部から取り込んだ Memory の出所。 */
export interface ImportedProvenance {
  /** 常に `"imported"`。 */
  kind: "imported";
  /** 取り込みの単位の id（呼び出し側が決める）。 */
  batchId: string;
}

/** Memory がどこから来たか（上の doc）。`kind` で判別する。 */
export type Provenance =
  | StatedProvenance
  | InferredProvenance
  | ConsolidatedProvenance
  | ReflectedProvenance
  | ImportedProvenance;

const StatedProvenanceSchema = z.object({
  kind: z.literal("stated"),
  sourceObservationId: z.string().min(1),
  speaker: z.string().min(1).optional(),
  at: z.string().min(1),
}) satisfies z.ZodType<StatedProvenance>;

const InferredProvenanceSchema = z.object({
  kind: z.literal("inferred"),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  basis: z.object({
    memoryIds: z.array(z.string().min(1)),
    observationIds: z.array(z.string().min(1)),
  }),
  confidence: z.number().min(0).max(1),
}) satisfies z.ZodType<InferredProvenance>;

const ConsolidatedProvenanceSchema = z.object({
  kind: z.literal("consolidated"),
  sources: z.array(z.string().min(1)).min(1),
}) satisfies z.ZodType<ConsolidatedProvenance>;

const ReflectedProvenanceSchema = z.object({
  kind: z.literal("reflected"),
  sources: z.array(z.string().min(1)).optional(),
}) satisfies z.ZodType<ReflectedProvenance>;

const ImportedProvenanceSchema = z.object({
  kind: z.literal("imported"),
  batchId: z.string().min(1),
}) satisfies z.ZodType<ImportedProvenance>;

export const ProvenanceSchema = z.discriminatedUnion("kind", [
  StatedProvenanceSchema,
  InferredProvenanceSchema,
  ConsolidatedProvenanceSchema,
  ReflectedProvenanceSchema,
  ImportedProvenanceSchema,
]) satisfies z.ZodType<Provenance>;
