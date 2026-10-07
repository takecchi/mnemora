import { describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import type { Ctx } from "@mnemora/core";
import { ExtractionResultSchema } from "@mnemora/core";
import { OpenAILLMProvider } from "../llm-provider.js";

/** 1段目（`stripNulls`）だけだと、スキーマがもともと `null` を許す位置（必須の `.nullable()`・配列の要素・根）の `null` まで消して `ZodError` になる。そこで1段目が `ZodError` のときだけ、`null` を許す位置の `null` を残して検査し直す（2段目）。2段目でも落ちたら、1段目の `ZodError` をそのまま投げる。 */

const ctx: Ctx = { tenantId: "tenant-1" };
const prompt = { messages: [{ role: "user" as const, content: "u" }] };

function providerReturning(json: unknown) {
  const create = vi.fn().mockResolvedValue({
    choices: [{ finish_reason: "stop", message: { refusal: null, content: JSON.stringify(json) } }],
  });
  return new OpenAILLMProvider({
    model: "m",
    client: { chat: { completions: { create } } } as never,
  });
}

async function structured<T>(schema: z.ZodType<T>, json: unknown): Promise<T> {
  return providerReturning(json).completeStructured(ctx, { prompt, schema });
}

describe("スキーマが null を許す位置の null は残す", () => {
  it("必須の .nullable() の欄", async () => {
    const result = await structured(z.object({ a: z.string().nullable() }), { a: null });
    expect(result).toEqual({ a: null });
    expect("a" in result).toBe(true);
  });

  it("配列の要素の .nullable()", async () => {
    await expect(
      structured(z.object({ a: z.array(z.string().nullable()) }), { a: [null, "x"] }),
    ).resolves.toEqual({ a: [null, "x"] });
  });

  it("根の .nullable()（包んで送った result の欄が null）", async () => {
    await expect(structured(z.string().nullable(), { result: null })).resolves.toBeNull();
  });

  it("union の枝が必須の .nullable() を持ち、1段目ではどの枝にも合わないとき", async () => {
    const schema = z.union([z.object({ a: z.string().nullable() }), z.object({ c: z.number() })]);
    await expect(structured(schema, { result: { a: null } })).resolves.toEqual({ a: null });
  });
});

describe("1段目で通る入力の結果は変えない", () => {
  it("union: 1段目で別の枝に合うなら、その結果（{ b: 'x' }）のまま", async () => {
    const schema = z.union([z.object({ a: z.string().nullable() }), z.object({ b: z.string() })]);
    await expect(structured(schema, { result: { a: null, b: "x" } })).resolves.toEqual({ b: "x" });
  });

  it("optional だけの欄の null は、今までどおり省略になる", async () => {
    const result = await structured(z.object({ a: z.string().optional() }), { a: null });
    expect(result).toEqual({});
    expect("a" in result).toBe(false);
  });
});

describe("Issue #1082: .nullable().optional() の null は今どおり省略として届く", () => {
  it("一般の形", async () => {
    const result = await structured(z.object({ a: z.string().nullable().optional() }), { a: null });
    expect("a" in result).toBe(false);
  });

  it("core の ExtractionResultSchema の subjectId", async () => {
    const result = await structured(ExtractionResultSchema, {
      memories: [
        {
          content: "本文",
          digest: null,
          tags: null,
          subjectId: null,
          provenanceKind: "stated",
          confidence: null,
        },
      ],
    });
    expect(result.memories[0]).toEqual({ content: "本文", provenanceKind: "stated" });
    expect("subjectId" in result.memories[0]!).toBe(false);
  });

  it("2段目に入っても（必須の nullable が隣に在っても）、.nullable().optional() の null は省略になる", async () => {
    const schema = z.object({ a: z.string().nullable(), s: z.string().nullable().optional() });
    const result = await structured(schema, { a: null, s: null });
    expect(result).toEqual({ a: null });
    expect("s" in result).toBe(false);
  });
});

describe("union の枝で扱いが割れる欄の null は、消す側に倒す", () => {
  it("片方の枝では必須の nullable、もう片方では optional の欄は、null を残さない（今どおり ZodError）", async () => {
    const schema = z.union([
      z.object({ a: z.string().nullable(), x: z.literal("X") }),
      z.object({ a: z.string().optional(), y: z.literal("Y") }),
    ]);
    await expect(structured(schema, { result: { a: null, x: "X" } })).rejects.toBeInstanceOf(
      ZodError,
    );
  });
});

describe("2段目でも落ちたら、1段目の ZodError をそのまま投げる", () => {
  it("1段目の issues（a と b の2件）を持つ ZodError であり、2段目の issues（b だけ）ではない", async () => {
    const schema = z.object({ a: z.string().nullable(), b: z.number() });
    const error = await structured(schema, { a: null, b: null }).then(
      () => expect.fail("例外が投げられなかった"),
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ZodError);
    const firstStage = schema.safeParse({});
    expect(firstStage.success).toBe(false);
    expect((error as ZodError).issues).toEqual(firstStage.error!.issues);
    expect((error as ZodError).issues.map((issue) => issue.path.join("."))).toEqual(["a", "b"]);
  });

  it("null を許さない必須の欄の null は、どちらの段でも落ちる（1段目の ZodError）", async () => {
    const schema = z.object({ a: z.string() });
    const error = await structured(schema, { a: null }).then(
      () => expect.fail("例外が投げられなかった"),
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues).toEqual(schema.safeParse({}).error!.issues);
  });
});
