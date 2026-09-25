import { describe, expect, it } from "vitest";
import {
  binomialAtLeastK,
  binomialPMF,
  empiricalKOfNRedRate,
  pairAgreementRedRate,
} from "../verdict-candidate-kofn.js";

describe("binomialPMF", () => {
  it("p=0.5, n=2 の分布は 1/4, 1/2, 1/4(パスカルの三角形で検算)", () => {
    expect(binomialPMF(0, 2, 0.5)).toBeCloseTo(0.25, 10);
    expect(binomialPMF(1, 2, 0.5)).toBeCloseTo(0.5, 10);
    expect(binomialPMF(2, 2, 0.5)).toBeCloseTo(0.25, 10);
  });

  it("全kについて合計すると1になる(n=5, p=0.3)", () => {
    let sum = 0;
    for (let k = 0; k <= 5; k += 1) {
      sum += binomialPMF(k, 5, 0.3);
    }
    expect(sum).toBeCloseTo(1, 10);
  });

  it("範囲外の k は 0", () => {
    expect(binomialPMF(-1, 3, 0.5)).toBe(0);
    expect(binomialPMF(4, 3, 0.5)).toBe(0);
  });
});

describe("binomialAtLeastK", () => {
  it("n=2,k=2,p=0.5 は0.25(両方 red の確率)", () => {
    expect(binomialAtLeastK(2, 2, 0.5)).toBeCloseTo(0.25, 10);
  });

  it("n=3,k=2,p=0.5 は0.5(過半数)", () => {
    expect(binomialAtLeastK(2, 3, 0.5)).toBeCloseTo(0.5, 10);
  });

  it("k=0 は常に1", () => {
    expect(binomialAtLeastK(0, 5, 0.3)).toBeCloseTo(1, 10);
  });

  it("n=n(全部red)の確率は p^n", () => {
    expect(binomialAtLeastK(4, 4, 0.2)).toBeCloseTo(0.2 ** 4, 10);
  });

  it("k=nを2つに固定してpを上げると確率も上がる(単調性)", () => {
    const low = binomialAtLeastK(2, 2, 0.1);
    const high = binomialAtLeastK(2, 2, 0.5);
    expect(high).toBeGreaterThan(low);
  });

  it("ADR 0316 実測値(11/59)を n=2,k=2 に当てはめると、単独より低くなる", () => {
    const p = 11 / 59;
    const single = p;
    const twoOfTwo = binomialAtLeastK(2, 2, p);
    expect(twoOfTwo).toBeLessThan(single);
  });
});

describe("empiricalKOfNRedRate", () => {
  it("n=1,k=1 なら元の red 率そのまま", () => {
    const flags = [true, false, true, true, false];
    const r = empiricalKOfNRedRate(flags, 1, 1);
    expect(r.windowCount).toBe(5);
    expect(r.redWindowCount).toBe(3);
    expect(r.redRate).toBeCloseTo(0.6, 10);
  });

  it("n=2,k=2(両方red必須)は、隣接窓が両方redのときだけ数える", () => {
    // [T,T, F,T, T,T] -> 窓1=[T,T]both -> red, 窓2=[F,T]片方 -> green, 窓3=[T,T]both -> red
    const flags = [true, true, false, true, true, true];
    const r = empiricalKOfNRedRate(flags, 2, 2);
    expect(r.windowCount).toBe(3);
    expect(r.redWindowCount).toBe(2);
  });

  it("端数(n で割り切れない分)は捨てる", () => {
    const flags = [true, true, true]; // n=2 -> 1window(先頭2件)、末尾1件は捨てる
    const r = empiricalKOfNRedRate(flags, 2, 2);
    expect(r.windowCount).toBe(1);
    expect(r.redWindowCount).toBe(1);
  });

  it("windowCount=0のときは red 率0・上限null", () => {
    const r = empiricalKOfNRedRate([true], 2, 2);
    expect(r.windowCount).toBe(0);
    expect(r.redRate).toBe(0);
    expect(r.clopperPearsonUpperBound95).toBeNull();
  });

  it("windowCount>0のときはClopper-Pearson上限を返す(既存関数を呼ぶだけ、値の検算は openai-arm-verdict.test.ts 側)", () => {
    const flags = Array.from({ length: 10 }, () => false);
    const r = empiricalKOfNRedRate(flags, 1, 1);
    expect(r.clopperPearsonUpperBound95).not.toBeNull();
    expect(r.clopperPearsonUpperBound95!).toBeGreaterThan(0);
    expect(r.clopperPearsonUpperBound95!).toBeLessThan(1);
  });

  it("n<=0 やk範囲外は例外", () => {
    expect(() => empiricalKOfNRedRate([true], 0, 1)).toThrow(/n は正の整数/);
    expect(() => empiricalKOfNRedRate([true, true], 2, 0)).toThrow(/k は/);
    expect(() => empiricalKOfNRedRate([true, true], 2, 3)).toThrow(/k は/);
  });
});

describe("pairAgreementRedRate", () => {
  it("両方redのroundだけ数える", () => {
    const pairs = [
      { a: true, b: true },
      { a: true, b: false },
      { a: false, b: false },
      { a: true, b: true },
    ];
    const r = pairAgreementRedRate(pairs);
    expect(r.trials).toBe(4);
    expect(r.redCount).toBe(2);
    expect(r.redRate).toBeCloseTo(0.5, 10);
  });

  it("完全一致(sparse=dense常に同じ)のときは単独redRateと同じになる", () => {
    const flags = [true, false, false, true, false];
    const pairs = flags.map((f) => ({ a: f, b: f }));
    const r = pairAgreementRedRate(pairs);
    expect(r.redCount).toBe(flags.filter(Boolean).length);
  });

  it("trials=0ならredRate=0・上限null", () => {
    const r = pairAgreementRedRate([]);
    expect(r.trials).toBe(0);
    expect(r.redRate).toBe(0);
    expect(r.clopperPearsonUpperBound95).toBeNull();
  });
});
