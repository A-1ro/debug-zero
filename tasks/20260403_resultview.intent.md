# #18 ResultView の実装

> 作成日: 2026-04-03

## 実装意図

`/room/:roomId/result` ルートに ResultView を実装する。デザインは `04-result.html` に準拠し、勝者名グロウアニメーション・6カラムスコアボード（全員の戦略公開）・summary strip・REMATCH / DISBAND ボタンを CSS Modules で実装する。

## 合意した前提

- [YES] ResultView は useWebSocket を持たない。セッションデータは SessionView の navigate state 経由で受け取る
- [YES] SessionView の navigate 呼び出しを変更し state: { ...location.state, session: state.session, room: state.room } を渡す
- [YES] navigate state が null の場合はフォールバック画面「SESSION ENDED — RETURN TO TOP」を表示して / に誘導する
- [YES] スコアボードは session.players を wins の降順でソートして表示する
- [YES] Pips の最大数は 3 個にハードコードする（3 wins でセッション勝利を前提）
- [YES] 戦略は session.players[].strategyId をそのまま --amber カラーで表示する（セッション終了 = 公開済み）
- [YES] REMATCH ボタン: navigate("/room/:roomId", { state: { playerName, role } }) → RoomView ロビーに戻る
- [YES] DISBAND ボタン: navigate("/") → TopView に戻る
- [YES] session.winnerId が null のとき: 「NO WINNER」と表示する
- [YES] CSS Modules（ResultView.module.css）で実装。winnerPulse と nameGlow の @keyframes は ResultView.module.css に定義する
- [YES] モバイルレスポンシブ対応はしない
- [YES] REMATCH は画面遷移のみ（サーバーリクエストなし）

## 非対応事項

- モバイルレスポンシブ
- REMATCH 後のサーバーへの新セッション開始リクエスト

## リスクメモ

- navigation.ts の型定義を拡張して ResultNavigateState を追加する（session + room を含む）
