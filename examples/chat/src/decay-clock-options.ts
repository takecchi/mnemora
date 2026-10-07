import type { DecayClock } from "@mnemora/core";
import { assertValidDecayClock } from "@mnemora/core";

/**
 * `examples/chat` の CLI が受け付ける `--decay-clock <wall|activity|either>` フラグ（ADR 0165 決めたこと11）。
 *
 * 既存のオプション（`archive-sweep-options.ts`/`consolidation-cost-options.ts`）とはあえて形を変えている。
 * それらは環境変数から読むベンチ専用の調整値だが、これは利用者が明示的に選ぶ設定なので、`process.argv` の CLI フラグで通す。
 */
export const DECAY_CLOCK_FLAG = "--decay-clock";

/**
 * `argv` から `--decay-clock <value>` を取り出す純関数。
 *
 * フラグが無ければ `undefined`。この場合、呼び出し側は `writeDecayClock` を一度も呼んではならない
 * （既定挙動を1バイトも変えないための唯一の契約、ADR 0165 決めたこと1・13）。
 * フラグは在るが値が無ければ `Error`。値が3値のいずれでもなければ `assertValidDecayClock` が `Error` を投げる。
 * 検査の条件式をここで書き直さない。
 */
export function parseDecayClockFlag(argv: readonly string[]): DecayClock | undefined {
  const index = argv.indexOf(DECAY_CLOCK_FLAG);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`${DECAY_CLOCK_FLAG} には値が要る('wall'|'activity'|'either')。`);
  }
  assertValidDecayClock(value);
  return value;
}
