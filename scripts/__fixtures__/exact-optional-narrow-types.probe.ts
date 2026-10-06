/**
 * `exactOptionalPropertyTypes: true` の利用者でも、**広げなかった型**は `undefined` を受け取らない（ADR 0429
 * 「広げなかったもの」）。確かめ直し（Issue #1734、PR #1534）で足した、反対向きの検査の対象ソース。
 * `scripts/__tests__/exact-optional-narrow-types.test.mjs` が、このファイルだけを
 * `exactOptionalPropertyTypes: true` で型検査し、診断が0件であることを確かめる。
 *
 * 各行の `@ts-expect-error` は「ここは型エラーでなければならない」の印。型を広げすぎると、エラーが消えて
 * `@ts-expect-error` が未使用（TS2578）になり、検査が落ちる。
 *
 * 1. `Ctx`・`OutboxJob`：利用者の自前の adapter が受け取る側でもある型（受け取った値を狭い型へ代入するコードが
 *    壊れうるので広げなかった）。
 * 2. `Memory`：出力にも使う型。
 * 3. testkit の `build*Fixture` の `overrides`：`{...base, ...overrides}` なので、`undefined` が既定値を上書きする。
 */
import type { Ctx, Memory, OutboxJob } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";

// @ts-expect-error `Ctx.subjectId` は広げていない
export const _ctx: Ctx = { tenantId: "t", subjectId: undefined };

// @ts-expect-error `OutboxJob.availableAt` は広げていない
export const _job: OutboxJob = {
  id: "1",
  tenantId: "t",
  kind: "embed",
  payload: {},
  availableAt: undefined,
};

// @ts-expect-error `Memory`（出力にも使う型）の `subjectId` は広げていない
export const _memory: Pick<Memory, "subjectId"> = { subjectId: undefined };

// @ts-expect-error `build*Fixture` の overrides は `undefined` を受け取らない（既定値を上書きしてしまう）
export const _fixture = buildNewMemoryFixture({ halfLifeHours: undefined });
