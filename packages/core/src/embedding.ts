import { z } from "zod";

/** 埋め込み空間の識別子。 */
export interface EmbeddingSpaceId {
  /** 埋め込みの provider の名前（例: `openai`・`local`・`testkit`）。 */
  provider: string;
  /** モデルの名前。 */
  model: string;
  /** ベクトルの次元。 */
  dimensions: number;
}

/** `EmbeddingSpaceId` の zod スキーマ。値を実行時に検査するときに使う（型 `EmbeddingSpaceId` と揃えてある）。 */
export const EmbeddingSpaceIdSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
}) satisfies z.ZodType<EmbeddingSpaceId>;
