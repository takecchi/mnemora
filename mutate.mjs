// usage: node mutate.mjs <mutants.mjs> <id> <repoRoot>
// 置き換え元との一致がちょうど1件のときだけ書き込む。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [, , defsPath, id, root] = process.argv;
const { mutants } = await import(defsPath);
const m = mutants.find((x) => x.id === id);
if (!m) { console.error(`no mutant ${id}`); process.exit(2); }
const file = join(root, m.file);
const src = readFileSync(file, "utf8");
let out = src;
for (const [from, to] of m.edits) {
  const count = out.split(from).length - 1;
  if (count !== 1) { console.error(`${id}: match count ${count} for: ${from.slice(0, 80)}`); process.exit(3); }
  out = out.replace(from, () => to);
}
writeFileSync(file, out);
console.log(`${id}: applied ${m.edits.length} edit(s) to ${m.file}`);
