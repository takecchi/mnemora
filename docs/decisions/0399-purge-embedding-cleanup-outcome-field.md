# ADR 0399: `Runtime.purge` の埋め込み削除の失敗を、outcome の任意欄 `embeddingCleanup` で知らせる

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30
- **PR**: [#1475](https://github.com/takecchi/mnemora/pull/1475)

> **⚠ 本文はクローン miku の委譲先が書いた。オーナー本人の執筆ではない。**

## 文脈

[ADR 0382](./0382-vector-store-delete-across-spaces.md)「引き受けた負債」1: `Runtime.purge` は
`deps.vectorStore.deleteAcrossSpaces` の失敗を `catch {}` で握り潰しており、呼び出し側は
埋め込み行が残ったことを**知る手段が無かった**。握り潰している箇所は2つある——
`"purged"` を返した後と、`"already_purged"` の再試行（ADR 0382 決定3）である。
どちらも `MemoryStore` 側の書き込みは（前者は今回、後者は以前に）確定しており、
`kind` を変える理由は無い。

## 決定

1. `PurgeOutcome` の `"purged"` と `"already_purged"` に、任意の欄
   `embeddingCleanup?: { status: "failed"; error: string }`（型名 `PurgeEmbeddingCleanup`）を足す。
2. **失敗したときだけ付ける。成功したとき（および `dryRun`）はプロパティ自体が無い**
   （`undefined` を入れることもしない）。成功時の出力は変更前と同一で、
   `Object.keys` と `JSON.stringify` の一致を歯で固定した。
3. `kind` は変えない。`"purged"` は「`MemoryStore` の書き込みが確定した」、`"already_purged"` は
   「今回は書いていない」という意味のまま。
4. `"already_purged"` の再試行にも同じ欄を付ける。負債1が名指しした「再実行のたびの再試行の機会」の
   失敗が、そこでも握り潰されていたため。片方だけ直すと、再実行して失敗した運用側が
   同じ沈黙に戻る。
5. `error` は `error instanceof Error ? error.message : String(error)`。
6. **欄名は `reason` でなく `error`**。同じ `PurgeOutcome` の `"failed"` が `error: string` で
   失敗を表しており、表し方を揃える。`reason` は `purge` の opts で「purge を実行した理由」
   （監査ログの meta に載る）を指す語で、別の意味と衝突する。
7. `status` は判別子。将来 `"skipped"` 等の値や詳細欄を足しても、既存の読み手は
   `status === "failed"` だけ見ていれば壊れない。

## 採らなかった案

- **1値の文字列（`embeddingCleanup?: "failed"`）**: 失敗理由を載せる先が無く、将来の値を足すと
  型が広がって既存の読み手の網羅性を崩す。
- **`memory_events` の meta に残す**: `purged` イベントは `purgeMemory` の中で、埋め込み削除**より前**に
  書かれる。失敗を残すには別イベントの追加か、書いたイベントの後書き換えが要る。前者は
  イベント種別の追加（型・DB・適合テストに波及）、後者は追記専用の監査ログの性質に反する。
  また `already_purged` では書き込みを起こさない約束（ADR 0382）と両立しない。
- **`kind` を格下げする（`"failed"` 等）**: `"failed"` は「安全に再試行できる（書き込みが起きていない）」を
  意味する（ADR 0124 決定5）。書き込みが確定した後にこれを返すと、その意味を裏切る。
- **例外として投げる**: 先に確定した要素の outcome が呼び出し側から見えなくなる（`purge` は例外を外へ投げない）。

## testkit に足さなかった理由

適合テスト（testkit）は adapter の契約を検査する。この欄を出すのは `Runtime.purge`（core）であり、
adapter は `deleteAcrossSpaces` が投げるか投げないかを決めるだけ。挙動の歯は core のフェイクを使う
`packages/core/src/__tests__/purge.test.ts` に置いた。

## 引き受けた負債

1. 欄は**知らせるだけ**で、自動リトライはしない。呼び出し側が `already_purged` の再実行などで
   自分で再試行する必要がある（ADR 0382 の負債1の「再試行の仕組み」自体は残る）。
2. `error` は例外メッセージの文字列で、接続情報等が含まれうる。呼び出し側がログ等へ流すときは
   `"failed"` outcome の `error` と同じ注意が要る。
3. 公開型への追加（任意欄）。網羅的に `PurgeOutcome` を構築する第三者コードは無い前提（outcome は読み手向け）。

## これが覆るとしたら

- 失敗の種類（一時的／恒久的）を呼び出し側が区別したいという要望が出たとき——`status` に値を足すか
  詳細欄を足す。
- 再試行を runtime が持つべきと判断されたとき——ADR 0382 の「これが覆るとしたら」1の保守操作の話になる。

---

## 2026-09-30 追記: 握り潰している箇所は3つだった（訂正）

本文は書き換えない。「文脈」は握り潰している箇所を**2つ**と数えた（`"purged"` の後と、
`"already_purged"` の再試行）。**3つ目があった**——`purgeMemory` が `MemoryPurgeConflictError` を投げた後、
再読して `already_purged` になる枝の `deleteAcrossSpaces` が `catch {}` のまま残っていた。
この追記の PR で、他の2箇所と同じ扱いにした: 失敗したら、`kind` は `"already_purged"` のまま
`embeddingCleanup: { status: "failed", error }` を付ける（成功時は欄が無い）。

- 決定5（`error` は `error instanceof Error ? error.message : String(error)`）は、同日、
  [ADR 0363](./0363-outbox-last-error-omit-params-and-cap-length.md) の追記により outbox の `last_error` と
  同じ整形に変わった（params を落とし、cause と SQLSTATE を足し、4096字で切る）。
  「引き受けた負債」2の「接続情報等が含まれうる」は、SQL に付けた値については当てはまらなくなった
  （pg の理由文に値が載る経路は ADR 0363「塞がらない経路」のまま）。
- 歯: `packages/core/src/__tests__/outcome-error-format.test.ts`。
