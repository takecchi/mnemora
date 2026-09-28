import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import {
  assertValidEventRetentionDays,
  DEFAULT_HALF_LIFE_HOURS,
  type Ctx,
  type EventRetention,
  type EventRetentionSetting,
  type TenantSettingsStore,
} from "@mnemora/core";

/**
 * `docs/migration-v1.md` §6 の例（`describeTenantSettingsStoreConformance` に `supportsDecayClock: false`
 * だけを足した呼び出し）が「そのままコンパイル・**実行**できる」ことを縛る。
 * `check:doc-snippets` は型しか見ないので、ここでは片そのものを文書から取り出し、import 先を
 * testkit の入口に向けるだけで実行する——片が登録する適合テストが、このファイルのテストとして走る。
 *
 * 片が前提にしている `MyTenantSettingsStore`（自作 adapter）は、`TenantSettingsStore` の必須の3口だけを持ち、
 * 任意の口（decay clock・taxonomy mode など）を1つも実装しない最小の store として、ここで用意する。
 * ⟹ 任意の口を実装していない adapter に対して、省略した `supports*` の適合項目が走らないことも同時に見ている
 * （走れば、実装していない口を呼んで赤になる）。
 */

class MyTenantSettingsStore implements TenantSettingsStore {
  private readonly retention = new Map<string, EventRetentionSetting>();

  async getDefaultHalfLifeHours(_ctx: Ctx): Promise<number> {
    return DEFAULT_HALF_LIFE_HOURS;
  }

  async getEventRetention(ctx: Ctx): Promise<EventRetention> {
    return this.retention.get(ctx.tenantId) ?? { kind: "unset" };
  }

  async setEventRetention(ctx: Ctx, retention: EventRetentionSetting): Promise<void> {
    if (retention.kind === "days") assertValidEventRetentionDays(retention.days);
    this.retention.set(ctx.tenantId, retention);
  }
}

const GUIDE = readFileSync(
  fileURLToPath(new URL("../../../../docs/migration-v1.md", import.meta.url)),
  "utf8",
);
const section = GUIDE.slice(GUIDE.indexOf("### 6. "));
const open = section.indexOf("```ts check\n");
if (open === -1) throw new Error("docs/migration-v1.md §6 に ts check の片が見つからない");
const snippet = section.slice(open + "```ts check\n".length, section.indexOf("\n```", open + 1));
const IMPORT = 'import { describeTenantSettingsStoreConformance } from "@mnemora/testkit";';
if (!snippet.includes(IMPORT) || !snippet.includes("supportsDecayClock: false")) {
  throw new Error(`docs/migration-v1.md §6 の片の形が変わった:\n${snippet}`);
}

(globalThis as { MyTenantSettingsStore?: unknown }).MyTenantSettingsStore = MyTenantSettingsStore;
const index = fileURLToPath(new URL("../index.ts", import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), "mnemora-migration-guide-"));
const file = path.join(dir, "snippet.ts");
writeFileSync(
  file,
  snippet.replace(
    IMPORT,
    `import { describeTenantSettingsStoreConformance } from ${JSON.stringify(index)};`,
  ),
);
// 片は describe を登録するだけなので、収集の段で import する。
await import(file);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
