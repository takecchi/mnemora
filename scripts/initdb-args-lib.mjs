/**
 * ⛔ `C` / `POSIX` はどの encoding とも両立する(実測。ADR 0196)。表に `C: "SQL_ASCII"` と書いてはならない(かつて誤りだった)。
 *
 * ⛔ 「選んだ encoding が SQL_ASCII なら常に通る」はモデル化しない。initdb は SQL_ASCII を選んだ場合に整合検査を免除するが、
 * 取り込むと、未知のロケール + `SQL_ASCII` の脚が挙がらなくなり、下の「未知のロケールは安全側に倒す」が崩れる。
 * その分この歯は過剰に挙げる(安全側。ADR 0196)。
 *
 * ⛔ `--locale=C` を無条件に要求しない。UTF8 脚に `--locale=` が無いのが正しい。見るのは「脚が自己無矛盾であること」だけ。
 *
 * ⛔ 未知のロケールは「わかったことにして通す」より安全側(=挙げる)に倒す。表に実測を足してから緑にすること。
 *
 * ⚠ `DEFAULT_LOCALE_IMPLIED_ENCODING = "UTF8"` は検算していない。根拠は CI コンテナの既定ロケールが `en_US.utf8` であることで、
 * 実測した器の既定は `POSIX`。この行を「ついでに」動かさない。
 *
 * ⚠ `--no-locale` / `--lc-collate=` / `--lc-ctype=` は解釈していない。いずれも赤に倒れる(誤って緑にはならない)。
 * `ci.yml` が使い始めたら、実測してからこの関数を広げること(歯を消さないこと)。
 */

/**
 * ⛔ encoding 名の文字列にしない。`"SQL_ASCII"` のような値だと「`SQL_ASCII` を含意する」と区別がつかない。Symbol なら衝突しない。
 */
export const ANY_ENCODING = Symbol("ANY_ENCODING");

/** @type {Set<string>} */
const ENCODING_AGNOSTIC_LOCALES = new Set(["C", "POSIX"]);

/**
 * ⚠ `C` / `POSIX` が無いのは漏れではなく、特定の encoding を含意しないため(`ENCODING_AGNOSTIC_LOCALES` 側)。網羅ではない。
 *
 * @type {Record<string, string>}
 */
const KNOWN_LOCALE_IMPLIED_ENCODING = {
  "C.utf8": "UTF8",
  "C.UTF-8": "UTF8",
};

const DEFAULT_LOCALE_IMPLIED_ENCODING = "UTF8";

/**
 * @param {string} initdbArgs
 * @returns {{ encoding: string | undefined, locale: string | undefined }}
 */
export function parseInitdbArgs(initdbArgs) {
  const encodingMatch = /--encoding=([^\s"]+)/.exec(initdbArgs);
  const localeMatch = /--locale=([^\s"]+)/.exec(initdbArgs);
  return {
    encoding: encodingMatch?.[1],
    locale: localeMatch?.[1],
  };
}

/**
 * @param {string | undefined} locale
 * @returns {string | typeof ANY_ENCODING | undefined}
 */
export function impliedEncodingForLocale(locale) {
  if (locale === undefined) {
    return DEFAULT_LOCALE_IMPLIED_ENCODING;
  }
  if (ENCODING_AGNOSTIC_LOCALES.has(locale)) {
    return ANY_ENCODING;
  }
  return KNOWN_LOCALE_IMPLIED_ENCODING[locale];
}

/**
 * @param {{ serverEncoding: string, initdbArgs: string }[]} legs
 * @returns {{ serverEncoding: string, initdbArgs: string, reason: string }[]}
 */
export function findInconsistentLegs(legs) {
  /** @type {{ serverEncoding: string, initdbArgs: string, reason: string }[]} */
  const flagged = [];
  for (const leg of legs) {
    const { locale } = parseInitdbArgs(leg.initdbArgs);
    const implied = impliedEncodingForLocale(locale);
    if (implied === ANY_ENCODING) {
      continue;
    }
    if (implied === undefined) {
      flagged.push({
        ...leg,
        reason:
          `--locale=${locale} が何の encoding を含意するか、この歯には分からない` +
          "(KNOWN_LOCALE_IMPLIED_ENCODING に無いロケール)。新しいロケールを足したなら、" +
          "initdb を実測してから上の表に加えること。",
      });
      continue;
    }
    if (implied !== leg.serverEncoding) {
      flagged.push({
        ...leg,
        reason:
          `--locale=${locale ?? "(無し・既定ロケール)"} は encoding=${implied} を含意するが、` +
          `この脚の serverEncoding は ${leg.serverEncoding} である。initdb は encoding と` +
          "ロケールの整合を検査するため、この脚は実際の CI でコンテナの起動ごと落ちうる。",
      });
    }
  }
  return flagged;
}
