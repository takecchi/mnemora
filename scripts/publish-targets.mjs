/**
 * 順序は依存の向きで決まる(`core` → `testkit` / `openai` → `postgres`)。誤ると使う側が E404 を見る。
 * 順序の整合は `scripts/__tests__/publish-targets.test.mjs` が機械的に検査する。
 *
 * 対象は固定リストで、動的に発見しない。publish 対象と非対象(ルートの `mnemora` /
 * `@mnemora/example-chat`)を分ける機械的な目印が無い。新しい対象は手で足す必要があり、見落としは検知できない。
 */

/** @type {{ name: string; dir: string }[]} */
export const PUBLISH_TARGETS = [
  { name: "@mnemora/core", dir: "packages/core" },
  { name: "@mnemora/testkit", dir: "packages/testkit" },
  { name: "@mnemora/openai", dir: "packages/openai" },
  { name: "@mnemora/postgres", dir: "packages/postgres" },
  { name: "@mnemora/anthropic", dir: "packages/anthropic" },
  { name: "@mnemora/local-embedding", dir: "packages/local-embedding" },
  // 未公開のパッケージは末尾に置く。初版は Trusted Publishing(OIDC)で出せず(npm/cli#8544、ADR 0066)、
  // 途中に居ると、その後ろが publish されない。
  { name: "@mnemora/bullmq", dir: "packages/bullmq" },
];
