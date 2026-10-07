/**
 * draft の PR でだけ job を飛ばす、job レベルの `if:` の行（`ci.yml` の全 job に付く）。
 *
 * job に `if:` を付けないことを測る歯（#426 の測定ジョブ・required の build / example-chat）は、
 * **この1行だけは逐語で一致するときに限って許す。** draft で飛ばしても、ready_for_review で同じ
 * head を測り直し、main への push では必ず走るので、「一度も走らないまま着地する」形にはならない。
 *
 * ⛔ 部分一致・正規表現にしない: 条件を1つ足しただけ（`&& github.event_name == 'push'` 等）で
 * 静かに通る形を作らないため、行ごと比べる。
 *
 * ⚠ 引き受けた穴: required の job も draft では skipped になり、GitHub は skipped を合格として
 * 扱う。`gh pr ready` の直後、ready_for_review の run の check run が作られるまでの間は、
 * 測っていない head がマージ可能に見える。ready にしたら新しい run の結果を見てからマージすること。
 */
export const DRAFT_ONLY_JOB_IF =
  "    if: github.event_name != 'pull_request' || github.event.pull_request.draft == false";

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isDraftOnlyJobIf(line) {
  return line.trimEnd() === DRAFT_ONLY_JOB_IF;
}
