import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { NewMemoryEventSchema, NewMemoryEvent } from "../event.js";
import type { NewMemorySchema, NewMemory } from "../memory.js";
import type { NewObservationSchema, NewObservation } from "../observation.js";
import type { OutboxJobRecordSchema, OutboxJobRecord } from "../outbox.js";

/**
 * `Equals` が通らず `MutualAssignable` に落とした組（intersection 型・開いたブランド型）は、
 * 型だけに任意の欄を足しても相互代入可能のままで、`satisfies` も `MutualAssignable` も気づかない。
 * キーの集合を `Equals` で突き合わせれば、値の型は弱い形のままでも、欄の足し引きは拾える。
 */
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type _k1_NewMemory = Expect<Equals<keyof z.infer<typeof NewMemorySchema>, keyof NewMemory>>;
type _k2_NewObservation = Expect<
  Equals<keyof z.infer<typeof NewObservationSchema>, keyof NewObservation>
>;
type _k3_NewMemoryEvent = Expect<
  Equals<keyof z.infer<typeof NewMemoryEventSchema>, keyof NewMemoryEvent>
>;
type _k4_OutboxJobRecord = Expect<
  Equals<keyof z.infer<typeof OutboxJobRecordSchema>, keyof OutboxJobRecord>
>;

const THIS_FILE = join(__dirname, "schema-type-keys-recheck-0916.test.ts");
const EXPECTED_KEY_PAIRS = 4;

describe("schema ↔ 型 のキー集合の一致（弱い形で固定している組）", () => {
  it(`_kNN 宣言が${EXPECTED_KEY_PAIRS}本あり、番号に重複も欠番も無い`, () => {
    const numbers = [
      ...readFileSync(THIS_FILE, "utf8").matchAll(/^type _k(\d+)_[A-Za-z]+ =/gm),
    ].map((m) => Number(m[1]));
    expect(numbers.sort((a, b) => a - b)).toEqual(
      Array.from({ length: EXPECTED_KEY_PAIRS }, (_, i) => i + 1),
    );
  });
});
