# ADR 0517: `extractTitle: true` のとき、空白だけの `document.title` を本文の前置きにしない（断らず、無視する）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先の担い手が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所: [ADR 0502](./0502-observe-rejects-whitespace-only-input.md)「引き受けた負債」の 1（`title` が空白だけでも通り、`extractTitle: true` で本文の前置きが空白になる）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果（Node.js。core の名指しのテスト）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: `extractTitle: true` の `document` で、`title` が `"  "` のような空白だけだと、抽出（LLM）に渡る本文と全文フォールバックの Memory の本文が `"  \n\nC"` になる。

- **現物の確認**【現物】: 約束と実装の食い違いだった。
  - TSDoc（`packages/core/src/observation.ts` の `Observation.title`、`observation-text.ts` の `observationPayloadText`）は「`title` が空でない文字列のときだけ前置きにする」と書く。実装は `title.length > 0` で見ていた。
  - ADR 0502 決定4 は `title` を断らなかった。理由は「空白だけの `title` は本文が空になる経路ではない」「`title` の空白の扱いを新しく決めるのは材料1の範囲を出る」で、**前置きにしないよう直すか、断るかは別の判断**と負債に積んだ（負債 1）。**「空白だけを空とみなして無視する」読みは、この決定4とも TSDoc とも矛盾しない**。0502 が「空白」の定義に使った `String.prototype.trim` を、そのまま使える。
  - 空白だけの `title` を断る案は、0502 の採らなかった案 5 のとおり採らない（新しく断る入力を作らない。`observe()` の入力の受け入れ範囲は変えない）。
  - 前置きが作られる場所は `observationPayloadText` の1か所だけ（`extraction.ts`・`runtime.ts` の言語の事後検査・全文フォールバックが、いずれもこの関数を通る）。【現物】`grep` で確認。

- **決めたこと**【判断】:
  1. `observationPayloadText` は、`title` が `trim` して空になるとき、`extractTitle: true` でも前置きにしない。本文は `title` を渡さなかったときと同じ（`content` だけ）になる。
  2. **値は trim して使わない**。実質のある `title`（`" T "` など）は、前後の空白もそのまま `${title}\n\n${content}` に入る（保存する値も変えない）。
  3. 新しく断る入力は無い。`ObserveInputSchema` は変えない（0502 の「範囲の外」の歯は、そのまま緑）。公開 API・型・既定値（`extractTitle` は既定 `false`）は変えない。
  4. TSDoc に「空白だけは空とみなす」を足した。

- **採らなかった案**:
  1. **空白だけの `title` を断る。** 新しく断る入力になり、0502 の案 5 と同じ理由で採らない。`title` は飾りで、無視して本文が壊れることは無い。
  2. **`title.trim()` を前置きに使う。** 保存する値と LLM に渡す値が食い違い、`"T"` と `" T "` の本文が同じになる。実質のある `title` の挙動を変える理由が無い。

- **赤→緑・変異**【実測。ファイルを名指しして走らせた】:
  - 直す前: core の `observation-text-blank-title-not-prefixed.test.ts`（新規）は 10 本中 7 本が赤（空白だけの 6 種と、`content` が空の行）。空文字・実質のある `title`・`extractTitle` 無しの3本は直す前から緑。
  - 直した後: 10 本とも緑。`observe-rejects-whitespace-only-input.test.ts`（0502 の歯）も緑（55 本）。
  - 変異: `title` を `trim()` した値で前置きにする → 1 本が赤（`" T "` の行）。`trim` の判定を外す（直す前に戻す）→ 7 本が赤。戻した後は緑。

- **引き受けた負債**:

  | # | 負債 | 結果 | 覆る条件 |
  |---|---|---|---|
  | 1 | `trim` が落とさない不可視文字（U+200B など）だけの `title` は、前置きになる | 見た目が空の前置きが LLM に渡りうる | 0502 の負債 4 と同じ。`trim` を超える「見た目が空」の定義を決めるとき |
  | 2 | すでに保存された Observation を `reextract`・`deferred` で読み直すと、新しい規則で本文が作られる（`payload` の `title` は変えていない） | 空白だけの `title` で作られていた本文が、`content` だけに変わる | 遡って書き換えるのはオーナーの領分。読み直し時の本文の作り方を固定したいと決まったとき |
  | 3 | `event` の `extractData` の `name` は、空白だけでも前置きになりうる（`name` は 0502 で空白だけを断るので、通常は届かない） | `reextract` が読む既存データだけ | 必要が出たとき |

- **これが覆るとしたら**: 空白だけの `title` を意図して前置きにしたい利用者が居ると分かったとき（想定しにくい）。

- **測っていないこと**【未確認】: 実際に空白だけの `title` を送っている呼び出し側の頻度。LLM を通した抽出の結果への影響（前置きが無くなるだけで、本文は `title` を渡さなかったときと同じになることを、`observationPayloadText` の単体で確かめた）。Postgres を通した経路（本文の合成は純関数で、store に依らない）。手元以外の環境。
