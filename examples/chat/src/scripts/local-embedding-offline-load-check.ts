/**
 * 温めたキャッシュだけで、`local` の埋め込みを読み込めるかを確かめる（Issue #1004。測るだけ。門ではない）。
 *
 * `globalThis.fetch` を、呼ばれた URL を記録して必ず失敗する関数へ差し替えてから、`createProviders` で
 * `MNEMORA_EMBEDDING=local` の埋め込み（`revision` を固定し、`MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` を渡す、
 * examples/chat と同じ組み立て）を作り、1件だけ `embed()` する。
 *
 * 🔴 差し替えは、transformers.js を読み込む**前**でなければ効かない——4.2.0 は読み込み時に
 * `globalThis.fetch` を束縛して既定の `env.fetch` にする。⟹ `providers.js` は、差し替えの後に動的に読み込む。
 *
 * 出力は1行（`[offline-load-check] ok=… requests=… …`）。読み込めなくても終了コードは 0 である。
 */
const requests: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  throw new TypeError("fetch failed (offline-load-check: ネットワークへは出さない)");
}) as typeof fetch;

const { createProviders } = await import("../providers.js");
const started = Date.now();
try {
  const { embeddingProvider } = createProviders({
    ...process.env,
    MNEMORA_LLM: "deterministic",
    MNEMORA_EMBEDDING: "local",
  });
  const [vector] = await embeddingProvider.embed({ tenantId: "offline-load-check" }, [
    "キャッシュの確認",
  ]);
  console.log(
    `[offline-load-check] ok=true dims=${vector?.length} requests=${requests.length} ms=${Date.now() - started}`,
  );
} catch (error) {
  const shown = requests
    .slice(0, 3)
    .map((url) => url.replace("https://huggingface.co", ""))
    .join(" ");
  console.log(
    `[offline-load-check] ok=false requests=${requests.length} ms=${Date.now() - started} first=${shown} ` +
      `error=${String((error as Error).message).slice(0, 120)}`,
  );
}
