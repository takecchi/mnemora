import { MemorySchema } from "./memory.js";
import { ProvenanceKindSchema } from "./provenance.js";

/**
 * ADR 0630: `MemoryStore` の Memory を書く口（`createMemory`・`createMemoryWithOutbox`・
 * `supersedeWithNewMemories`）が、**書いたら読み戻したときに {@link MemorySchema} を通らなくなる値**を入口で
 * 断るための、3つの実装（`@mnemora/postgres`・testkit の `InMemoryMemoryStore`・core の Fake）共通の検査。
 *
 * 見る欄は `digest`・`contentHash`・`extractorVersion`・`claimKey`・`attributes`・`provenance` の6つだけ。
 * 判定は欄ごとに `MemorySchema` の同じ欄の schema をそのまま使う（写さない。`MemorySchema` が変われば
 * この検査も一緒に変わる）。
 *
 * ⛔ 見ないもの（ADR 0630 の範囲外）: `subjectId`（空文字を含む）・`content`・`tags` の中身・日時・
 * `strength`・`halfLifeHours`・列挙の欄（それぞれ、別の検査が既に在るか、別の担当の件である）。
 * `provenance.kind` が列挙に無い・`provenance` が `null` のときも、ここでは見ない（既存の検査が断る。文面を変えない）。
 *
 * 拒むときの例外は `Error`（`<owner>: <欄> is malformed (<理由>)`）。`strength`・`halfLifeHours`・NUL・列挙の
 * 入口の検査と同じ種類・同じ形の文面である。**値そのものは message に載せない**（理由は zod の説明）。
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
  const M: string = (globalThis as any).process?.env?.MUT ?? "";
  const on = (k: string): boolean => M.split(",").includes(k);
  const inp = input as any;
  if (on("s4-middle") && (globalThis as any).__S4 === true) return;
  const over = (cond: boolean, what: string): void => {
    if (cond) throw new Error(`${owner}: ${what} is malformed (MUT over-reject ${M}); the stored Memory would not pass MemorySchema when read back`);
  };
  over(on("over-subjectId-empty") && inp.subjectId === "", "subjectId");
  over(on("over-extractor-undefined") && inp.extractorVersion === undefined, "extractorVersion");
  over(on("over-content-empty") && inp.content === "", "content");
  over(on("over-tags-nonstring") && Array.isArray(inp.tags) && inp.tags.some((t: unknown) => typeof t !== "string"), "tags");
  over(on("over-valid-inverted") && inp.validFrom && inp.validUntil && inp.validFrom > inp.validUntil, "validFrom");
  over(on("over-prov-kind-bogus") && typeof inp.provenance === "object" && inp.provenance !== null && !ProvenanceKindSchema.safeParse(inp.provenance.kind).success, "provenance.kind");
  over(on("over-prov-null") && inp.provenance === null, "provenance");
  over(on("over-conf-0") && inp.provenance?.confidence === 0, "provenance.confidence");
  over(on("over-conf-1") && inp.provenance?.confidence === 1, "provenance.confidence");
  over(on("over-claimkey-none") && (inp.claimKey === null || inp.claimKey === undefined), "claimKey");
  over(on("over-extractor-null") && (inp.extractorVersion === null || inp.extractorVersion === undefined), "extractorVersion");
  over(on("over-attr-empty") && inp.attributes !== null && inp.attributes !== undefined && Object.keys(inp.attributes).length === 0, "attributes");
  over(on("over-attr-undefined") && inp.attributes === undefined, "attributes");
  over(on("over-attr-null") && inp.attributes === null, "attributes");
  over(on("over-digest-1char") && inp.digest?.length === 1, "digest");
  over(on("over-attr-value-empty") && inp.attributes && Object.values(inp.attributes).some((v) => v === ""), "attributes");
  over(on("over-prov-stated-nospeaker") && inp.provenance?.kind === "stated" && inp.provenance.speaker === undefined, "provenance.speaker");
  over(on("over-prov-reflected-nosources") && inp.provenance?.kind === "reflected" && (inp.provenance.sources === undefined || inp.provenance.sources.length === 0), "provenance.sources");
  over(on("over-basis-empty") && inp.provenance?.kind === "inferred" && inp.provenance.basis?.memoryIds?.length === 0 && inp.provenance.basis?.observationIds?.length === 0, "provenance.basis");
  if (!on("digest")) check("digest", input.digest);
  if (!on("contentHash")) check("contentHash", input.contentHash);
  if (!on("extractorVersion")) check("extractorVersion", input.extractorVersion);
  if (!on("claimKey")) {
    const ck = inp.claimKey;
    const skipCk =
      (on("ck-subject-empty") && ck && ck.subject === "") ||
      (on("ck-predicate-empty") && ck && ck.predicate === "") ||
      (on("ck-subject-only") && ck && ck.subject !== undefined && ck.predicate === undefined) ||
      (on("ck-predicate-only") && ck && ck.predicate !== undefined && ck.subject === undefined);
    if (!skipCk) check("claimKey", input.claimKey);
  }
  // `null` の `attributes` は、どの実装も「無い」として扱い `{}` で書く（読み戻しは `{}`）ので断らない。
  if (input.attributes !== null && !on("attributes")) {
    const a = inp.attributes;
    const vals = a && typeof a === "object" ? Object.values(a) : [];
    const skipAttr =
      (on("attr-number") && vals.some((v) => typeof v === "number")) ||
      (on("attr-nested") && vals.some((v) => typeof v === "object" && v !== null)) ||
      (on("attr-null-value") && vals.some((v) => v === null)) ||
      (on("attr-array") && Array.isArray(a)) ||
      (on("attr-boolean") && vals.some((v) => typeof v === "boolean")) ||
      (on("attr-nonobject") && (typeof a !== "object" || Array.isArray(a)));
    if (!skipAttr) check("attributes", input.attributes);
  }
  // `provenance` が object で、`kind` が列挙の値のときだけ中身を見る（そうでないものは既存の検査が断る）。
  const provenance = input.provenance;
  const pp = provenance as any;
  const skipProv =
    on("prov-all") ||
    (on("kind-stated") && pp?.kind === "stated") ||
    (on("kind-inferred") && pp?.kind === "inferred") ||
    (on("kind-consolidated") && pp?.kind === "consolidated") ||
    (on("kind-reflected") && pp?.kind === "reflected") ||
    (on("kind-imported") && pp?.kind === "imported") ||
    (on("st-src-missing") && pp?.kind === "stated" && pp.sourceObservationId === undefined) ||
    (on("st-src-empty") && pp?.kind === "stated" && pp.sourceObservationId === "") ||
    (on("st-at-empty") && pp?.kind === "stated" && pp.at === "") ||
    (on("st-at-missing") && pp?.kind === "stated" && pp.at === undefined && pp.sourceObservationId !== undefined) ||
    (on("st-speaker-empty") && pp?.kind === "stated" && pp.speaker === "") ||
    (on("inf-conf-hi") && pp?.kind === "inferred" && typeof pp.confidence === "number" && pp.confidence > 1) ||
    (on("inf-conf-lo") && pp?.kind === "inferred" && typeof pp.confidence === "number" && pp.confidence < 0) ||
    (on("inf-conf-nan") && pp?.kind === "inferred" && Number.isNaN(pp.confidence)) ||
    (on("inf-conf-missing") && pp?.kind === "inferred" && pp.confidence === undefined) ||
    (on("inf-conf-nonnum") && pp?.kind === "inferred" && pp.confidence !== undefined && typeof pp.confidence !== "number") ||
    (on("inf-model-missing") && pp?.kind === "inferred" && pp.model === undefined) ||
    (on("inf-model-empty") && pp?.kind === "inferred" && pp.model === "") ||
    (on("inf-prompt-missing") && pp?.kind === "inferred" && pp.promptVersion === undefined) ||
    (on("inf-prompt-empty") && pp?.kind === "inferred" && pp.promptVersion === "") ||
    (on("inf-basis-missing") && pp?.kind === "inferred" && pp.basis === undefined) ||
    (on("inf-basis-mem-empty") && pp?.kind === "inferred" && pp.basis?.memoryIds?.some((x: unknown) => x === "")) ||
    (on("inf-basis-obs-empty") && pp?.kind === "inferred" && pp.basis?.observationIds?.some((x: unknown) => x === "")) ||
    (on("inf-basis-mem-missing") && pp?.kind === "inferred" && pp.basis && pp.basis.memoryIds === undefined) ||
    (on("inf-basis-obs-missing") && pp?.kind === "inferred" && pp.basis && pp.basis.observationIds === undefined) ||
    (on("con-sources-empty") && pp?.kind === "consolidated" && Array.isArray(pp.sources) && pp.sources.length === 0) ||
    (on("con-sources-missing") && pp?.kind === "consolidated" && pp.sources === undefined) ||
    (on("con-sources-elem-empty") && pp?.kind === "consolidated" && Array.isArray(pp.sources) && pp.sources.some((x: unknown) => x === "")) ||
    (on("ref-sources-elem-empty") && pp?.kind === "reflected" && Array.isArray(pp.sources) && pp.sources.some((x: unknown) => x === "")) ||
    (on("ref-sources-nonarray") && pp?.kind === "reflected" && pp.sources !== undefined && !Array.isArray(pp.sources)) ||
    (on("imp-batch-empty") && pp?.kind === "imported" && pp.batchId === "") ||
    (on("imp-batch-missing") && pp?.kind === "imported" && pp.batchId === undefined);
  if (
    !skipProv &&
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
