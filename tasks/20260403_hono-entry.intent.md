# #13 Hono サーバエントリポイント実装

> 作成日: 2026-04-03

## 実装意図

`src/server/index.ts` に Hono ルーティングと `RoomDurableObject` クラスを実装し、Cloudflare Workers エントリポイントを完成させる。現在の `src/index.tsx` をサーバ・クライアントエントリに分離する。ハンドラ内のビジネスロジック（RoomService / SessionService / GameEngine 連携）も含めてフル実装する。

## 合意した前提

- [YES] サーバエントリは `src/server/index.ts`（新規）、`src/index.tsx` はクライアントのみに整理
- [YES] `wrangler.jsonc` に `durable_objects` と `migrations` セクションを追加する
- [YES] `RoomDurableObject`（fetch / webSocketMessage / webSocketClose）をこの #13 で実装
- [YES] ハンドラ登録は `RoomDurableObject` のコンストラクタで行う
- [YES] ビジネスロジック（RoomService / SessionService / GameEngine 呼び出し）も今回実装
- [YES] 起動時に `RuleSetLoader` → `RuleSetRegistry` 登録を行う
- [YES] `wrangler.jsonc` の `main` を `src/server/index.ts` に変更する

## 非対応事項

- クライアント側実装（#14 以降）
- テスト（#19/#20）

## リスクメモ

- `client:action` ハンドラが最大スコープ（GameEngine → SessionService → Broadcaster 連携）
- vite-ssr-components の `main` 変更がクライアントビルドに影響しないか確認が必要
