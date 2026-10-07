import { describe, expect, it } from "vitest";
import {
  EVENT_RETENTION_KIND_INVALID_MESSAGE,
  assertValidEventRetentionKind,
} from "../interfaces/tenant-settings-store.js";

/** 前後に空白・改行のある綴りは、前後の空白を落として比べる実装が通してしまう。文字列でない値（JSON を素通しする呼び手が渡しうる）は、文字列に直して比べる実装が一部を通してしまう。型の中の2つは通る（陽性対照）。 */

const REJECTED: Array<[string, unknown]> = [
  ["先頭に空白（' days'）", " days"],
  ["末尾に空白（'days '）", "days "],
  ["末尾に改行（'unlimited\\n'）", "unlimited\n"],
  ["大文字（'DAYS'）", "DAYS"],
  ["null", null],
  ["数値 0", 0],
  ["数値 1", 1],
  ["空のオブジェクト", {}],
  ["要素1つの配列 ['days']", ["days"]],
  ["undefined", undefined],
  ["真偽値 false", false],
];

describe("assertValidEventRetentionKind: unlimited・days とちょうど一致するものだけを通す", () => {
  it.each(REJECTED)(
    "%s は EVENT_RETENTION_KIND_INVALID_MESSAGE の Error で拒む",
    (_label, value) => {
      expect(() => assertValidEventRetentionKind(value as string)).toThrow(
        EVENT_RETENTION_KIND_INVALID_MESSAGE,
      );
    },
  );

  it.each(["unlimited", "days"])("陽性対照: %s は通る", (value) => {
    expect(() => assertValidEventRetentionKind(value)).not.toThrow();
  });
});
