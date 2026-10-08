import { describe, expect, it } from "vitest";
import { sha256Hex } from "../content-hash.js";

/**
 * 保存済みの `content_hash` と、これから書く値が一致し続けることを見る（DB には繋がない）。
 * 期待値は SHA-256 の既知の値を固定する。`createHash` で期待値を計算し直すと、実装と同じ誤りを共有する。
 * 非 ASCII は UTF-8 のバイト列で数える。前後の空白や Unicode の正規化はしない（字面が違えば別の値）。
 */

describe("sha256Hex: content の SHA-256 を小文字の hex で返す", () => {
  it("ASCII: 空文字と abc は既知の値になる", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("非 ASCII は UTF-8 のバイト列の値になる", () => {
    expect(sha256Hex("日本語")).toBe(
      "77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5",
    );
  });

  it("前後の空白は落とさない", () => {
    expect(sha256Hex(" abc ")).toBe(
      "3eaf1941003943dfaa935adecffcaaa217e290def6fb0181141ced6c9daabaad",
    );
  });

  it("Unicode の正規化はしない: 合成済みの é と、e + 結合アクセントは別の値", () => {
    expect(sha256Hex("\u00e9")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
    expect(sha256Hex("e\u0301")).toBe(
      "bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6",
    );
  });
});
