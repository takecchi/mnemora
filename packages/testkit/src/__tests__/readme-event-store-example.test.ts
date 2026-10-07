import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
const section = README.slice(README.indexOf("## 動く最小の例"));
const open = section.indexOf("```ts check\n");
if (open === -1) throw new Error("README「動く最小の例」に ts check の片が見つからない");
const snippet = section.slice(open + "```ts check\n".length, section.indexOf("\n```", open + 1));
const IMPORT = 'import { describeEventStoreConformance } from "@mnemora/testkit";';
if (!snippet.includes(IMPORT) || !snippet.includes("describeEventStoreConformance({")) {
  throw new Error(`README「動く最小の例」の片の形が変わった:\n${snippet}`);
}

const index = fileURLToPath(new URL("../index.ts", import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "mnemora-testkit-readme-"));
const file = path.join(dir, "my-event-store.test.ts");
writeFileSync(
  file,
  snippet.replace(
    IMPORT,
    `import { describeEventStoreConformance } from ${JSON.stringify(index)};`,
  ),
);
// 片は describe を登録するだけなので、収集の段で import する。
await import(file);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
