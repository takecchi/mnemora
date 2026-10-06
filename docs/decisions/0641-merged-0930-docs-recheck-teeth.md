# ADR 0641: 09/30 にマージされた文書の PR（H 群：#1494・#1503・#1536）の確かめ直しで見つかった「約束の内」の穴7本に歯を足す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1734](https://github.com/takecchi/mnemora/issues/1734) の #1494・#1503・#1536 のコメント（担当 mgr-b4cde0e3、作業者P・Q の確かめ直しの結果を写したもの）。そこで見つかったすり抜けのうち、**約束の内**の7本をこの PR で塞ぐ。
出所の区別: 【現物】は読んだコード・文面、【実測】は手元で走らせた結果、【判断】はマネージャーの判定。
これは試験だけの変更で、実装・文書の本文・migration・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0621](./0621-merged-0930-1465-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯

文書の PR は、今の振る舞いや運用の「結論」を文で書く。既存の歯は語の存在・表・判定の関数は見るが、結論の向きや数値までは見ておらず、結論を事実と逆にしても緑のままだった【現物】。

## 決定【判断】

1. 実装・文書の本文は変えない。
2. 歯を足す。文書の文面を縛る歯は、文面の全体ではなく約束の核の語句だけを見る（`toContain` / 否定の正規表現）。言い換えでは落ちず、元の規範や逆の結論に戻すと落ちる。各歯は、今の main で緑、穴の変異で赤、`cp` で戻して `cmp` で一致させた後に緑、を実測した。やりすぎ側（言い換えだけ・正しい変更）でも赤にならないことを1つずつ確かめた【実測】。

| 出所 | 穴の変異 | 足した歯 | 置き場 |
| --- | --- | --- | --- |
| #1494 | `DEFAULT_TICK_LIMIT` を 50 から 1 にする | `TickOptions.leaseMs` の TSDoc の「既定 N」を、`runtime.ts` の `DEFAULT_TICK_LIMIT` の値と突き合わせる | `packages/core/src/__tests__/tick-batch-lease-expiry.test.ts` |
| #1494 | TSDoc 見出しの「切れうる」を「前でも切れない」にする（事実と逆） | TSDoc に「切れうる」が在る | 同上 |
| #1494 | `processEmbedJob` の注釈の結論「`failed` を書いて投げ直す」を「黙って `ready` のまま続ける」にする（事実と逆） | 注釈の追記の側の結論の一句（手前の別の注釈にも同じ語句があるので、「区別しない——」まで含める） | `packages/core/src/__tests__/embed-job-ready-write-fails.test.ts` |
| #1503 | `docs/decisions/README.md` の「一覧」節冒頭を元の規範（作成者は触らない・マージする側が直前に再生成する）に戻す | 3か所に、元の規範を規範として書いた句が無い・「PR の側で」と 2026-09-30 の追記への指し示しが在る・ADR 0137・0192 の追記が在る | `scripts/__tests__/adr-index-operation-wording.test.mjs`（新規） |
| #1503 | `docs/autonomy.md` §4.0 を元の規範（PR の作成者は、この赤を自分で直さないこと）に戻す | 同上（§4.0 の範囲で見る） | 同上 |
| #1536 | `examples/chat` の `verify` の鍵のガードを常に発火させる | ダミーの鍵を渡して起動し、案内で止まらず照合に進む（カセットを読んだ旨が stdout に出る）ことを `CASSETTE_TARGETS` の全 target で見る。接続先は fetch が接続を試みる前に断る `OPENAI_BASE_URL=http://127.0.0.1:9`（bad port）に向けるので、実 API には出ない | `examples/chat/src/__tests__/cli-verify-no-key.test.ts` |
| #1536 | ガードを `retrieval`・`compare` だけに限る（`answer`・`answer-time-weighting` を外す） | 鍵が無いときの `it.each` を `CASSETTE_TARGETS` から作る（target が増えても追従する） | 同上 |

## 外したもの【判断】

- #1503 の文書の食い違い（`autonomy.md` §4 の表の `adr-renumber` の「マージする側が」と、索引の行の「PR の側で」の併存、ADR 0228 などの前提）は、本文の直しが要るので、この PR では触らない。
- #1536 の約束の外（空文字の鍵を「無い」とみなすか）と同値（ガードを `loadCassette` の後ろへ移す）の変異は、縛らない。
