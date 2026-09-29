import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_EMBEDDING_DTYPE,
  DEFAULT_LOCAL_EMBEDDING_REPO,
} from "../local-embedding-provider.js";
import { createLocalEmbeddingPipeline } from "../pipeline.js";
import type { LocalEmbeddingModelSpec } from "../pipeline.js";

const execFileAsync = promisify(execFile);

/**
 * live テスト（本物のモデルを一度だけ Hugging Face から落とす。opt-in の条件・課金が発生しない理由は
 * `live.local-embedding.test.ts` の docstring と同じ）。
 *
 * **直した Issue #1403 を、本物の transformers.js・本物のモデルで通す。**`live.cache-dir-offline-read.test.ts`
 * と同じ形で、`revision` を固定したときを当てる。
 *
 * 1. `cacheDir` と固定した revision（`scripts/local-embedding-pinned-revision.json` の sha）で、一度だけ
 *    本物のモデルを温める（cold・ネットワークあり）。
 * 2. **まっさらな別プロセス**で、`env.fetch` を必ず失敗させた状態で、同じ `cacheDir` と `revision` を
 *    `createLocalEmbeddingPipeline` に渡して読み、`embed()` まで通す。
 *
 * ⚠ **要る条件**: `MNEMORA_LIVE_LOCAL_EMBEDDING` に加えて、走らせる前に
 * `pnpm --filter @mnemora/core run build` と `pnpm --filter @mnemora/local-embedding run build` が要る
 * （ステップ2はビルド済みの dist を読む。`live.cache-dir-offline-read.test.ts` と同じ理由）。
 *
 * **CI では走らない**（`MNEMORA_LIVE_LOCAL_EMBEDDING` を設定していない）。
 */
const live = (process.env.MNEMORA_LIVE_LOCAL_EMBEDDING ?? "") !== "";

const MEASURE_SCRIPT = fileURLToPath(
  new URL("./fixtures/measure-offline-read-via-cache-dir.mjs", import.meta.url),
);

/** 固定した revision の唯一の宣言（Issue #597）。 */
function pinnedRevision(): string {
  const declaration = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../../scripts/local-embedding-pinned-revision.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { sha: string };
  return declaration.sha;
}

interface MeasureResult {
  readonly fetchCount: number;
  readonly urls: string[];
  readonly outcome: "loaded" | "failed";
  readonly error: string | null;
  readonly vectorLen: number | null;
}

async function measureOfflineRead(cacheDir: string, revision: string): Promise<MeasureResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      MEASURE_SCRIPT,
      cacheDir,
      DEFAULT_LOCAL_EMBEDDING_REPO,
      DEFAULT_LOCAL_EMBEDDING_DTYPE,
      revision,
    ],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 60_000 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as MeasureResult;
}

describe("live: revision を固定しても、温めた cacheDir だけでオフラインで読めて埋め込みが出る（直った Issue #1403。MNEMORA_LIVE_LOCAL_EMBEDDING が無ければ skipped と表示される）", () => {
  it.skipIf(!live)(
    "固定した revision で cold に温めた cacheDir を、まっさらな別プロセス・ネットワーク無効の状態で同じ revision で読むと、256次元のベクトルが返り、ネットワークへの要求は0回",
    async () => {
      const cacheDir = await mkdtemp(path.join(tmpdir(), "mnemora-local-embedding-revision-"));
      const revision = pinnedRevision();
      try {
        // 1. 温める（cold。本物のモデル一式を `<cacheDir>/<revision>/` へ落とす）。
        const spec: LocalEmbeddingModelSpec = {
          repo: DEFAULT_LOCAL_EMBEDDING_REPO,
          dtype: DEFAULT_LOCAL_EMBEDDING_DTYPE,
          cacheDir,
          numThreads: 1,
          revision,
        };
        const coldPipeline = await createLocalEmbeddingPipeline(spec);
        const coldVectors = await coldPipeline.embed(["温め用の文"]);
        expect(coldVectors[0]).toHaveLength(256);

        // 2. まっさらな別プロセス・ネットワーク無効で、同じ revision で読む（"オフライン"）。
        const offline = await measureOfflineRead(cacheDir, revision);
        console.error(
          `[revision offline read] outcome=${offline.outcome} fetchCount=${offline.fetchCount} ` +
            `vectorLen=${offline.vectorLen} urls=${JSON.stringify(offline.urls)} error=${offline.error ?? ""}`,
        );

        expect(offline.outcome).toBe("loaded");
        expect(offline.fetchCount).toBe(0);
        expect(offline.urls).toEqual([]);
        expect(offline.vectorLen).toBe(256);
      } finally {
        await rm(cacheDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
