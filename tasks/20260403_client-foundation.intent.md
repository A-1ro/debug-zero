# #14 クライアント基盤の実装

> 作成日: 2026-04-03

## 実装意図

`src/client/` を新設し、React + クライアントサイドルーティングによる画面基盤を実装する。`useWebSocket` でサーバとの WebSocket 通信を管理し、`useGameState` で受信した状態をそのまま保持する。`src/index.tsx` はクライアントエントリに整理する。

## 合意した前提

- [YES] `react` / `react-dom` / `@types/react` / `@types/react-dom` はまだ未インストール。このタスクで `npm install` する
- [YES] クライアントルーター (`react-router-dom` 等) も未インストール。このタスクで追加する
- [YES] `vite.config.ts` の `@cloudflare/vite-plugin` + `vite-ssr-components` 構成はそのまま使用する
- [YES] `src/index.tsx` を React クライアントエントリ（`ReactDOM.createRoot` 起点）として書き直す
- [YES] 実装ファイル: `src/client/hooks/useWebSocket.ts`、`src/client/hooks/useGameState.ts`、ルーティング設定
- [YES] 各ルート（`/`, `/room/:id`, `/room/:id/game`, `/room/:id/result`）は空の placeholder コンポーネントを返すだけでよい
- [YES] `playerId` はブラウザ初回ロード時に `crypto.randomUUID()` で生成し `localStorage` に保存する
- [YES] `playerName` は `useWebSocket` の呼び出し時に引数として渡す
- [YES] WebSocket 接続先は `/room/{roomId}/ws`
- [YES] `client:join_room` は WebSocket open 直後に送信する
- [YES] 切断後の再接続は指数バックオフ（初回 1s、最大 30s）で自動リトライする
- [YES] `messageId` は送信ごとに `crypto.randomUUID()` で生成する
- [YES] `useGameState` はサーバ受信の `Room`, `Session`, `GameView` を `useState` でそのまま保持する
- [YES] `server:state_sync` 受信時はすべての状態を上書きする
- [YES] 認証・認可機能は実装しない
- [YES] E2E テストは #20 で行う

## 非対応事項

- 認証・認可
- 各 View の実コンポーネント実装（#15〜#18）
- E2E テスト（#20）

## リスクメモ

- `vite-ssr-components` と React 共存: `jsxImportSource` を `hono/jsx` → `react` に変更が必要。`renderer.tsx` が壊れる可能性あり
- SPA fallback: `react-router-dom` の BrowserRouter には Cloudflare Workers 側の fallback 設定が必要
