import { describe, expect, it } from "vitest";
import {
  EVENT_RETENTION_KIND_INVALID_MESSAGE,
  assertValidEventRetentionKind,
} from "../interfaces/tenant-settings-store.js";

/**
 * `assertValidEventRetentionKind` は、`kind` が文字列の `"unlimited"`・`"days"` の**どちらかとちょうど一致するとき以外**を
 * `EVENT_RETENTION_KIND_INVALID_MESSAGE` の `Error` で拒む（Issue #1168）。
 * 拒まれなかった型の外の値は、後段の `kind === "days"` が偽になり、黙って無期限として書かれる。
 *
 * 既存の歯（`event-retention-kind-validation.postgres.test.ts`・`fake-tenant-settings-write-validation.test.ts`）は
 * `bogus`・`Days`・空文字・`kind` 無しだけを渡す。ここは、それが試していない2つの形を縛る。
 * - 前後に空白・改行のある綴り（`" days"`・`"days "`・`"unlimited\n"`）: 前後の空白を落として比べる実装は、これらを通す。
 * - 文字列でない値（`null`・数値・オブジェクト）: JSON を素通しする呼び手が渡しうる。文字列に直して比べる実装は、これらの一部を通す。
 *
 * 型の中の2つは、通る（陽性対照）。
 */

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
