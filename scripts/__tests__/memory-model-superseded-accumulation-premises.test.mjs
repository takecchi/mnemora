import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(`${root}${rel}`, "utf8");

const memoryStore = read("packages/postgres/src/memory-store.ts");
const doc = read("docs/memory-model.md");

function functionBody(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} が見つからない`);
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`${name} の終わりが見つからない`);
  return source.slice(start, end);
}

function statusPredicates(text) {
  return [...new Set(text.match(/status\s*(?:=\s*'[a-z_]+'|IN\s*\([^)]*\))/g) ?? [])];
}

function sourceFiles() {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(`${root}${rel}`, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(child);
      } else if (/\.(ts|sql)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        out.push(child);
      }
    }
  };
  for (const pkg of readdirSync(`${root}packages`, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const sub of ["src", "migrations"]) {
      try {
        walk(`packages/${pkg.name}/${sub}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return out;
}

const DELETE_FROM_MEMORIES = /DELETE\s+FROM\s+memories(?![\w])/i;

describe("🔴 docs/memory-model.md §11「superseded / contested の行は溜まる」の前提（Issue #567）", () => {
  it("節が在り、この歯を名指ししている（節だけ消えて歯が残る、を防ぐ）", () => {
    expect(doc).toContain("### ⚠ `superseded` / `contested` の行は溜まる");
    expect(doc).toContain(
      "scripts/__tests__/memory-model-superseded-accumulation-premises.test.mjs",
    );
  });

  it("1. 掃引の対象を選ぶ SQL は `status = 'active'` だけで絞る", () => {
    const body = functionBody(memoryStore, "buildArchiveDecayedTargetSelect");
    expect(statusPredicates(body)).toEqual(["status = 'active'"]);
  });

  it("2. 段1 の部分索引 idx_memories_recall_gate（と活動時計側の _seq）は active と contested だけを載せる", () => {
    const dir = "packages/postgres/migrations";
    const definitions = readdirSync(`${root}${dir}`)
      .filter((name) => name.endsWith(".sql"))
      .flatMap(
        (name) =>
          read(`${dir}/${name}`).match(/^CREATE INDEX idx_memories_recall_gate\w*\s[^;]*;/gm) ?? [],
      );
    expect(definitions.map((d) => d.match(/idx_memories_recall_gate\w*/)[0]).sort()).toEqual([
      "idx_memories_recall_gate",
      "idx_memories_recall_gate_seq",
    ]);
    for (const definition of definitions) {
      expect(statusPredicates(definition)).toEqual(["status IN ('active', 'contested')"]);
    }
  });

  it("3. 段5（aggregateScope）は superseded の件数も数える", () => {
    expect(memoryStore).toContain("count(*) FILTER (WHERE status = 'superseded')");
  });

  it("4. memories から DELETE する SQL は packages/*/src にもマイグレーションにも無い", () => {
    const files = sourceFiles();
    expect(files).toContain("packages/postgres/src/memory-store.ts");
    expect(memoryStore).toMatch(/DELETE FROM memory_events/);

    const offenders = files.filter((rel) => DELETE_FROM_MEMORIES.test(read(rel)));
    expect(
      offenders,
      "memories の行を消す SQL が現れた。回収の経路が入ったなら、docs/memory-model.md §11 の節を直すこと",
    ).toEqual([]);
  });
});
