/** `globalThis.fetch` の差し替えは transformers.js を読み込む前でなければ効かない（読み込み時に束縛される）。だから `providers.js` は差し替えの後に動的に読み込む。 */
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
