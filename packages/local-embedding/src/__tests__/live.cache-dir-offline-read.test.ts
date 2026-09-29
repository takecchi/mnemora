import { execFile } from "node:child_process";
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
 * live テスト（本物のモデルを一度だけ Hugging Face から落とす。opt-in の条件・課金が発生しない
 * 理由は `live.local-embedding.test.ts` の docstring と同じ）。
 *
 * **直した Issue #1239 を、本物の transformers.js・本物のモデルで通す。**
 * `cache-dir-preflight-default-cache.test.ts`（偽のファイル）・
 * `cache-dir-env-swap-serialization.test.ts`（`@huggingface/transformers` を丸ごと mock）は
 * どちらも本物の読み込みを通していない。ここは、
 *
 * 1. `cacheDir` を一度だけ本物のモデルで温め（cold・ネットワークあり）、
 * 2. **まっさらな別プロセス**で、**既定のキャッシュには一切触れず**、`env.fetch` を
 *    必ず失敗させた状態で、`createLocalEmbeddingPipeline({ cacheDir })` から読み込んで
 *    `embed()` まで通し、
 *
 * 「`cacheDir` だけで、オフラインで読めて埋め込みが出る」ことを実際に確かめる。
 *
 * ⚠ **要る条件**: `MNEMORA_LIVE_LOCAL_EMBEDDING`（既存の opt-in）に加えて、
 * **このテストを走らせる前に `pnpm --filter @mnemora/core run build` と
 * `pnpm --filter @mnemora/local-embedding run build` が要る**——ステップ2は
 * `@mnemora/local-embedding` の**ビルド済み dist**を、公開されている入口
 * （`createLocalEmbeddingPipeline`）から読む別プロセスだからである（`src/pipeline.ts` を
 * 直接読む形にすると、直した対象が実際に消費者へ届く形になっているかまでは確かめられない）。
 * dist が無い・古いと、ステップ2はモジュール解決の失敗か、直す前の挙動で失敗する。
 *
 * **CI では走らない**（既存の opt-in と同じ。`MNEMORA_LIVE_LOCAL_EMBEDDING` を設定していない）。
 */
const live = (process.env.MNEMORA_LIVE_LOCAL_EMBEDDING ?? "") !== "";

const MEASURE_SCRIPT = fileURLToPath(
  new URL("./fixtures/measure-offline-read-via-cache-dir.mjs", import.meta.url),
);

interface MeasureResult {
  readonly fetchCount: number;
  readonly urls: string[];
  readonly outcome: "loaded" | "failed";
  readonly error: string | null;
  readonly vectorLen: number | null;
}

async function measureOfflineRead(cacheDir: string): Promise<MeasureResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [MEASURE_SCRIPT, cacheDir, DEFAULT_LOCAL_EMBEDDING_REPO, DEFAULT_LOCAL_EMBEDDING_DTYPE],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 60_000 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as MeasureResult;
}

describe("live: cacheDir だけで、オフラインで読めて埋め込みが出る（直った Issue #1239。MNEMORA_LIVE_LOCAL_EMBEDDING が無ければ skipped と表示される）", () => {
  it.skipIf(!live)(
    "cold で温めた cacheDir を、まっさらな別プロセス・既定のキャッシュ空・ネットワーク無効の状態で createLocalEmbeddingPipeline から読むと、256次元のベクトルが返り、ネットワークへの要求は0回",
    async () => {
      const cacheDir = await mkdtemp(path.join(tmpdir(), "mnemora-local-embedding-offline-"));
      try {
        // 1. 温める（cold。本物のモデル一式を cacheDir へ落とす）。
        const spec: LocalEmbeddingModelSpec = {
          repo: DEFAULT_LOCAL_EMBEDDING_REPO,
          dtype: DEFAULT_LOCAL_EMBEDDING_DTYPE,
          cacheDir,
          numThreads: 1,
        };
        const coldPipeline = await createLocalEmbeddingPipeline(spec);
        const coldVectors = await coldPipeline.embed(["温め用の文"]);
        expect(coldVectors).toHaveLength(1);
        expect(coldVectors[0]).toHaveLength(256);

        // 2. まっさらな別プロセス・既定のキャッシュ空・ネットワーク無効で読む（"オフライン"）。
        const offline = await measureOfflineRead(cacheDir);

        // 報告に数字を持ち帰るため、有効桁を落とさずに出力する。
        console.error(
          `[cache-dir offline read] outcome=${offline.outcome} fetchCount=${offline.fetchCount} ` +
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
