/**
 * ⛔ 「これは破壊的変更である」という判定を一切返さない。返すのは、機械的に読み取れる信号の有無と、
 * 信号を持たない commit を含む母集合だけ。この repo の破壊的変更は印の付き方がバラバラで、どの信号にも掛からないものがある。
 * 「信号なし」は「候補ではない」を意味しない。母集合から信号なし commit を黙って落とさない。
 */

/**
 * ⛔ パースできない subject は例外にせず `type: null` として返す(この形に従わない subject が履歴に実在する)。
 * `type: null` の commit も母集合から消さない(ADR 0169)。PR 番号は、形が壊れていても独立に取り出す。
 *
 * @param {string} subject
 * @returns {{ type: string | null, scope: string | null, bang: boolean, description: string, prNumber: number | null }}
 */
export function parseCommitSubject(subject) {
  const prMatch = /\(#(\d+)\)\s*$/.exec(subject.trimEnd());
  const prNumber = prMatch ? Number(prMatch[1]) : null;

  const match =
    /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<description>.*)$/.exec(subject);
  if (!match || !match.groups) {
    return { type: null, scope: null, bang: false, description: subject, prNumber };
  }
  return {
    type: match.groups.type,
    scope: match.groups.scope ?? null,
    bang: match.groups.bang === "!",
    description: match.groups.description,
    prNumber,
  };
}

export function isPublicApiSnapshotPath(path) {
  return path.startsWith("scripts/__snapshots__/public-api/");
}

/**
 * パスに `__tests__/` を含むものを「テスト」として除外する。この配置を経由しないテストが増えたら取りこぼしうる。
 */
export function isPackageSrcPath(path) {
  return /^packages\/[^/]+\/src\//.test(path) && !/__tests__\//.test(path);
}

export function hasBreakingBodyMention(body) {
  return /(破壊的|breaking)/i.test(body ?? "");
}

/**
 * @param {{ subject: string, body?: string, files?: string[] }} commit
 * @returns {string[]}
 */
export function computeSignals({ subject, body, files }) {
  const parsed = parseCommitSubject(subject);
  const signals = [];
  if (parsed.bang) signals.push("bang");
  if (hasBreakingBodyMention(body)) signals.push("body-breaking");
  if ((files ?? []).some(isPublicApiSnapshotPath)) signals.push("public-api");
  if ((files ?? []).some(isPackageSrcPath)) signals.push("src");
  return signals;
}

/** @param {{ sha: string, subject: string, body?: string, files?: string[] }} commit */
export function classifyCommit({ sha, subject, body, files }) {
  const parsed = parseCommitSubject(subject);
  return {
    sha,
    subject,
    type: parsed.type,
    scope: parsed.scope,
    bang: parsed.bang,
    prNumber: parsed.prNumber,
    signals: computeSignals({ subject, body, files }),
  };
}

/** @param {{ sha: string, subject: string, body?: string, files?: string[] }[]} rawCommits */
export function classifyCommits(rawCommits) {
  return rawCommits.map(classifyCommit);
}

/**
 * ⭐ 元の配列の要素数の合計を保つ。信号ゼロの commit は `withoutSignals` 側に必ず現れる。
 * 捨てると「候補の一覧」ではなく「判定」に戻る。
 *
 * @param {ReturnType<typeof classifyCommit>[]} classifiedCommits
 */
export function splitBySignal(classifiedCommits) {
  return {
    withSignals: classifiedCommits.filter((c) => c.signals.length > 0),
    withoutSignals: classifiedCommits.filter((c) => c.signals.length === 0),
  };
}

/**
 * @param {ReturnType<typeof classifyCommit>[]} classifiedCommits
 * @returns {Map<string, ReturnType<typeof classifyCommit>[]>}
 */
export function groupByType(classifiedCommits) {
  const groups = new Map();
  for (const commit of classifiedCommits) {
    const key = commit.type ?? "(type無し)";
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(commit);
    } else {
      groups.set(key, [commit]);
    }
  }
  return groups;
}

/**
 * ⚠ 目印の各文字の間に、任意の改行＋空白を許す。Markdown の折り返しで目印の真ん中に改行が入ると、
 * 素の `indexOf` は見つけられず、別の節の目印を拾ってしまう。
 *
 * @param {string} marker
 * @returns {RegExp}
 */
function buildLineWrapTolerantMarkerPattern(marker) {
  const escaped = [...marker].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("(?:\\n[ \\t]*)?"));
}

/**
 * ⛔ 読み取れなくても例外にせず `null` を返す(`CHANGELOG.md` の文言は人が手で書くので、この文自体が書き換わったり消えたりしうる。ADR 0169)。
 *
 * @param {string} changelogText
 * @returns {string | null}
 */
export function extractChangelogBaseSha(changelogText) {
  const pattern = buildLineWrapTolerantMarkerPattern("の範囲を数えたものである");
  const match = pattern.exec(changelogText);
  if (!match) return null;
  const windowStart = Math.max(0, match.index - 400);
  const window = changelogText.slice(windowStart, match.index);
  const hexMatches = [...window.matchAll(/`([0-9a-f]{7,40})`/gi)];
  if (hexMatches.length === 0) return null;
  return hexMatches[hexMatches.length - 1][1];
}
