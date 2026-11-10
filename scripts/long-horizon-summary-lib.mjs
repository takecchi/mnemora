/**
 * `long-horizon`（ADR 0699）の実測値と基準値（`examples/chat/long-horizon-baseline.json`）を突き合わせ、Job Summary の Markdown を作る。
 *
 * ⛔ 門ではない。差があっても CI は落ちない（ADR 0088 §2.1 と同じ判断。標本は事実が種類ごとに数件で、偽陽性率に上限を置けない）。
 * ⚠ 比べるのは probe ごとの離散値 `outcome`（gold が返ったか・返らなかった理由）だけである。CI の2回の run で一致した値で、
 * 順位・スコア・プロンプトの文字数（`quantities`）は比べない（文字数は run ごとに揺れた。ADR 0699「測ったこと」）。
 */

/** probe を特定する鍵（arm × 時点 × 事実 × 役割）。 */
export function probeKey(probe) {
  return `${probe.arm}|${String(probe.checkpointDay)}|${probe.factId}|${probe.role}`;
}

function validateProbes(data, label) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: `${label} JSON がオブジェクトでない` };
  }
  if (!Array.isArray(data.probes) || data.probes.length === 0) {
    return { ok: false, error: `${label} JSON に probes（空でない配列）が無い` };
  }
  const seen = new Set();
  for (const [i, p] of data.probes.entries()) {
    const fields = ["arm", "factId", "role", "outcome"];
    for (const f of fields) {
      if (typeof p?.[f] !== "string" || p[f].length === 0) {
        return { ok: false, error: `${label} JSON の probes[${i}].${f} が空でない文字列でない` };
      }
    }
    if (!Number.isInteger(p.checkpointDay)) {
      return { ok: false, error: `${label} JSON の probes[${i}].checkpointDay が整数でない` };
    }
    const key = probeKey(p);
    if (seen.has(key)) {
      return { ok: false, error: `${label} JSON の probes に同じ鍵（${key}）が2つある` };
    }
    seen.add(key);
  }
  return { ok: true, value: data };
}

export function validateMeasured(data) {
  return validateProbes(data, "実測");
}

export function validateBaseline(data) {
  const r = validateProbes(data, "基準値");
  if (!r.ok) return r;
  if (typeof data.provenance !== "object" || data.provenance === null) {
    return { ok: false, error: "基準値 JSON に provenance（どの run から採ったか）が無い" };
  }
  return r;
}

/**
 * @returns {{ changed: {key: string, baseline: string, measured: string}[], missing: string[], extra: string[], same: number }}
 */
export function diffProbes(measured, baseline) {
  const byKey = new Map(baseline.probes.map((p) => [probeKey(p), p]));
  const measuredKeys = new Set();
  const changed = [];
  const extra = [];
  let same = 0;
  for (const p of measured.probes) {
    const key = probeKey(p);
    measuredKeys.add(key);
    const b = byKey.get(key);
    if (b === undefined) {
      extra.push(key);
    } else if (b.outcome !== p.outcome) {
      changed.push({ key, baseline: b.outcome, measured: p.outcome });
    } else {
      same += 1;
    }
  }
  const missing = [...byKey.keys()].filter((k) => !measuredKeys.has(k));
  return { changed, missing, extra, same };
}

const MAX_LISTED = 30;

export function buildSummaryMarkdown({ measured, baseline }) {
  const lines = ["## long-horizon: 基準値との差（⛔ 門ではない）", ""];
  if (baseline === undefined) {
    lines.push("基準値が渡されていない。差は出していない。");
    return lines.join("\n");
  }
  const d = diffProbes(measured, baseline);
  const total = measured.probes.length;
  // 基準値を採ったときに、同じ run の2回の間でも揺れた probe（`provenance.unstableProbes`）。その差は揺れとして分けて出す。
  const unstable = new Set(
    Array.isArray(baseline.provenance?.unstableProbes) ? baseline.provenance.unstableProbes : [],
  );
  const knownUnstable = d.changed.filter((c) => unstable.has(c.key));
  const changed = d.changed.filter((c) => !unstable.has(c.key));
  lines.push(
    `probe ${String(total)} 件のうち、outcome が基準値と同じ ${String(d.same)} 件 / 違う ${String(changed.length)} 件（ほかに既知の揺れ ${String(knownUnstable.length)} 件）/ 基準値に無い ${String(d.extra.length)} 件 / 実測に無い ${String(d.missing.length)} 件。`,
  );
  lines.push("");
  lines.push(
    "⚠ 比べるのは outcome（返ったか・返らなかった理由）だけ。順位・スコア・文字数は比べない。差は「既定値や実装が変わった」合図で、悪化の判定ではない。",
  );
  if (changed.length > 0) {
    lines.push("", "| probe（arm\\|日\\|事実\\|役割） | 基準値 | 実測 |", "|---|---|---|");
    for (const c of changed.slice(0, MAX_LISTED)) {
      lines.push(`| ${c.key.replaceAll("|", "\\|")} | ${c.baseline} | ${c.measured} |`);
    }
    if (changed.length > MAX_LISTED) {
      lines.push(
        "",
        `（ほか ${String(changed.length - MAX_LISTED)} 件は省略。成果物の JSON を見ること）`,
      );
    }
  }
  if (knownUnstable.length > 0) {
    lines.push(
      "",
      `既知の揺れ（基準値を採った run の2回の間でも違った probe）: ${knownUnstable.map((c) => c.key).join(", ")}`,
    );
  }
  for (const [label, keys] of [
    ["基準値に無い probe", d.extra],
    ["実測に無い probe", d.missing],
  ]) {
    if (keys.length > 0) {
      lines.push(
        "",
        `${label}: ${keys.slice(0, MAX_LISTED).join(", ")}${keys.length > MAX_LISTED ? " …" : ""}`,
      );
    }
  }
  return lines.join("\n");
}
