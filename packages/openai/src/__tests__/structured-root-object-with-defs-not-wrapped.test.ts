import { describe, expect, it } from "vitest";
import { z } from "zod";
import { translateForOpenAIStructuredOutput } from "../json-schema.js";

type Tree = { label: string; children: Tree[] };
const TreeSchema: z.ZodType<Tree> = z.lazy(() =>
  z.object({ label: z.string(), children: z.array(TreeSchema) }),
);

describe("根が object のスキーマは、$defs を持っていても包まない", () => {
  const { schema: sent } = translateForOpenAIStructuredOutput(
    "x",
    z.object({ first: TreeSchema, second: TreeSchema }),
  );

  it("前提: 共有の再帰するスキーマで、根に $defs ができる", () => {
    expect(Object.keys(sent["$defs"] as Record<string, unknown>).length).toBeGreaterThan(0);
  });

  it("根の欄は元のスキーマの欄のままで、result の包みを足さない", () => {
    const properties = sent["properties"] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["first", "second"]);
    expect(properties).not.toHaveProperty("result");
  });
});
