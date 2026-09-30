# ADR 0445: local-embedding の分割推論でチャンクの合間に abort を見る・`chat` が embed の失敗を言う・provider の再試行と timeout の文書を足す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。直し方はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  穴探し20巡目（BJ: provider の時間切れと再試行、BK: `examples/chat` を最後まで動かす、BL: 入力が SQL・正規表現に届く所）で、
  実物の SDK（`openai` 7.10.0・`@anthropic-ai/sdk` 0.124.0・`anthropic-sdk-latest` = 0.129.0）を localhost の擬似 HTTP サーバに向け、実 Postgres 17 と擬似 provider で測った。
  BL（SQL 注入・ReDoS）は指摘なしだった。以下を直す。[ADR 0428](./0428-provider-abort-reason-and-error-guards.md) が揃えた abort の reject の値・再試行待ちの中断・
  [ADR 0359](./0359-abort-signal-for-provider-calls.md) の範囲は、陽性対照にだけ使い、触っていない。

  1. **BJ-2: `LocalEmbeddingProvider.embed` は、件数が `maxBatchSize`（既定128）を超えて分割されたとき、チャンクの合間で abort を見なかった。**
     300件・チャンクごとに40ms・abort は60msで、abort の後も残りのチャンクを推論し、全チャンクが終わった122msで reject した（`pipeline.embed` は3回呼ばれた）。
     `#embedInChunks`（`local-embedding-provider.ts`）のループに `signal` の確認が無く、確認は読み込みの後と推論の後（全チャンクが終わった後）だけだった。
     チャンク分割（ADR 0358）が入るまでは1回の推論＝1回の `pipeline.embed` だったので問題にならず、分割が入ったときに abort との組み合わせが考えられていなかった。
  2. **BK-1: `examples/chat` の `chat` は、全 embed が失敗しても「embed を処理した」と表示し、exit 0 で終わった。**
     `ingestConversation`（`mnemora-path.ts`）が `drainEmbedTicks` の結果を捨て、`cli.ts` の `chat` は固定文を出していた。
     接続拒否の `OPENAI_BASE_URL` で9件とも `failed` になった run でも、`9 件の user 発話を observe() し、tick() で embed を処理した。` と出て exit 0 だった。
     usage-meter は成功して応答が返った呼び出しだけを数える（`usage-meter.ts`）ので、同じ run が「呼び出し 0 回・費用 $0」と読めた。
     同じ形の警告は `correction-candidates` の側に既に在る（`cli.ts` の `report.ingestDrain.totalFailed > 0`。🔴 を標準エラーへ出し `process.exitCode = 1`）。
  3. **BJ-1, 3, 4, 5, 6 と ES2022: 文書に無かった・古かった。**
     - **BJ-1**: `@mnemora/anthropic` は `maxTokens` が約21,333を超えると、SDK が「非ストリーミングでは10分を超えうる」と判断し、**リクエストを1本も送らずに**
       `AnthropicError: Streaming is required for operations that may take longer than 10 minutes` で落ちる（`kind` は付かない）。
       実測（`@anthropic-ai/sdk@0.124.0`、`client` を省略）: 16000・21000は通り、22000・32000・64000は落ちた。`client` に `timeout: 1_200_000` を明示すると、22000・32000・64000とも送信された。
       README は `truncated` のとき「`maxTokens` を上げる」と案内していて、上げた先の失敗に触れていなかった。
     - **BJ-3**: SDK の `timeout` は試行ごとに効く。応答しないサーバーへ `timeout: 300, maxRetries: 2` で当てると、3回試行して約2.2秒かかった（3経路とも、anthropic は0.129.0でも同じ）。
       README は「`timeout: 600000`」としか書かず、合計の最悪値（既定なら30分超）が読み取れなかった。
     - **BJ-4**: 429・5xx・応答を受け取る前の接続の失敗は SDK の再送で治る（429→200・500→200で、embed のベクトルは1行・outbox の attempts は1・memory は `ready`）。
       200 のヘッダの後に本文が途中で切れると、SDK は再送せず素の `TypeError: terminated` になり、embed のジョブは `failed` で終わった。この線引きは文書に無かった。
     - **BJ-5**: SDK の再送に冪等キーは付かない（`x-stainless-retry-count` が 0→1 に変わるだけ）。429の後の再送でサーバーは2回受けた（mnemora が書いたのは1回）。
     - **BJ-6**: core の `embedding-provider.ts`・`llm-provider.ts` の2026-09-29の追記は、「SDK 呼び出しへ `{ signal }` を渡す」「local-embedding は推論の前後で確かめるだけ」とだけ書き、
       ADR 0428（`runAbortable` で包む・読み込み待ちも切る）を反映していなかった。
     - **ES2022**: `@mnemora/local-embedding` の公開 `.d.ts` は `LocalEmbeddingProviderError` のコンストラクタで `ErrorOptions`（ES2022 の lib）を使う（`errors.ts`）。
       ADR 0441 は core・postgres・ルートの README にだけ書き、local-embedding は「指示された3つの README だけに足した」として残していた。

- **決めたこと**:

  1. **BJ-2: `#embedInChunks` のループの頭で `signal?.throwIfAborted()` を呼ぶ。**`embed` が `opts?.signal` を渡す。動いている1回の `pipeline.embed` は止められない
     （ADR 0359・0428 のまま）が、abort 済みなら次のチャンクは始めず、`signal.reason` で reject する。件数が `maxBatchSize` 以下で1回に渡す経路は、1バイトも変えていない。
     TSDoc（`embed`）と README に1文足した。
  2. **BK-1: `ingestConversation` が `DrainResult` を返し、`chat` が `totalFailed > 0` なら警告を出す。**
     **exit code は `correction-candidates` の側に揃えた**: 🔴 の1行を標準エラーへ出し、`process.exitCode = 1` にする（文面は同じ形: `embed に失敗した件がある(N件)。⛔ …`）。
     違うのは、`correction-candidates` は数字が使えないので `return` で打ち切るのに対し、`chat` は実演なので**打ち切らず**、以降の recall の表示
     （`omitted` の `not_indexed`・`embedding_provider_unavailable`）をそのまま出す点だけである。固定文は「成功 N 件 / 失敗 M 件」を添えた形に直した。
     usage-meter の `formatReport()` の見出しの下に「成功して応答が返った呼び出しだけを数える。失敗した呼び出し——SDK の再送を含む——は数えない」の1行を足した（数え方は変えていない）。
     他の呼び出し側（`answer-bench`・`recall-footprint-calibration-samples`・`runMnemoraPath`）は戻り値を使わないので変わらない。
     注: 依頼文は「`compare` の `cli.ts:2580` 付近」と書いたが、その行は `correction-candidates` の側だった（`compare` には `totalFailed` の検査が無い）。揃えた先は `correction-candidates`。
  3. **文書（挙動は変えない）**: anthropic README の `truncated` の行と直後に、上の BJ-1 の2点（約21,333より上げると streaming を求められて素の例外になる・`client` に `timeout` を明示すれば通る）を足した。
     `kind` や構築時の検査は足していない。openai・anthropic の README の `client` の節に、BJ-3（最悪の合計は `timeout × (maxRetries + 1)` + 再送の待ち）・BJ-4（再送で治る失敗と治らない失敗。
     provider 側で再送する形にはしない）・BJ-5（冪等キーは付かない）を足した。core の2つの TSDoc に、ADR 0428 の内容を1段落ずつ足した。
     local-embedding の README の「前提」に ES2022 の一文を足した（core の README の該当行と同じ形。根拠は `LocalEmbeddingProviderError` のコンストラクタの `ErrorOptions`）。
  4. **BK-2 は見送り。**`runtime.tick(ctx)` を JS から `opts` 省略で呼ぶと素の `TypeError`、`{}` だと `leaseMs` 欠落で `DrizzleQueryError` になる件。型では弾かれ、README の例は正しく、JS 利用者限定の極小の穴なので直さない。

- **検討した代替案**:

  1. **BJ-2: チャンクの途中（`pipeline.embed` の中）でも止める。** 採らなかった。`/transformers` の呼び出し自体を中断する口が無い（ADR 0359 決定・0428）。
  2. **BK-1: `chat` でも `correction-candidates` と同じく `return` で打ち切る。** 採らなかった。`chat` の目的は recall の表示（`omitted` が失敗の理由を言う）を見せることで、打ち切ると理由が読めなくなる。
  3. **BK-1: usage-meter に失敗した呼び出しも数えさせる。** 採らなかった。SDK の再送を mnemora の層から数える手段が無く（SDK の内部）、`meteredChatCreate` は `create()` 1回＝1呼び出しとして数える設計である。表示の注記だけにした。
  4. **BJ-1: provider が `maxTokens` を検査する・`kind` を足す。** 採らなかった。境目は SDK の仕様（SDK の版で変わりうる）であり、公開 API の追加（`kind`）はオーナー・クローンの領分。文書に留めた。
  5. **BJ-4: provider 側で本文が切れたときに再送する。** 採らなかった。Phase 1 に自動リトライを持たない方針（ADR 0032・0157）と衝突し、冪等キーが無い（BJ-5）ので二重課金を増やす。復旧は `reembed`（文書どおり）。

- **引き受けた負債**:

  - チャンクの中の推論は abort で止まらない（ADR 0359・0428 のまま）。1チャンクは最大 `maxBatchSize` 件ぶんの推論時間、abort が効かない。
  - 約21,333という境目は、`@anthropic-ai/sdk@0.124.0` での実測である（21000は通り22000は落ちた）。0.129.0 では測っていない。SDK の計算式は `max_tokens` に比例するので同じ形のはずだが、未確認。
  - BJ-3 の合計時間の式は `timeout × (maxRetries + 1)` に再送の待ちを足したものとして書いた。`retry-after` が長いときの待ちの上限（SDK は60秒を超える `retry-after` を使わない）は測っていない。
  - `chat` の `process.exitCode = 1` は、`totalFailed > 0` のときだけである。`embed` が成功しても `recall` 側が別の理由で落ちる場合は今までどおり（例外）。
  - BL（SQL・正規表現）で SQL 側の ReDoS の陽性対照は取れなかった（Postgres の正規表現は `^(a+)\1+$` でも遅くならなかった）。入力長に対する線形性で代えた。

- **これが覆るとしたら**:

  `createPipeline` に中断の口が足されるなら、チャンクの中の推論も止められる（ADR 0428 の「これが覆るとしたら」と同じ）。
  usage-meter が SDK の再送を数えられるようになる（SDK がフックを公開する）なら、失敗した呼び出しも表示してよい。

- **測ったこと**:

  - **歯（BJ-2）は直す前に赤を見た。**`packages/local-embedding/src/__tests__/abort-chunk-loop.test.ts`（`maxBatchSize: 2`・6件・1チャンク目の推論の最中に abort）。
    直す前: `expect(calls).toEqual([["a","b"]])` が落ち、`["c","d"]`・`["e","f"]` も呼ばれていた（1 failed | 1 passed。陽性対照の「abort しなければ全チャンクを推論して全ベクトルを返す」は緑）。
    直した後: 2本とも緑。既存の `abort-signal.test.ts`・`abort-load-wait.test.ts` と合わせて 13本緑。
  - BK-1 は、宛先を確かめてから走らせた。`OPENAI_BASE_URL=http://127.0.0.1:9/v1`（接続拒否。`new OpenAI({apiKey}).baseURL` が `http://127.0.0.1:9/v1` に解決されることを先に出力で確認）で `chat`:
    直す前は exit 0・「embed を処理した」。直した後は exit 1・標準エラーに 🔴、標準出力に「成功 0 件 / 失敗 9 件」。擬似 provider で鍵なし（`env -u OPENAI_API_KEY`）の `chat` は exit 0・「成功 9 件 / 失敗 0 件」・🔴 なし。
  - 実 API には出していない（擬似サーバーか接続拒否の宛先だけ。ダミー鍵のみ）。
  - **測っていないこと**: 実 API での再送・本文の途中切断。anthropic 0.129.0 での約21,333の境目。
