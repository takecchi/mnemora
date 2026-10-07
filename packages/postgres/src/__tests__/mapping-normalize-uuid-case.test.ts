import { describe, expect, it } from "vitest";
import { normalizeUuidCase } from "../mapping.js";

/** 形の合わない id を小文字にしてしまうと、大文字小文字を区別する綴りの id（`"Not-A-UUID"` など）が、store の入口で別の id に化ける。何でも小文字にしても赤にならないよう、形の合わない id が変わらないことを見る。 */
describe("normalizeUuidCase: uuid の形の id だけを小文字にする", () => {
  it("大文字の uuid は小文字になる", () => {
    expect(normalizeUuidCase("0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D")).toBe(
      "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
    );
  });

  it("大文字小文字が混ざった uuid も小文字になる", () => {
    expect(normalizeUuidCase("0a1B2c3D-4e5F-6a7B-8c9D-0e1F2a3B4c5D")).toBe(
      "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
    );
  });

  it("小文字の uuid はそのまま", () => {
    expect(normalizeUuidCase("0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d")).toBe(
      "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
    );
  });

  it.each([
    "Not-A-UUID",
    "MEM-3",
    "Does-Not-Exist",
    "",
    // uuid の形に1字足りない・多い・16進でない字を含む（大文字を含むので、小文字にすると変わる）
    "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5",
    "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5DE",
    "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5G",
    // uuid を含むが、前後に余計な字が付く（全体では uuid の形でない）
    " 0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D",
    "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D ",
    "X0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D",
  ])("uuid の形でない id %j は、小文字にせずそのまま返す", (id) => {
    expect(normalizeUuidCase(id)).toBe(id);
  });
});
