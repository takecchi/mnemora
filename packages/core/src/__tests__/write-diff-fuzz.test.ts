import { describe, expect, it } from "vitest";
import { breakReinforce, diffWriteSeeds, fakeWriteFuzzBackend } from "./write-diff-fuzz-harness.js";

/**
 * 書き込み側の差分ファズ（`write-diff-fuzz-harness.ts`。何を比べて何を比べないかは、そこの
 * doc コメントに在る——ここには写さない）を、Fake 同士で回す。
 *
 * - 同じ Fake を2つ立てて突き合わせ、食い違いが0であること——検査器そのものが決定的に動き、
 *   別名の付け方が id の形（連番）に依らないことを見る。
 * - **陽性対照**: 片方の `reinforce` を「何も書かない」に壊すと、食い違いが報告されること。
 *   検査器が黙って何も比べなくなる回帰（別名が全部同じになる・状態を読んでいない等）を捕まえる。
 *
 * Postgres と突き合わせるのは `packages/postgres/src/__tests__/write-diff-fuzz.postgres.test.ts`。
 * `WRITE_FUZZ_SEEDS`・`WRITE_FUZZ_LEN` で本数と長さを変えられる。
 */

const SEEDS = Number(process.env.WRITE_FUZZ_SEEDS ?? 20);
const LEN = Number(process.env.WRITE_FUZZ_LEN ?? 60);
const POSITIVE_CONTROL_SEEDS = 5;
// 時計は実時刻より先から始める。歴史的な理由で残しているが、今は `available_at` も注入した時計に
// 従う（ADR 0559）。1回の実行の中では両方の backend で同じ値を使う。
const T0 = Date.now() + 86_400_000;

describe("書き込み側の差分ファズ（Fake 同士）", () => {
  it(`${SEEDS} シード × ${LEN} 手で、2つの Fake の戻り値と状態が1手ごとに一致する`, async () => {
    const report = await diffWriteSeeds(
      fakeWriteFuzzBackend("fakeA"),
      fakeWriteFuzzBackend("fakeB"),
      {
        seeds: SEEDS,
        len: LEN,
        t0: T0,
      },
    );
    expect(report).toBe("");
  }, 300_000);

  it("陽性対照: 片方の reinforce を壊すと、食い違いが報告される", async () => {
    const report = await diffWriteSeeds(
      fakeWriteFuzzBackend("fake"),
      fakeWriteFuzzBackend("fake-broken-reinforce"),
      {
        // 食い違いが1つ見えれば足りるので、本数は絞る。
        seeds: POSITIVE_CONTROL_SEEDS,
        len: LEN,
        t0: T0,
        wrapB: breakReinforce,
      },
    );
    expect(report).not.toBe("");
    expect(report).toMatch(/lastReinforcedAt|"k":"reinforce"|"k":"usage"/);
  }, 300_000);
});
