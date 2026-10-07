import { z } from "zod";

/**
 * 呼び手が申告する任意属性（ADR 0312）。
 *
 * `tags` は LLM の推論だが、`attributes` は呼び手の申告であり、抽出器（LLM）はこの値を生成も参照も
 * しない。由来の違う2つの値を同じ欄に混ぜない。
 *
 * 値の型を `string` に絞っている（`unknown` にしない）のは、`jsonb` の containment 演算子（`@>`）で
 * 等値比較できるようにして GIN 索引（`jsonb_path_ops`）を効かせるため。
 */
export type Attributes = Record<string, string>;

/**
 * `Attributes` の上限（ADR 0312）。
 *
 * **この3つの数値は実測していない。** 他の属性・タグ付けの実務慣行を参考にした保守的な初期値で、
 * 緩めるのは後からできるが、締めるのは破壊的変更になるため控えめに絞ってある。
 */
export const ATTRIBUTES_MAX_KEYS = 16;
/** 1キーの最小・最大文字数。 */
export const ATTRIBUTE_KEY_MIN_LENGTH = 1;
/** 1キーの最大文字数。これを超えるキーは拒む（`ATTRIBUTE_KEY_MIN_LENGTH` と組）。 */
export const ATTRIBUTE_KEY_MAX_LENGTH = 64;
/** 1値の最大文字数（空文字は許す——「キーはあるが値を空にしたい」ケースを塞がない）。 */
export const ATTRIBUTE_VALUE_MAX_LENGTH = 256;

/**
 * キーの文字種（ADR 0312）。ASCII の英数字・`_`・`-`・`.`・`:` に絞る。
 *
 * Unicode のキーを禁じる強い理由は無く、要望が出たら緩める（締めるより緩める方が安全な変更）。
 *
 * この文字種はキー `__proto__` を通すが、`Runtime.observe`・`Runtime.recall`（`runRecall`）の入口が
 * 断る（ADR 0496、`attributes-guard.ts`）。zod の record がキーの検査より前に `__proto__` を読み
 * 飛ばすので、この schema の中では断れない。`AttributesSchema` を直接 `parse` する呼び出しは
 * `__proto__` を落として通す。`constructor`・`prototype` などは落ちないので断らない。
 */
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * `Attributes` の zod 表現。**この schema を通す箇所（`ObserveXxxInput.attributes` /
 * `RecallQuery.attributes`）でだけ検査される**。`Memory.attributes`/`Observation.attributes`
 * 等、格納・伝播側の型には validation を持たせない。
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
 * が使う、検査をしない zod 表現。書き込み経路では走らない。
 */
export const StoredAttributesSchema = z.record(z.string(), z.string());
