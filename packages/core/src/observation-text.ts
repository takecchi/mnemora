import type { Observation } from "./observation.js";

// ⚠ 公開しない（`index.ts` から export しない）。`extraction.ts` と、言語の事後検査（runtime.ts）が
// 同じ「観測の本文」を見るために、`extraction.ts` から切り出した（Issue #1370、ADR 0391）。中身は移しただけ。
/**
 * Issue #1185: `observe()` の `event.data`・`document.title` を抽出（LLM）へ渡す opt-in。
 *
 * `extractObservationPayload`（runtime.ts）が、`extractData: true`/`extractTitle: true` を
 * 渡した呼び出しのときだけ payload へ `extractData: true`/`extractTitle: true` という印を書く
 * （渡さない・`false` のときは、payload にこのキー自体が増えない）。この関数はその印を見て、
 * `observationPayloadText`（下記）が返す本文を合成する。印は Observation の `payload` に
 * 永続化されるため、`extract: 'deferred'`（`processExtractJob` が `getObservation` で読み直す）・
 * `reextract`（同じく `getObservation` で読み直す）のどちらでも、sync 経路と同じ形で再現される。
 *
 * - `document`（`extractTitle: true` かつ `title` が空でない文字列。`trim` で空になる値は空とみなす。ADR 0517）: `content` が空でなければ
 *   `${title}\n\n${content}`。`content` が空文字なら `title` だけ（区切りの後に何も続かない
 *   `${title}\n\n` を避ける）。**`observe()` の入力 schema は `title`/`content` どちらも
 *   `min(1)` を課すため、`content` が空文字になるのは `reextract` 等が payload を直接読む
 *   経路だけである**（`ObserveDocumentInput.title`/`content` の doc コメント参照）。
 * - `event`（`extractData: true` かつ `data` がキーを1つ以上持つプレーンオブジェクト）:
 *   `${name}\n\n${JSON.stringify(data)}`。`data` を渡さない・空オブジェクト `{}` なら、
 *   印があっても `name` だけ（下の既定の分岐にそのまま流れる）。
 * - 印が無い・条件に当たらない（`title`/`data` が空）ときは、下の既定の分岐
 *   （`text` → `content` → `name` → `JSON.stringify(payload)`）を1バイトも変えずに通る。
 */
export function observationPayloadText(observation: Observation): string {
  const payload = observation.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.extractTitle === true) {
      const title = typeof record.title === "string" ? record.title : "";
      // ADR 0517: `trim` で空になる title（空白・改行・タブ・U+3000 だけ）は空とみなし、前置きにしない
      // （断るのではなく無視する。「空白」の定義は ADR 0502 と同じ `trim`）。値は trim して使わない。
      if (title.trim().length > 0) {
        const content = typeof record.content === "string" ? record.content : "";
        return content.length > 0 ? `${title}\n\n${content}` : title;
      }
    }
    if (record.extractData === true) {
      const name = typeof record.name === "string" ? record.name : "";
      const data = record.data;
      if (
        name.length > 0 &&
        data !== null &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        Object.keys(data as Record<string, unknown>).length > 0
      ) {
        return `${name}\n\n${JSON.stringify(data)}`;
      }
    }
    if (typeof record.text === "string" && record.text.length > 0) {
      return record.text;
    }
    if (typeof record.content === "string" && record.content.length > 0) {
      return record.content;
    }
    if (typeof record.name === "string" && record.name.length > 0) {
      return record.name;
    }
  }
  return JSON.stringify(payload ?? null);
}
