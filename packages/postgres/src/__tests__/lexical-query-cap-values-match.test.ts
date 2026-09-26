import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Issue #878（2026-09-26、クローン miku の判断）: クエリの異なる語数
 * （`LEXICAL_QUERY_MAX_DISTINCT_WORDS`）・1語あたりの文字数（`LEXICAL_QUERY_MAX_WORD_CHARS`）の
 * 上限は、3つの実装（`packages/postgres`/`packages/testkit`/`packages/core`）が
 * それぞれ独立に持つ定数であり、import では共有できない
 * （`packages/core` は `packages/postgres`/`packages/testkit` に依存せず、
 * `packages/testkit`/`packages/postgres` は互いに依存しない——`package.json` の
 * `dependencies` 参照）。**手で値を揃えている**ため、ずれを検出する歯が要る。
 *
 * **ソースをテキストとして読み、定数の右辺を正規表現で取り出して突き合わせる**——
 * どの package からも import せず（依存関係を新しく作らない）、公開 API も増やさない
 * 形で3値の一致を見る。`packages/postgres` 側にこの歯を置いているのは、
 * この Issue の作業が `packages/postgres` から始まった経緯によるもので、他に理由は無い
 * （どの package に置いても同じことが検査できる）。
 *
 * ⚠ この歯は「3ファイルの定数の**値**が一致しているか」だけを見る——各実装が実際に
 * その値を**使っているか**（配線されているか）は、各 package の
 * `*-query-word-cap.test.ts`/`*-query-char-cap.test.ts`（結果ベースの歯）が別に検査する。
 */

const REPO_ROOT = join(import.meta.dirname, "../../../..");

function extractConstant(filePath: string, constantName: string): number {
  const source = readFileSync(filePath, "utf8");
  // `export` は無いこともある（`packages/testkit` 側は `pnpm api:check` の公開面に
  // 漏れるため export していない——同ファイルの doc 参照）。
  const pattern = new RegExp(`(?:export )?const ${constantName}\\s*=\\s*(\\d+)\\s*;`);
  const match = pattern.exec(source);
  if (match === null) {
    throw new Error(`${constantName} が ${filePath} に見つからない（正規表現: ${pattern})`);
  }
  return Number(match[1]);
}

describe("クエリの語数・文字数の上限: postgres/testkit/core の3実装で値が一致する（Issue #878）", () => {
  it("LEXICAL_QUERY_MAX_DISTINCT_WORDS が3ファイルで一致する", () => {
    const postgresValue = extractConstant(
      join(REPO_ROOT, "packages/postgres/src/lexical-query-cap.ts"),
      "LEXICAL_QUERY_MAX_DISTINCT_WORDS",
    );
    const testkitValue = extractConstant(
      join(REPO_ROOT, "packages/testkit/src/__fixtures__/in-memory-lexical-store.ts"),
      "LEXICAL_QUERY_MAX_DISTINCT_WORDS",
    );
    const coreValue = extractConstant(
      join(REPO_ROOT, "packages/core/src/__tests__/runtime-fakes.ts"),
      "LEXICAL_QUERY_MAX_DISTINCT_WORDS",
    );

    expect({ postgresValue, testkitValue, coreValue }).toEqual({
      postgresValue: testkitValue,
      testkitValue,
      coreValue: testkitValue,
    });
  });

  it("LEXICAL_QUERY_MAX_WORD_CHARS が3ファイルで一致する", () => {
    const postgresValue = extractConstant(
      join(REPO_ROOT, "packages/postgres/src/lexical-query-cap.ts"),
      "LEXICAL_QUERY_MAX_WORD_CHARS",
    );
    const testkitValue = extractConstant(
      join(REPO_ROOT, "packages/testkit/src/__fixtures__/in-memory-lexical-store.ts"),
      "LEXICAL_QUERY_MAX_WORD_CHARS",
    );
    const coreValue = extractConstant(
      join(REPO_ROOT, "packages/core/src/__tests__/runtime-fakes.ts"),
      "LEXICAL_QUERY_MAX_WORD_CHARS",
    );

    expect({ postgresValue, testkitValue, coreValue }).toEqual({
      postgresValue: testkitValue,
      testkitValue,
      coreValue: testkitValue,
    });
  });
});
