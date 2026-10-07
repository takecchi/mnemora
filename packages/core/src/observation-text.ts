import type { Observation } from "./observation.js";

// 公開しない（`index.ts` から export しない）。
/**
 * Observation の本文を抽出（LLM）へ渡す形に合成する。`observe()` の `extractData: true`/
 * `extractTitle: true`（opt-in）は payload に印として永続化されるので、sync 経路・`deferred`・
 * `reextract` のどれでも同じ形で再現される。
 *
 * - `document`（`extractTitle: true` かつ `title` が `trim` で空にならない。ADR 0517）: `content` が
 *   空でなければ `${title}\n\n${content}`、空文字なら `title` だけ。`content` が空文字になるのは、
 *   入力 schema を通らない `reextract` 等が payload を直接読む経路だけ。
 * - `event`（`extractData: true` かつ `data` がキーを1つ以上持つプレーンオブジェクト）:
 *   `${name}\n\n${JSON.stringify(data)}`。
 * - 印が無い・条件に当たらないときは、既定の分岐（`text` → `content` → `name` →
 *   `JSON.stringify(payload)`）を通る。
 */
export function observationPayloadText(observation: Observation): string {
  const payload = observation.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (record.extractTitle === true) {
      const title = typeof record.title === "string" ? record.title : "";
      // `trim` で空になる title は空とみなして前置きにしない（断るのではなく無視する。ADR 0517）。値は trim して使わない。
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
