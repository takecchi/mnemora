/**
 * **`npm publish` の前に「出す版の節が `CHANGELOG.md` に在るか」を見る門**の、判定だけを持つ純関数。
 *
 * ## 🔴 これは [ADR 0251](../docs/decisions/0251-release-follow-up-notice-not-a-gate.md) の通知とは別の道具である
 *
 * あちら（`release-changelog-section-lib.mjs` + `check-release-changelog-section.mjs`）は
 * **終了コードが常に 0 の通知**であり、同 ADR はその性質を核心として名指ししている。
 * ⛔ **だからあちらを非 0 にしない。**こちらを**別のファイル**として足したのは、
 * **あちらの「常に 0」を1バイトも動かさないため**である。
 *
 * ⭐ **述語は同じものを使い回す**——`versionFromTagName` / `findChangelogSection` を
 * あちらから import する。⟹ **見るものが2つに割れない。**
 * ⛔ **述語をここで広げないこと**——あちらの docstring が逐語で
 * 「**この場所で内容の推定を始めると、却下された側へ戻る**」と書いている
 * （[Issue #433](https://github.com/takecchi/mnemora/issues/433) の却下）。**節の存在だけを見る。**
 *
 * ## ⭐ 迷ったら止める側へ倒す（fail-closed）
 *
 * **判定できなかったときは緑にしない。**`publish.yml` が既に採っている形と同じである
 * ——同ファイルは逐語で「**確かめていないものを publish の経路に通さない——ここで落とす**」と
 * 書いて `NPM_TAG` が空のときに落としている。
 * ⟹ **tag が読めない・版が導けない・prerelease 欄が `true`/`false` のどちらでもない、のいずれも
 * 「門を当てる」側へ倒す。**
 *
 * ## ⛔ この門が当たらない場面は、2つだけである
 *
 * | | なぜ当てないか |
 * |---|---|
 * | `release` 以外の引き金（`workflow_dispatch` の予行） | **出す版が存在しない。**`publish.yml` の既存の門も同じ条件で自分を外している |
 * | `prerelease` の Release | **`CHANGELOG.md` は prerelease の節を持たない**（`v1.0.0-rc.1` のような版に `## [1.0.0-rc.1]` は起こさない） |
 *
 * ⛔ **この2つ以外の除外を足さないこと。**足すたびに、門が「何を主張しているか」が薄まる。
 */
import { findChangelogSection, versionFromTagName } from "./release-changelog-section-lib.mjs";

/**
 * ワークフローから渡る `prerelease` 欄を読む。
 *
 * ⚠ **`"true"` / `"false"` のどちらでもない値は、`prerelease ではない`（＝門を当てる）側へ倒す。**
 * ⛔ **これは「安全側」の向きを、`decide-publish-dry-run.mjs` と同じ理由で選んだものである**
 * ——あちらは「危険と明示されたときだけ本番」へ倒しており、**こちらは「除外と明示されたときだけ除外」**である。
 * ⟹ どちらも **黙って緩いほうへ倒れない。**
 *
 * @param {unknown} raw
 * @returns {{ isPrerelease: boolean, recognized: boolean }}
 */
export function parsePrereleaseFlag(raw) {
  const value = String(raw ?? "").trim();
  if (value === "true") return { isPrerelease: true, recognized: true };
  if (value === "false") return { isPrerelease: false, recognized: true };
  return { isPrerelease: false, recognized: false };
}

/**
 * 門の判定。⛔ **例外を投げない**——呼び出し側が終了コードを決められるように、結果を返すだけにする。
 *
 * @param {{ eventName?: unknown, prereleaseRaw?: unknown, tagName?: unknown, changelogText?: unknown, changelogSource?: unknown }} input
 * @returns {{ applies: boolean, ok: boolean, exitCode: 0 | 1, reason: string, version: string, lineNumber: number | null, lines: string[] }}
 */
export function decideReleaseChangelogGate({
  eventName,
  prereleaseRaw,
  tagName,
  changelogText,
  changelogSource,
}) {
  const event = String(eventName ?? "").trim();
  const source = String(changelogSource ?? "(渡されていない)");

  if (event !== "release") {
    return {
      applies: false,
      ok: true,
      exitCode: 0,
      reason: "not-a-release-event",
      version: "",
      lineNumber: null,
      lines: [
        `⭕ この門は当たらない（引き金が \`${event || "(空)"}\` であり \`release\` ではない）。`,
        "⟹ **出す版が存在しないので、見るものが無い。**⛔ 緑にしたのではなく、当てていない。",
      ],
    };
  }

  const { isPrerelease, recognized } = parsePrereleaseFlag(prereleaseRaw);
  if (isPrerelease) {
    return {
      applies: false,
      ok: true,
      exitCode: 0,
      reason: "prerelease",
      version: versionFromTagName(tagName),
      lineNumber: null,
      lines: [
        "⭕ この門は当たらない（`prerelease` の Release である）。",
        "⟹ **`CHANGELOG.md` は prerelease の節を持たない。**⛔ 緑にしたのではなく、当てていない。",
      ],
    };
  }

  /** @type {string[]} */
  const notes = [];
  if (!recognized) {
    notes.push(
      `⚠ \`prerelease\` 欄が \`true\`/\`false\` のどちらでもない（\`${String(prereleaseRaw ?? "")}\`）。` +
        "⟹ **除外と明示されていないので、門を当てた。**",
    );
  }

  const version = versionFromTagName(tagName);
  if (version === "") {
    return {
      applies: true,
      ok: false,
      exitCode: 1,
      reason: "no-version",
      version: "",
      lineNumber: null,
      lines: [
        ...notes,
        "🔴 tag 名から版を導けなかった。",
        "⟹ ⛔ **判定できなかったので、止めた**（確かめていないものを publish の経路に通さない）。",
      ],
    };
  }

  const text = typeof changelogText === "string" ? changelogText : "";
  if (text === "") {
    return {
      applies: true,
      ok: false,
      exitCode: 1,
      reason: "no-changelog",
      version,
      lineNumber: null,
      lines: [
        ...notes,
        `🔴 \`CHANGELOG.md\` の中身を読めなかった（出所: \`${source}\`）。`,
        "⟹ ⛔ **判定できなかったので、止めた。**",
      ],
    };
  }

  const hit = findChangelogSection(text, version);
  if (hit.found) {
    return {
      applies: true,
      ok: true,
      exitCode: 0,
      reason: "section-present",
      version,
      lineNumber: hit.lineNumber,
      lines: [
        ...notes,
        `⭕ \`## [${version}]\` の節が在る（出所: \`${source}\` の ${hit.lineNumber} 行目）。`,
        "⛔ **節の中身が正しいかは見ていない。**⛔ `docs/migration-v1.md` の世代も見ていない。",
        "⟹ **そこは人が見る**（`docs/release-v1.md`）。",
      ],
    };
  }

  return {
    applies: true,
    ok: false,
    exitCode: 1,
    reason: "section-missing",
    version,
    lineNumber: null,
    lines: [
      ...notes,
      `🔴 \`## [${version}]\` の節が \`${source}\` の \`CHANGELOG.md\` に無い。`,
      "",
      "**⟹ npm へは出さない。**⭐ これは「出す前に節を書く」という順序を守らせる門である。",
      "",
      "**直し方**:",
      `1. \`CHANGELOG.md\` に \`## [${version}]\` の節を起こす PR を出し、\`main\` へマージする。`,
      "2. この Publish の run を**再実行**する。",
      "   ⭐ `npm publish` の段は冪等である（既に上がっている版は飛ばす）⟹ 途中から再開できる。",
      "",
      "⚠ **この門が見ているのは節の存在だけである。**中身の正しさも、",
      "`docs/migration-v1.md` の世代も見ていない——**そこは人が見る。**",
    ],
  };
}
