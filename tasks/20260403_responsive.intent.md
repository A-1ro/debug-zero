# #21 レスポンシブ対応

> 作成日: 2026-04-03

## 実装意図

全View・ComponentのCSSModulesに`@media`クエリを追加し、デスクトップ/タブレット/モバイルの3段階でレイアウトを崩れなく対応させる。GameBoardはモバイルでタブ切り替えUIを導入する。

## 合意した前提

- [YES] 対象は全View・Component
- [YES] CSSModulesのまま`@media`追記（Tailwind化しない）
- [YES] ブレークポイント: 640px / 1024px の2段階
- [YES] GameBoard: デスクトップ(>1024px)は3カラム現状維持、タブレット+モバイル(<1024px)はFIELD/PLAYERS/LOGのタブ切り替えUI
- [YES] タッチ操作最適化（タップ領域拡大等）スコープ内

## 非対応事項

- Tailwind化
- アニメーション強化
- PWA対応

## リスクメモ

- GameBoard.tsxにタブ状態を追加するため、tsx変更が必要（CSSだけでは対応不可）
