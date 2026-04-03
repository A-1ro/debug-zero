# #17 GameBoard コンポーネント群の実装

> 作成日: 2026-04-03

## 実装意図

`/room/:roomId/game` ルートに SessionView を実装し、GameBoard とその子コンポーネント群（PlayerList, FieldDisplay, HandDisplay, ActionPanel, BugDisplay, EventLogPanel）を構築する。WebSocket は SessionView が保持し、state を GameBoard へ props で渡す。フェーズ（normal / showdown / raid）に応じて操作 UI を切り替え、`server:session_ended` 受信時に `/room/:roomId/result` へ遷移する。

## 合意した前提

- [YES] SessionView が useWebSocket + useGameState を保持し、state.game / state.session / state.room を GameBoard に渡す
- [YES] server:session_ended 受信時に navigate("/room/:roomId/result") する
- [YES] CardId は "{value}-{serial}" 形式。cardValue は parseInt(cardId.split("-")[0]) で取得
- [YES] コンポーネント構成: SessionView > GameBoard > PlayerList / FieldDisplay / HandDisplay / ActionPanel / BugDisplay / EventLogPanel。PhaseDisplay / SetNumberDisplay / TurnIndicator は GameBoard のヘッダー内にインライン実装
- [YES] ChatArea はプレースホルダーのみ実装する
- [YES] CSS は GameBoard.module.css + 各コンポーネントの .module.css（global.css の変数を使う）
- [YES] normal フェーズ: 手札からカード選択 → 演算子選択 → PLAY ボタン。手番外は DRAW ボタンのみ
- [YES] ResetOrRaid UI: action_result で cardValue === 0 のカードが出たとき resetOrRaidPending を true にし、RESET / RAID 選択ボタンを表示する
- [YES] showdown フェーズ: カード選択 + PLAY ボタン（演算子選択なし）
- [YES] raid フェーズ: ターゲット選択（boss / 他プレイヤー）付きのカード選択 + PLAY ボタン
- [YES] 観戦者（role === "spectator"）は HandDisplay と ActionPanel を非表示にする
- [YES] BugDisplay のバグ除去ボタンは costCardIds UI を実装せず、即座に { type: "remove_bug", bugId } を送信する
- [YES] EventLogPanel はイベントの type と actorId のみ表示（簡易テキスト）
- [YES] モバイルレスポンシブ対応はしない
- [YES] isRoomNavigateState 型ガードを navigation.ts に移動し、SessionView と RoomView の両方からインポートする

## 非対応事項

- チャット機能（ChatArea はプレースホルダー）
- モバイルレスポンシブ
- BugRemove の costCardIds 選択 UI
- 演算子選択のアニメーション詳細

## リスクメモ

- server:action_result ではフィールド全体の更新が来ないため、カード追加は fieldCard をローカルで state に追記するか、state.game.field を参照する（useGameState の reducer が field を更新していない点に注意。別途 action_result で fieldCard を受け取り game.field に push する必要がある）
- ResetOrRaid の resetOrRaidPending は useEffect で server:action_result + cardValue === 0 を監視して立てる。client:reset_or_raid 送信後にフラグを落とす
- raid フェーズのターゲットは raidState.turnOrder の現ターンが boss の場合はプレイヤーが攻撃対象、プレイヤーターンの場合は boss を攻撃対象にする
