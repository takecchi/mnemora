# ADR 0419: `LocalEmbeddingProvider` に任意の `dispose()` を足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローン miku の委譲先が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  `LocalEmbeddingProvider` は最初の `embed()`（または `warmup()`）で ONNX のモデルを読み込み、その pipeline を
  `#ready` に握り続ける。**手放す経路が無かった。**プロセスを終えれば OS が回収するが、長く生きるプロセスの中で
  provider を作っては捨てる使い方（テスト・ホットリロード・複数モデルの切り替え）では、ONNX のセッションが残る。
  上流の `@huggingface/transformers` の pipeline には `async dispose()` があるが、`LocalEmbeddingExtractor` 型がそれを写しておらず、
  provider からも届かなかった。

- **決めたこと**:

  1. **`LocalEmbeddingProvider` に public な `dispose(): Promise<void>` を足す。`EmbeddingProvider`（core の interface）には載せない。**
     載せない理由: (a) OpenAI など HTTP の provider は手放すものを持たず、interface に載せると全 adapter に空の実装を強いる。
     (b) 任意メソッドを interface に足すのは、呼ぶ側（runtime）に「在れば呼ぶ」分岐と、呼ぶ時機の契約（誰が閉じるか）を背負わせる。
     解放するのは provider を作った利用者であり、runtime ではない（runtime は provider を借りているだけ）。
     (c) core の公開面を増やさずに済む。必要になれば、後から interface に任意メソッドとして足せる（逆は破壊的）。
  2. **解放は上流の `dispose()` に委ねる。**`LocalEmbeddingExtractor` に任意の `dispose?()` を写し、`LocalEmbeddingPipeline` にも任意の
     `dispose?()` を足す。`buildLocalEmbeddingPipeline` は extractor が持っていればそこへ繋ぐ。**任意にした**のは、
     `createPipeline` で注入される擬似の pipeline が持たなくてよいようにするためである（持たなければ `dispose()` は何もしない）。
     ONNX のセッションの解放の仕方を、こちらで再実装しない。
  3. **dispose 後の振る舞い: `embed()` も `warmup()` も、素の `Error` で断る。**文言は既存の書き方（`LocalEmbeddingProvider: …`、
     日本語、次にできること付き）に揃えた。読み込み直さない（`dispose()` は一方向。続けるなら新しいインスタンスを作る）。
     **断るのは、入力の検査より前に置いた。**既存の `embed()` は「空配列は `[]` を即返す」「signal が abort 済みなら読み込み前に投げる」
     の順で、入力・signal の検査が先頭にある。そこへ後ろから足すと、空配列だけが dispose 後でも黙って通る
     ——使い終わったものを使っているというプログラムの誤りが、特定の入力のときだけ隠れる。誤りは入力に依らず同じ顔で出るほうがよい。
     `kind` 付きの `LocalEmbeddingProviderError` にはしなかった: あれは入力・設定に由来する失敗（`input_too_long` など）の作法で、
     呼び出し側の分岐の対象になる。dispose 後の使用はプログラムの誤りであり、分岐して復旧するものではない。
  4. **読み込み中・推論中の扱い: 待ってから解放する。**`dispose()` は同期に「dispose 済み」を立て（以後の `embed` / `warmup` は即座に断られる）、
     そのうえで (1) 読み込み中ならその完了を待つ、(2) 走っている `embed()` が終わるのを待つ、(3) 上流の `dispose()` を呼ぶ。
     読み込みの完了を待たずに返すと、その後に出来上がる pipeline を誰も解放せず**漏れる**。推論中に解放すると、
     上流のセッションが実行中に破棄される。dispose より前に始まった `embed()` は、そのまま最後まで走って結果を返す。
     読み込みが失敗していたら解放するものが無いので、`dispose()` は reject しない。
  5. **2回目以降は最初の Promise を返す。**上流の `dispose()` は1回しか呼ばない（並行に呼んでも同じ）。上流の `dispose()` が
     reject したら、その理由で reject する（握りつぶさない）。

- **検討した代替案**:

  1. **`EmbeddingProvider` に任意の `dispose?()` を足す。** 採らなかった（決めたこと1）。
  2. **dispose 後の `embed()` で読み込み直す（再利用可能にする）。** 採らなかった。`dispose()` を呼んだ意図は手放すことで、
     黙って再取得すると、解放したはずのメモリが戻る。断るほうが誤りに気づける。
  3. **読み込みの完了を待たず、完了後に自動で解放する（`dispose()` は即 resolve）。** 採らなかった。`await dispose()` の後に
     解放済みと読めなくなる（テストの後始末・プロセス終了前の解放で困る）。
  4. **`kind` 付きのエラーにする。** 決めたこと3の通り採らなかった。

- **引き受けた負債**:

  - `dispose()` は `embed()` の中断はしない（上流の推論は途中で止められない。[ADR 0359](./0359-abort-signal-for-provider-calls.md)）。
    推論中に呼ぶと、その推論が終わるまで `dispose()` は解決しない。
  - `runtime` は `dispose()` を呼ばない。閉じ忘れは利用者の責任のままである。
  - 上流の `dispose()` が実際にメモリを OS へ返すかどうか（onnxruntime 側の挙動）は測っていない。ここが保証するのは、上流の `dispose()` を
    漏らさず・1回だけ呼ぶところまでである。

- **これが覆るとしたら**:

  他の provider にも解放すべきものが出てきて、runtime が provider の寿命を持つ設計（`runtime.close()` など）にするなら、
  `EmbeddingProvider` への任意メソッドの追加を再検討してよい。その場合も、この `dispose()` は残せる。

- **測ったこと**:

  - 歯は重みを取らない（`createPipeline` の注入口と擬似の extractor のみ）：`packages/local-embedding/src/__tests__/dispose.test.ts`。
    上流の dispose まで届く・dispose 後の embed / warmup が断られる（空配列・abort 済みでも）・2回目が安全で上流は1回・
    読み込み中に dispose すると完了を待つ・読み込み失敗でも reject しない・走っている embed を待つ、の12本。
    実装前は12本中11本が赤、実装後は12本とも緑。
  - **測っていないこと**: 本物のモデルでの `dispose()`（live テストには足していない）。
