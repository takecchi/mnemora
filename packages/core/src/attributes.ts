import { z } from "zod";

/**
 * 呼び手が申告する任意属性（Issue #152 / #153、ADR 0306）。
 *
 * **`tags`（`extraction.ts`/`memory.ts`）との違い**: `tags` は 100% LLM の推論（
 * `buildExtractionPrompt` が語彙・粒度を一切指示しない自由記述）だが、`attributes` は
 * 100% 呼び手の申告であり、抽出器（LLM）はこの値を一度も生成しない・見ない。
 * 北極星の問い4（「AI の推論と、ユーザーが言った事実を、区別しているか」）に沿って、
 * 由来の違う2つの値を同じ欄に混ぜない——ADR 0306 の決定1・「採らなかった案」参照。
 *
 * **値の型を `string` に絞っている理由（`unknown`/`unknown[]` にしない）**: ADR 0006
 * （`docs/decisions/0006-*.md` 相当、`buildProvenance` 等が参照する契約 DB 設計判断）が
 * 「単一の JSON カラムに全部入れる」設計を「索引が効くフィルタを要求する recall の
 * 二段検索と正面から衝突する」として却下している。値を `string` の等値比較に絞ることで、
 * `jsonb` の containment 演算子（`@>`）に素直に落ち、GIN 索引（`jsonb_path_ops`）が効く
 * ——ADR 0306 決定2参照。
 */
export type Attributes = Record<string, string>;

/**
 * `Attributes` の上限（ADR 0306 決定7「キー空間の規律」）。
 *
 * ⚠ **この3つの数値は実測していない。** 本番の `jsonb` サイズ・GIN 索引サイズを計測した
 * 結果ではなく、他の属性/タグ付けの実務慣行（Stripe の `metadata`: 最大50キー・
 * キー長40・値長500、DataDog のタグ: 値長200 程度）を参考にした保守的な初期値である。
 * **緩めるのは後からできるが、締めるのは破壊的変更になる**（ADR 0306 決定7・
 * `docs/migration-v1.md` の数え方）——そのため最初から控えめに絞ってある。
 * 実運用の分布が測れたら見直すこと（`DIGEST_BAND_MAX_ENTRY_CHARS` の doc コメントと
 * 同じ姿勢——勘ではなく実測で見直す）。
 */
export const ATTRIBUTES_MAX_KEYS = 16;
/** 1キーの最小・最大文字数。 */
export const ATTRIBUTE_KEY_MIN_LENGTH = 1;
export const ATTRIBUTE_KEY_MAX_LENGTH = 64;
/** 1値の最大文字数（空文字は許す——「キーはあるが値を空にしたい」ケースを塞がない）。 */
export const ATTRIBUTE_VALUE_MAX_LENGTH = 256;

/**
 * キーの文字種（ADR 0306 決定7）。ASCII の英数字・`_`・`-`・`.`・`:` に絞る。
 *
 * **理由**: `attributes` は `jsonb` の key として格納され、`@>` の等値比較にしか使わない
 * ——キーそのものを人が読む・ログに残す・将来 URL やパス相当の合成に使う可能性を考えると、
 * 制御文字・空白・記号を許すと事故（誤った空白の混入に気づかない、ログ出力で改行が壊れる等）
 * の元になる。**Unicode のキーを禁じる強い理由は無い**——実運用でその要望が出たら緩める
 * （このリストは締めるより緩める方が安全な変更である）。
 */
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * `Attributes` の zod 表現。**この schema を通す箇所（`ObserveXxxInput.attributes` /
 * `RecallQuery.attributes`）でだけ検査される**——`Memory.attributes`/`Observation.attributes`
 * 等、格納・伝播側の型には validation を持たせない（ADR 0306 決定2「欄を渡したときだけ
 * 検査される」)。
 */
export const AttributesSchema = z
  .record(
    z
      .string()
      .min(ATTRIBUTE_KEY_MIN_LENGTH)
      .max(ATTRIBUTE_KEY_MAX_LENGTH)
      .regex(ATTRIBUTE_KEY_PATTERN, "attributes key must match " + ATTRIBUTE_KEY_PATTERN.source),
    z.string().max(ATTRIBUTE_VALUE_MAX_LENGTH),
  )
  .refine((value) => Object.keys(value).length <= ATTRIBUTES_MAX_KEYS, {
    message: `attributes may have at most ${ATTRIBUTES_MAX_KEYS} keys`,
  }) satisfies z.ZodType<Attributes>;

/**
 * 格納・伝播側（`Memory.attributes` / `Observation.attributes` / `RecalledMemory.attributes`）
 * が使う、検査をしない zod 表現。**書き込み経路では走らない**——`memory.ts`/`observation.ts`
 * の他の schema と同じ規律（`MemorySchema.strength` の doc コメント参照）で、型の導出元・
 * `schema-type-equals-parity` の検算にのみ使う。
 */
export const StoredAttributesSchema = z.record(z.string(), z.string());
