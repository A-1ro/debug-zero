# #11 SessionService 実装

> 作成日: 2026-04-03

## 実装意図

`startSession`（デッキ生成・手番決定・初期配布）・`startNextGame`（次ゲーム初期化・バグ引き継ぎ）・`recordWin`（勝利数集計・セッション勝者判定）・`endSession`（全員の戦略公開）を実装する。GameEngine のゲーム終了後に呼ばれる上位レイヤー。

## 合意した前提

- [YES] `startSession` は `client:start_game`（ホスト）受信で発火する
- [YES] ゲーム初期化手順は detail-design.md 5.2 通り: 手番決定→デッキシャッフル→手札配布→セット数算出→残留バグ適用→Zero判定
- [YES] 手番決定は「全員が1枚引いて最大値のプレイヤーが先攻、時計回り」
- [YES] バグ残留の引き継ぎ先は「同セッション内の次ゲーム」（セッション跨ぎなし）
- [YES] セッション勝利条件は `winCondition.winsRequired`（basic: 3勝）
- [YES] `endSession` は `checkSessionWin()` で勝者確定したタイミングで自動発火
- [YES] Cloudflare Durable Objects を使用してセッション状態を永続化する

## 非対応事項

- WebSocket ブロードキャスト（#12 Broadcaster で実装）
- Hono エントリポイントへの組み込み（#13 で実装）

## リスクメモ

- 手番決定の「1枚引く」処理でデッキから一時的にカードを抜く実装が必要（引いたカードは戻すか除外するか detail-design.md 要確認）
- Durable Objects の設計は detail-design.md 第9章を参照すること
