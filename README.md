# DEBUG-ZERO

> 数式でセット数を操るリアルタイム対戦カードゲーム

[![CI](https://github.com/A-1ro/debug-zero/actions/workflows/test.yml/badge.svg)](https://github.com/A-1ro/debug-zero/actions/workflows/test.yml)

---

## ゲーム概要

DEBUG-ZERO は 2〜4 人のプレイヤーがリアルタイムで対戦するカードゲームです。
プレイヤーは手札のカードを **加算 / 減算 / 乗算 / 除算** で場に出し、「**セット数**」を操作します。
セット数をちょうど **0** にしたプレイヤーが1ゲームを獲得し、**3ゲーム先取** でセッション勝利となります。

### フェーズ

| フェーズ | 説明 |
|---------|------|
| **Normal** | 通常プレイ。カードを出して演算するか、山札からドロー |
| **Showdown** | 山札切れで突入。手持ちのベストカードを1枚出して勝負 |
| **Raid** | セット数0のカードを出し「Raid」を選択すると突入。ランダムに選ばれたボスプレイヤーを全員で討伐 |

### 0カードの特殊ルール

セット数を0にするカードを出したプレイヤーは次の2択を迫られます：

- **↺ RESET** — フィールドをリセットし、新しいセットを開始（セット数も再計算）
- **⚔ RAID** — Raid フェーズに突入

### 乗算・除算の条件（ArithmeticJudge）

×・÷ が使えるのは、**出そうとしているカードの値 = 直前のフィールドカードの raw 値** の場合のみ。

---

## ストラテジー

ゲーム開始前に各プレイヤーは1つのストラテジーを選択します。

| ストラテジー | 効果 | 制限 |
|------------|------|------|
| **Aggro** | 自分がカードを出すとき effectiveValue を2倍にする | なし |
| **Control-Add** | 他プレイヤーが `-` で出したカードを `+` に変える | 1ゲーム1回 |
| **Control-Sub** | 他プレイヤーが `+` で出したカードを `-` に変える | 1ゲーム1回 |
| **Control-Mul** | 他プレイヤーが `÷` で出したカードを `×` に変える | 1ゲーム1回 |
| **Control-Div** | 他プレイヤーが `×` で出したカードを `÷` に変える | 1ゲーム1回 |
| **Hack** | 他プレイヤーが出した **偶数** カードを奪う | 1ゲーム1回 |
| **TrickStar** | 他プレイヤーが出した **奇数** カードをフィールドから除去 | 1ゲーム1回 |
| **Zero** | ゲーム開始時に手札に 0 カードを1枚追加（2人以上が選ぶと無効） | — |

---

## バグ（障害カード）

Raid フェーズ中にランダムでバグが発生し、全プレイヤーに影響します。
コストを支払うことで除去できます。

| バグ | 効果 | 除去コスト |
|-----|------|-----------|
| Odd-Forbidden | 奇数カードを出せない | 偶数カードを1枚捨てる |
| Even-Forbidden | 偶数カードを出せない | 奇数カードを1枚捨てる |
| Stack-Forbidden | カードを積めない（山積み禁止） | HP -3 |
| Aggro-Forbidden | Aggro 戦略を無効化 | HP -3 |
| Control-Forbidden | Control-Add 戦略を無効化 | HP -3 |
| Hack-Forbidden | Hack 戦略を無効化 | HP -3 |
| TrickStar-Forbidden | TrickStar 戦略を無効化 | HP -3 |
| Value-Corruption | すべてのカード値を 10 に上書き | HP -1 + 手札1枚捨てる |

---

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| サーバー | [Cloudflare Workers](https://workers.cloudflare.com/) + [Durable Objects](https://developers.cloudflare.com/durable-objects/) |
| HTTP ルーティング | [Hono](https://hono.dev/) v4 |
| リアルタイム通信 | WebSocket（Hibernatable WebSockets API） |
| フロントエンド | React + [Vite](https://vitejs.dev/) |
| 言語 | TypeScript |
| テスト | [Vitest](https://vitest.dev/) |
| CI | GitHub Actions |

ルームごとに1つの Durable Object が起動し、WebSocket 接続・ゲーム状態・ブロードキャストを管理します。
DO のハイバネーション（メモリ退避）にも対応しており、接続は `serializeAttachment` でセッションをまたいで復元されます。

---

## Getting Started

### 前提条件

- Node.js 22+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)

### インストール

```bash
git clone https://github.com/A-1ro/debug-zero.git
cd debug-zero
npm install
```

### 開発サーバー起動

```bash
npm run dev
```

ブラウザで `http://localhost:5173` を開いてください。

### テスト

```bash
npm test           # 1回実行
npm run test:watch # ウォッチモード
```

### ビルド

```bash
npm run build
```

### デプロイ（Cloudflare Workers）

```bash
npm run deploy
```

---

## プロジェクト構成

```
debug-zero/
├── src/
│   ├── client/              # React フロントエンド
│   │   ├── components/      # UI コンポーネント
│   │   ├── hooks/           # useWebSocket, useGameState など
│   │   └── views/           # ページビュー
│   ├── server/              # Cloudflare Workers バックエンド
│   │   ├── room/            # RoomDurableObject（接続・ゲーム管理）
│   │   ├── game/            # ゲームエンジン（純粋関数）
│   │   │   ├── GameEngine.ts
│   │   │   ├── ArithmeticJudge.ts
│   │   │   └── ActionValidator.ts
│   │   ├── effects/         # ストラテジー・バグ効果ハンドラ
│   │   └── rules/           # ルールセット定義ローダー
│   └── shared/
│       └── types/           # ドメイン型・メッセージ型（サーバー・クライアント共通）
├── rules/
│   └── basic.yaml           # 基本ルールセット定義（カード・ストラテジー・バグ・フェーズ）
├── test/
│   ├── unit/                # 単体テスト
│   ├── integration/         # 統合テスト
│   └── scenario/            # シナリオテスト
└── public/
    └── favicon.svg
```

---

## License

MIT
