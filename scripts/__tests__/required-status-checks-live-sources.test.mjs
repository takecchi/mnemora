import { describe, expect, it } from "vitest";
import {
  compareRequiredStatusChecks,
  contextsFromBranchRules,
  formatComparisonReport,
  isClassicProtectionAbsent,
  readLiveRequiredChecks,
} from "../check-required-status-checks-lib.mjs";

// 実際の GitHub API は叩かない。応答はすべて fixture で、形は `gh api` の実物の応答に合わせてある。

const REPO = "owner/repo";
const BRANCH = "main";
const CLASSIC_PATH = `repos/${REPO}/branches/${BRANCH}/protection`;
const RULES_PATH = `repos/${REPO}/rules/branches/${BRANCH}`;

const NOT_PROTECTED = `gh api が失敗した: gh: Branch not protected (HTTP 404)`;
const BRANCH_NOT_FOUND = `gh api が失敗した: gh: Branch not found (HTTP 404)`;
const FORBIDDEN = `gh api が失敗した: gh: Resource not accessible by integration (HTTP 403)`;

function ok(json) {
  return { json, error: null };
}

function failed(error) {
  return { json: null, error };
}

function classicWith(names) {
  return ok({
    required_status_checks: {
      strict: false,
      contexts: names,
      checks: names.map((context) => ({ context, app_id: 15368 })),
    },
  });
}

function requiredRule(names, rulesetId = 1) {
  return {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: true,
      required_status_checks: names.map((context) => ({ context, integration_id: 15368 })),
    },
    ruleset_source_type: "Repository",
    ruleset_source: REPO,
    ruleset_id: rulesetId,
  };
}

const OTHER_RULES = [
  { type: "deletion", ruleset_source_type: "Repository", ruleset_source: REPO, ruleset_id: 1 },
  {
    type: "non_fast_forward",
    ruleset_source_type: "Repository",
    ruleset_source: REPO,
    ruleset_id: 1,
  },
];

/**
 * @param {{ classic: ReturnType<typeof ok>, rules: ReturnType<typeof ok> }} responses
 */
function fakeApi(responses) {
  /** @type {{ apiPath: string, options: unknown }[]} */
  const calls = [];
  const fetchJson = (apiPath, options) => {
    calls.push({ apiPath, options });
    if (apiPath === CLASSIC_PATH) return responses.classic;
    if (apiPath === RULES_PATH) return responses.rules;
    throw new Error(`想定していない API: ${apiPath}`);
  };
  return { fetchJson, calls };
}

function check(declared, responses) {
  const { fetchJson } = fakeApi(responses);
  const read = readLiveRequiredChecks(fetchJson, REPO, BRANCH);
  const result = compareRequiredStatusChecks(declared, read.live, read);
  return { read, result, text: formatComparisonReport(result) };
}

describe("required の現物を、classic の branch protection と ruleset の和として読む", () => {
  it("ruleset だけに required が在り、classic は 404 Branch not protected → 一致して match", () => {
    const { read, result, text } = check(["a", "b"], {
      classic: failed(NOT_PROTECTED),
      rules: ok([...OTHER_RULES, requiredRule(["b", "a"])]),
    });
    expect(read.unreadable).toEqual([]);
    expect(result.verdict).toBe("match");
    expect(result.live).toEqual(["a", "b"]);
    expect(text).toContain("一致（match）");
    expect(text).toContain("classic の branch protection は無い");
    expect(text).toContain("ruleset の required_status_checks: 2 件");
  });

  it("classic だけに required が在り、ruleset に required の規則が無い → 一致して match", () => {
    const { result } = check(["a", "b"], {
      classic: classicWith(["a", "b"]),
      rules: ok(OTHER_RULES),
    });
    expect(result.verdict).toBe("match");
    expect(result.live).toEqual(["a", "b"]);
  });

  it("両方に在れば和集合と比べる（重なりは1つに数える）", () => {
    const { result, text } = check(["a", "b", "c"], {
      classic: classicWith(["a", "b"]),
      rules: ok([requiredRule(["b", "c"])]),
    });
    expect(result.verdict).toBe("match");
    expect(result.live).toEqual(["a", "b", "c"]);
    expect(text).toContain("classic の branch protection: 2 件");
    expect(text).toContain("ruleset の required_status_checks: 2 件");
  });

  it("両方に在るとき、片方だけと一致していても和集合とずれていれば mismatch", () => {
    const { result } = check(["a", "b"], {
      classic: classicWith(["a", "b"]),
      rules: ok([requiredRule(["c"])]),
    });
    expect(result.verdict).toBe("mismatch");
    expect(result.extra).toEqual(["c"]);
  });

  it("複数の ruleset の required_status_checks の規則を全部集める", () => {
    const { result } = check(["a", "b"], {
      classic: failed(NOT_PROTECTED),
      rules: ok([requiredRule(["a"], 1), requiredRule(["b", "a"], 2)]),
    });
    expect(result.verdict).toBe("match");
    expect(result.live).toEqual(["a", "b"]);
  });

  it("どちらにも required が無い（classic は 404、ruleset は required の規則なし）→ 保留ではなく mismatch", () => {
    const { result, text } = check(["a", "b"], {
      classic: failed(NOT_PROTECTED),
      rules: ok(OTHER_RULES),
    });
    expect(result.verdict).toBe("mismatch");
    expect(result.live).toEqual([]);
    expect(result.missing).toEqual(["a", "b"]);
    expect(text).toContain("不一致（mismatch）");
    expect(text).toContain("宣言に在って protection に無い: a / b");
  });

  it("ruleset の側がずれている（不足と余分）→ mismatch で、どちらも名指しする", () => {
    const { result, text } = check(["a", "b", "c"], {
      classic: failed(NOT_PROTECTED),
      rules: ok([requiredRule(["a", "b", "x"])]),
    });
    expect(result.verdict).toBe("mismatch");
    expect(result.missing).toEqual(["c"]);
    expect(result.extra).toEqual(["x"]);
    expect(text).toContain("宣言に在って protection に無い: c");
    expect(text).toContain("protection に在って宣言に無い: x");
  });

  it("GET だけを2本呼び、ruleset の規則は全ページを1つの配列として求める", () => {
    const { fetchJson, calls } = fakeApi({
      classic: failed(NOT_PROTECTED),
      rules: ok([requiredRule(["a"])]),
    });
    readLiveRequiredChecks(fetchJson, REPO, BRANCH);
    expect(calls).toEqual([
      { apiPath: CLASSIC_PATH, options: undefined },
      { apiPath: RULES_PATH, options: { paginatedArray: true } },
    ]);
  });
});

describe("読めないときは保留にし、理由は実際の応答のとおりに言う", () => {
  it("classic が 404 Branch not protected のとき、保留にも「権限」にもしない", () => {
    const { result, text } = check(["a"], {
      classic: failed(NOT_PROTECTED),
      rules: ok([requiredRule(["a"])]),
    });
    expect(result.verdict).toBe("match");
    expect(text).not.toContain("権限");
    expect(text).not.toContain("GITHUB_TOKEN");
  });

  it("classic が 403 → 保留。理由に 403 と権限を挙げる", () => {
    const { result, text } = check(["a"], {
      classic: failed(FORBIDDEN),
      rules: ok([requiredRule(["a"])]),
    });
    expect(result.verdict).toBe("undetermined");
    expect(result.live).toBeNull();
    expect(text).toContain("保留（undetermined）");
    expect(text).toContain("HTTP 403");
    expect(text).toContain("権限");
    expect(text).not.toContain("一致（match）");
  });

  it("classic の 404 でも Branch not found は「保護が無い」と読まず、保留にする", () => {
    const { result, text } = check(["a"], {
      classic: failed(BRANCH_NOT_FOUND),
      rules: ok([requiredRule(["a"])]),
    });
    expect(result.verdict).toBe("undetermined");
    expect(text).toContain("Branch not found");
    expect(text).not.toContain("権限");
  });

  it("ruleset の側が読めなければ、classic が読めていても保留（和集合を作れない）", () => {
    const rulesError = `gh api が失敗した: gh: Not Found (HTTP 404)`;
    const { result, text } = check(["a"], {
      classic: classicWith(["a"]),
      rules: failed(rulesError),
    });
    expect(result.verdict).toBe("undetermined");
    expect(result.reason).toContain(RULES_PATH);
    expect(text).toContain(`読めなかったもの: ${RULES_PATH}: ${rulesError}`);
    expect(text).toContain("classic の branch protection: 1 件");
  });

  it("ruleset の応答が規則の配列でなければ保留", () => {
    const { result } = check(["a"], {
      classic: failed(NOT_PROTECTED),
      rules: ok({ message: "unexpected" }),
    });
    expect(result.verdict).toBe("undetermined");
  });

  it("classic の応答に required_status_checks が無ければ、これまでどおり保留", () => {
    const { result } = check(["a"], {
      classic: ok({ enforce_admins: { enabled: false } }),
      rules: ok([requiredRule(["a"])]),
    });
    expect(result.verdict).toBe("undetermined");
  });

  it("空の宣言は、どちらも読めなくても mismatch を優先する", () => {
    const { result } = check([], {
      classic: failed(FORBIDDEN),
      rules: failed(`gh api が失敗した: gh: Not Found (HTTP 404)`),
    });
    expect(result.verdict).toBe("mismatch");
  });
});

describe("contextsFromBranchRules: 規則の配列から required の context を取り出す", () => {
  it("required_status_checks 以外の規則は無視し、重なりを除いてソートして返す", () => {
    expect(
      contextsFromBranchRules([...OTHER_RULES, requiredRule(["b", "a"]), requiredRule(["a"])]),
    ).toEqual(["a", "b"]);
  });

  it("required の規則が無ければ空配列（null ではない）", () => {
    expect(contextsFromBranchRules([])).toEqual([]);
    expect(contextsFromBranchRules(OTHER_RULES)).toEqual([]);
  });

  it.each([
    ["配列でない", { rules: [] }],
    ["要素が object でない", ["required_status_checks"]],
    ["parameters が無い", [{ type: "required_status_checks" }]],
    [
      "context が文字列でない",
      [{ type: "required_status_checks", parameters: { required_status_checks: [{}] } }],
    ],
  ])("形が違えば null（読めなかった）: %s", (_label, rules) => {
    expect(contextsFromBranchRules(rules)).toBeNull();
  });
});

describe("isClassicProtectionAbsent", () => {
  it("404 の Branch not protected だけを「classic の保護が無い」と読む", () => {
    expect(isClassicProtectionAbsent(NOT_PROTECTED)).toBe(true);
    expect(isClassicProtectionAbsent(BRANCH_NOT_FOUND)).toBe(false);
    expect(isClassicProtectionAbsent(FORBIDDEN)).toBe(false);
    expect(isClassicProtectionAbsent("gh: Branch not protected")).toBe(false);
  });
});
