// Manual recording only. Requires OPENAI_API_KEY and a freshly built core/openai.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { buildExtractionPrompt, ExtractionResultSchema } from "../packages/core/dist/index.js";
import { translateForOpenAIStructuredOutput } from "../packages/openai/dist/json-schema.js";
const require = createRequire(new URL("../packages/openai/package.json", import.meta.url));
const { default: OpenAI } = require("openai");
const client = new OpenAI({ maxRetries: 0, timeout: 60000 });
const model = "gpt-4.1-mini-2025-04-14";
const cases = [
  {
    id: "reference",
    text: "それでお願いします",
    messages: [{ speaker: "assistant", text: "会議室は青葉でよいですか？" }],
    expected: "会議室として青葉を選ぶ。候補を提案しただけのassistantを選択者にしない。",
  },
  {
    id: "relative-date",
    text: "明日は大阪へ出張します",
    messages: [],
    expected: "日本時間の2026-01-02に発話した明日なので、出張日は2026-01-03。",
  },
  {
    id: "other-speaker",
    text: "私は紅茶が好きです",
    messages: [{ speaker: "佐藤", text: "私はコーヒーが好きです" }],
    expected: "対象話者の田中の好みは紅茶。他人のコーヒーの好みを田中の記憶として抽出しない。",
  },
];
const rows = [];
let usd = 0;
for (const c of cases) {
  for (const enabled of [false, true]) {
    const observation = {
      id: c.id,
      tenantId: "context-eval",
      kind: "utterance",
      subjectId: "tanaka",
      occurredAt: new Date("2026-01-01T23:00:00Z"),
      recordedAt: new Date("2026-01-10T00:00:00Z"),
      payload: {
        text: c.text,
        speaker: "田中",
        ...(enabled ? { extractionContext: { messages: c.messages, timeZone: "Asia/Tokyo" } } : {}),
      },
    };
    const prompt = buildExtractionPrompt(observation);
    const format = translateForOpenAIStructuredOutput("extraction", ExtractionResultSchema);
    // Conservative byte-based input bound; reserve output before sending. Rates: official GPT-4.1 mini model page.
    const inputBound = Buffer.byteLength(JSON.stringify({ prompt, format })) + 4096;
    const reserve = (inputBound * 0.4) / 1e6 + (1500 * 1.6) / 1e6;
    if (usd + reserve > 0.25) throw new Error("Recording budget exceeded");
    const result = await client.chat.completions.create({
      model,
      max_completion_tokens: 1500,
      messages: [{ role: "system", content: prompt.system }, ...prompt.messages],
      response_format: { type: "json_schema", json_schema: format },
    });
    usd += reserve; // reserve rather than undercount on missing usage or errors
    rows.push({
      id: c.id,
      enabled,
      expected: c.expected,
      observation,
      prompt,
      response: result.choices[0],
      usage: result.usage,
    });
  }
}
const output = process.argv[2];
if (!output) throw new Error("Pass an output filename");
writeFileSync(
  output,
  JSON.stringify(
    {
      model,
      recordedAt: new Date().toISOString(),
      kind: "development measurement; not held-out",
      reservedUsd: usd,
      rows,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ requests: rows.length, reservedUsd: usd, output }));
