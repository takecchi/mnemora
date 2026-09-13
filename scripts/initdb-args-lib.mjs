/**
 * `initdbArgs`(`--encoding=` / `--locale=`)が**自己無矛盾**かどうかを判定する純関数
 * (Issue #162 E)。
 *
 * ## 何を測るか
 *
 * `.github/workflows/ci.yml` の `postgres` ジョブは `server_encoding` の matrix
 * (`UTF8` / `SQL_ASCII`)を持ち、各脚は `initdbArgs` に `--encoding=` と(要る脚だけ)
 * `--locale=` を書く。`ci.yml` のコメント(SQL_ASCII 脚のすぐ上)が述べる通り、
 * **initdb は「選んだ encoding」と「ロケールが含意する encoding」の整合を検査する**
 * ——食い違うとコンテナの起動ごと落ちる。
 *
 * `scripts/__tests__/ci-yml-postgres-regime-wiring.test.mjs` の既存の (c) は
 * `--encoding=` の値と `leg.serverEncoding` の一致だけを見ており、`--locale=` の値は
 * どの歯も検査していなかった(Issue #162 E)。⟹ `--locale=C` を落としても・
 * 他のロケールへ挿げ替えても・UTF8 脚に足しても、既存の歯は気づかない。
 *
 * ## ⚠ 確かめていないこと
 *
 * **下の `KNOWN_LOCALE_IMPLIED_ENCODING` 表は、実際に `initdb` を実行して確かめた
 * ものではない。**この器には docker/podman/initdb が無く(`DATABASE_URL` も未設定)、
 * ここで実行して検算することはできなかった。根拠は次の2つだけである:
 *
 * - `ci.yml` の SQL_ASCII 脚のコメント(「`--locale=C` が要る——initdb は encoding と
 *   ロケールの整合を検査するので、SQL_ASCII だけを渡すと既定ロケール(実測
 *   en_US.utf8)と噛み合わずに…」)
 * - PR #149 が実際の CI run(34635954755)で UTF8 脚の `server_encoding` が `UTF8`
 *   だったことを実測した記録(＝既定ロケールが UTF8 を含意することの状況証拠)
 *
 * ⟹ **`initdb` を実際に走らせて検算していない。**Issue #162 の「確かめていないこと」
 * にもこの旨を書くこと。
 *
 * ## ⛔ `--locale=C` を無条件に要求しない
 *
 * UTF8 脚には `--locale=` が無いのが正しい(既定ロケールが UTF8 を含意するため)。
 * この関数は「`--locale=` が有ることを要求する」のではなく、**「脚が自己無矛盾で
 * あること」だけを見る**(既存の (c) と同じ向き)。
 *
 * ## ⚠ 扱っていない書き方(いずれも**安全側＝赤**に倒れる)
 *
 * `--locale=` **以外**でロケールを決める書き方は解釈していない。いま `ci.yml` が
 * 使っているのが `--locale=` だけだからである:
 *
 * - `--no-locale`(= `--locale=C` と同義) ⟹ この関数は「ロケール指定なし」と読み、
 *   `UTF8` を含意すると判定する。⟹ SQL_ASCII 脚に付けると**誤って赤くなる**。
 * - `--lc-collate=` / `--lc-ctype=` を `--locale=` の代わりに使う書き方 ⟹ 同上。
 *
 * ⛔ **誤って緑になる向きの取りこぼしではない**(どちらも赤に倒れる)。`ci.yml` が
 * これらを使い始めたら、**実測してから**この関数を広げること(⛔ 歯を消さないこと)。
 *
 * ## ⛔ 未知のロケールは「わかったことにして通す」より安全側(=挙げる)に倒す
 *
 * `KNOWN_LOCALE_IMPLIED_ENCODING` に無いロケールが出てきたら、含意する encoding が
 * わからない。「わからない」を緑で通すと、誰かが新しいロケールを足したときに実測
 * せず素通りしてしまう。⟹ **未知のロケールは挙げる(赤)**——表に実測を足してから
 * 緑にすること。
 */

/**
 * 既知のロケール文字列 → initdb が要求する encoding。網羅ではない
 * (docstring の「確かめていないこと」を見ること)。
 *
 * @type {Record<string, string>}
 */
const KNOWN_LOCALE_IMPLIED_ENCODING = {
  C: "SQL_ASCII",
};

/** `--locale=` が無い(既定ロケール)ときに含意される encoding。 */
const DEFAULT_LOCALE_IMPLIED_ENCODING = "UTF8";

/**
 * `initdbArgs` 文字列から `--encoding=` / `--locale=` の値を取り出す。
 *
 * @param {string} initdbArgs 例: `"--encoding=SQL_ASCII --locale=C"`
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
 * ロケール指定(`--locale=` の値。無ければ `undefined`)から、initdb が要求する
 * encoding を返す。**未知のロケールは `undefined`(「わからない」)を返す**——
 * 「わかったことにして通す」より安全な側に倒すため。
 *
 * @param {string | undefined} locale
 * @returns {string | undefined}
 */
export function impliedEncodingForLocale(locale) {
  if (locale === undefined) {
    return DEFAULT_LOCALE_IMPLIED_ENCODING;
  }
  return KNOWN_LOCALE_IMPLIED_ENCODING[locale];
}

/**
 * matrix の脚のうち、`--locale=` が含意する encoding と `serverEncoding` が
 * 食い違っている(=自己矛盾している)ものを挙げる。ロケールが未知で含意する
 * encoding がわからない脚も挙げる。
 *
 * @param {{ serverEncoding: string, initdbArgs: string }[]} legs
 * @returns {{ serverEncoding: string, initdbArgs: string, reason: string }[]}
 */
export function findInconsistentLegs(legs) {
  /** @type {{ serverEncoding: string, initdbArgs: string, reason: string }[]} */
  const flagged = [];
  for (const leg of legs) {
    const { locale } = parseInitdbArgs(leg.initdbArgs);
    const implied = impliedEncodingForLocale(locale);
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
