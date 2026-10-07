import { MemorySchema } from "./memory.js";
import { ProvenanceKindSchema } from "./provenance.js";

/**
 * `MemoryStore` の Memory を書く口（`createMemory`・`createMemoryWithOutbox`・
 * `supersedeWithNewMemories`）が、書いたら読み戻したときに {@link MemorySchema} を通らなくなる値を
 * 入口で断るための、全実装共通の検査（ADR 0630）。
 *
 * 見る欄は `digest`・`contentHash`・`extractorVersion`・`claimKey`・`attributes`・`provenance` の6つだけ。
 * 判定は欄ごとに `MemorySchema` の同じ欄の schema をそのまま使う（写さない）。
 *
 * 見ないもの: `subjectId`（空文字を含む）・`content`・`tags` の中身・日時・`strength`・`halfLifeHours`・
 * 列挙の欄。`provenance.kind` が列挙に無い・`provenance` が `null` のときも、ここでは見ない
 * （既存の検査が断る）。
 *
 * 拒むときの例外は `Error`（`<owner>: <欄> is malformed (<理由>)`）。**値そのものは message に載せない**
 * （理由は zod の説明）。
 *
 * 呼ぶ側は、**何かを書く前に**（冪等の既存行の判定より前に）呼ぶこと。
 */
export function assertWellFormedNewMemory(
  owner: string,
  input: {
    digest?: unknown;
    contentHash?: unknown;
    extractorVersion?: unknown;
    claimKey?: unknown;
    attributes?: unknown;
    provenance?: unknown;
  },
): void {
  const check = (
    field: "digest" | "contentHash" | "extractorVersion" | "claimKey" | "attributes",
    value: unknown,
  ): void => {
    const result = MemorySchema.shape[field].safeParse(value);
    if (!result.success) {
      throw malformed(owner, field, result.error.issues[0]);
    }
  };
  check("digest", input.digest);
  check("contentHash", input.contentHash);
  check("extractorVersion", input.extractorVersion);
  check("claimKey", input.claimKey);
  // `null` の `attributes` は、どの実装も「無い」として扱い `{}` で書く（読み戻しは `{}`）ので断らない。
  if (input.attributes !== null) {
    check("attributes", input.attributes);
  }
  // `provenance` が object で、`kind` が列挙の値のときだけ中身を見る（そうでないものは既存の検査が断る）。
  const provenance = input.provenance;
  if (
    typeof provenance === "object" &&
    provenance !== null &&
    ProvenanceKindSchema.safeParse((provenance as { kind?: unknown }).kind).success
  ) {
    const result = MemorySchema.shape.provenance.safeParse(provenance);
    if (!result.success) {
      throw malformed(owner, "provenance", result.error.issues[0]);
    }
  }
}

function malformed(
  owner: string,
  field: string,
  issue: { path: PropertyKey[]; message: string } | undefined,
): Error {
  const path = [field, ...(issue?.path ?? [])].map(String).join(".");
  return new Error(
    `${owner}: ${path} is malformed (${issue?.message ?? "invalid"}); the stored Memory would not pass MemorySchema when read back`,
  );
}
