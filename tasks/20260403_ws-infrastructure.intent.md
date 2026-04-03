# #12 WebSocket基盤実装

> 作成日: 2026-04-03

## 実装意図

`ConnectionManager`（接続IDとプレイヤーIDのマッピング・再接続フロー）・`Broadcaster`（visibility設定に応じた送信先振り分け）・`MessageRouter`（受信メッセージのサービスへのルーティング・重複検知）と `EventLogger`・`LogQuery` を実装する。これらは `RoomDurableObject` の内部で使われるクラス群。

## 合意した前提

- [YES] 実装先は `src/server/ws/`（ConnectionManager / Broadcaster / MessageRouter）と `src/server/log/`（EventLogger / LogQuery）の5ファイル
- [YES] `RoomDurableObject` クラス自体は #13 で実装する——今回は内部クラス群のみ
- [YES] `ConnectionManager` はインメモリの `Map`（connections / playerConnections）を受け取って操作する
- [YES] `Broadcaster` は `WebSocket` オブジェクトに対して `JSON.stringify` → `ws.send()` する
- [YES] `MessageRouter` の重複検知は DO の `state.storage` から `seen_msgs` を読み書きする（TTL 60秒）
- [YES] `seen_msgs` のクリーニングはメッセージ受信のたびに行う
- [YES] `EventLogger` は `Game` を直接更新せず `appendEvents`（GamePatch互換）を返す

## 非対応事項

- `RoomDurableObject` クラス本体（#13 で実装）
- Hono エントリポイント・ルーティング（#13 で実装）
- クライアント側 WebSocket フック（#14 で実装）

## リスクメモ

- Cloudflare Workers の `WebSocket` 型は `@cloudflare/workers-types` 依存——型不一致が出たら型エイリアスで吸収する
- DO の `state.storage` を `MessageRouter` に渡す場合、インターフェース経由で注入する
