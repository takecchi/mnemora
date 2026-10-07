import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const architectureText = readFileSync(join(repoRoot, "docs/architecture.md"), "utf8");
const snapshotText = readFileSync(
  join(repoRoot, "scripts/__snapshots__/public-api/core.d.ts"),
  "utf8",
);

const TARGET_NAMES = [
  "Ctx",
  "MemoryStore",
  "VectorStore",
  "LexicalStore",
  "LLMProvider",
  "EmbeddingProvider",
  "Scheduler",
  "DecayStrategy",
  "EventStore",
  "TokenCounter",
  "Clock",
  "OutboxStore",
  "TenantSettingsStore",
];

function normalizeSignature(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/'/g, '"')
    .replace(/\s+/g, "")
    .replace(/z\.ZodType/g, "ZodType")
    .replace(/[;,]([}\])>])/g, "$1")
    .replace(/[;,]$/, "");
}

function membersByName(source, names) {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  /** @type {Map<string, Map<string, string[]>>} */
  const out = new Map();
  const add = (owner, membersList) => {
    const map = out.get(owner) ?? new Map();
    for (const member of membersList) {
      if (!member.name) continue;
      const key = member.name.getText(sf);
      const list = map.get(key) ?? [];
      list.push(normalizeSignature(member.getText(sf)));
      map.set(key, list);
    }
    out.set(owner, map);
  };
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && names.includes(node.name.text)) {
      add(node.name.text, node.members);
    } else if (
      ts.isTypeAliasDeclaration(node) &&
      names.includes(node.name.text) &&
      ts.isTypeLiteralNode(node.type)
    ) {
      add(node.name.text, node.type.members);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function section5TsBlocks(text) {
  const heading = "## 5. 主要 interface";
  const start = text.indexOf(heading);
  if (start === -1) throw new Error(`docs/architecture.md に "${heading}" が見つからない`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  const section = next === -1 ? rest : rest.slice(0, next);
  return [...section.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
}

describe("docs/architecture.md §5 の port interface の写しは、メンバーの署名まで実体と一致する", () => {
  const real = membersByName(snapshotText, TARGET_NAMES);
  const docBlocks = section5TsBlocks(architectureText);

  it("陽性対照: 抽出が実際に何かを見ている（doc の片から十分な数のメンバーを比べている）", () => {
    let compared = 0;
    for (const block of docBlocks) {
      for (const [owner, members] of membersByName(block, TARGET_NAMES)) {
        for (const name of members.keys()) if (real.get(owner)?.has(name)) compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(50);
  });

  it("陽性対照: 正規化は書式の違いだけを吸収し、型の違いは残す", () => {
    const doc = membersByName(
      "interface Clock {\n  now(): Date;\n  at(ctx: Ctx, opts: { a: 'x'; b?: number }): Promise<void>;\n}",
      ["Clock"],
    ).get("Clock");
    const same = membersByName(
      'export interface Clock {\n    now(): Date;\n    at(ctx: Ctx, opts: {\n        a: "x";\n        b?: number;\n    }): Promise<void>;\n}',
      ["Clock"],
    ).get("Clock");
    const differ = membersByName(
      'export interface Clock {\n    now(): Date;\n    at(ctx: Ctx, opts: { a: "x"; b: number }): Promise<void>;\n}',
      ["Clock"],
    ).get("Clock");
    expect(doc.get("at")).toEqual(same.get("at"));
    expect(doc.get("at")).not.toEqual(differ.get("at"));
  });

  it("§5 の片の各メンバーの署名が、snapshot の同名メンバーのどれかと一致する", () => {
    const mismatches = [];
    for (const block of docBlocks) {
      for (const [owner, members] of membersByName(block, TARGET_NAMES)) {
        for (const [name, docSignatures] of members) {
          const realSignatures = real.get(owner)?.get(name);
          if (!realSignatures) continue; // 名前の食い違いは隣の歯の担当
          for (const signature of docSignatures) {
            if (!realSignatures.includes(signature)) {
              mismatches.push({ at: `${owner}.${name}`, doc: signature, real: realSignatures });
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
