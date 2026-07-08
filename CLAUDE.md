# CLAUDE.md — DEBUG-ZERO

このファイルはClaude Code（およびClaudeを使った実装支援）向けの作業指針です。
実装を始める前に必ず全文を読んでください。

---

## プロジェクト概要

**DEBUG-ZERO** は、0〜9の数字カードと四則演算を使って目標値を0にするボードゲームをブラウザ上でリアルタイム対戦できるWebアプリです。

- ランタイム: **Cloudflare Workers**
- サーバフレームワーク: **Hono**
- フロントエンド: **React**
- 通信: **WebSocket**
- 将来の永続化: **Durable Objects**（現時点ではメモリ管理でも可）

設計ドキュメントは `docs/` 以下を参照:

- `docs/require.md` — 要件定義
- `docs/base-design.md` — 基本設計
- `docs/detail-design.md` — 詳細設計（型定義・メッセージ仕様・テスト戦略の正本）

実装タスク一覧は **`tasks.md`** を参照。タスクはフェーズ順に記載されており、各タスクの依存関係も明記されている。実装着手前に必ず確認すること。

---

## ディレクトリ構造

```
debug-zero/
├── rules/
│   └── basic.yaml
├── docs/
│   ├── require.md
│   ├── base-design.md
│   └── detail-design.md
└── src/
    ├── shared/
    │   ├── types/
    │   │   ├── domain.ts       # ドメイン型（Game, Session, Player 等）
    │   │   ├── messages.ts     # WebSocketメッセージ型
    │   │   ├── rules.ts        # ルール定義型
    │   │   └── effects.ts      # 効果定義型
    │   └── constants.ts        # エラーコード等
    ├── server/
    │   ├── index.ts
    │   ├── room/
    │   ├── session/
    │   ├── game/
    │   ├── rules/
    │   ├── effects/
    │   │   └── handlers/
    │   │       ├── strategies/
    │   │       └── bugs/
    │   ├── ws/
    │   └── log/
    ├── client/
    │   ├── main.tsx
    │   ├── hooks/
    │   ├── views/
    │   └── components/
    └── test/
        ├── unit/
        ├── integration/
        └── scenario/
```

命名規則:

- ファイル名: クラス・コンポーネントは **PascalCase**、フック・ユーティリティは **camelCase**
- 型名: **PascalCase** インターフェース
- 効果ハンドラファイル名: カード名をcamelCaseに変換（例: `Control-Add` → `controlAdd.ts`）

---

## アーキテクチャ原則

### 絶対に守ること

1. **サーバが唯一の正（Single Source of Truth）**
   - ゲームロジックはすべてサーバ側（`src/server/`）で完結させる
   - クライアントは表示と入力のみ。クライアント側の判定は補助表示に限る

2. **ルール定義とエンジンを分離する**
   - ゲームルールは `rules/*.yaml` に記述し、コードに埋め込まない
   - `if` 文の積み上げでカード効果を実装しない。効果IDでハンドラをディスパッチする

3. **ゲームロジックは純粋関数で実装する**
   - `applyAction(game, action): Game` は副作用なしの純粋関数
   - WebSocketや接続管理の副作用はロジックと混在させない

4. **visibility制御を必ず守る**
   - 手札（`game.hands`）は本人にのみ送信（`visibility: "player"`）
   - 他プレイヤーの手札は枚数のみ。戦略IDも本人にのみ公開

---

## 主要型定義の所在

型定義の正本は `detail-design.md` の第3章。実装時はそちらを参照してください。
ここには実装上の注意点のみ記載します。

### CardId の形式

```
"{value}-{serial}"  例: "3-007"（デッキ内で一意）
```

### GamePatch — applyAction の戻り値

効果ハンドラは `GamePatch` を返す。`GameEngine` が `GamePatch` を現在の `Game` にマージして新しい `Game` を生成する。
`appendEvents` フィールドは置換ではなく**追記**であることに注意。

### RaidState の bossHP

レイド戦開始時のボスHPは「0カードが出された時点の場のカード合計（**rawValue**）」。
`effectiveValue` ではなく `rawValue` を使う。

---

## 四則演算裁定ルール

`ArithmeticJudge` に実装する。純粋関数として実装すること。

```
加算・減算 : 常に可能
乗算・除算 : field[-1].rawValue === card.value の場合のみ可能
除算端数   : Math.ceil（常に切り上げ）
```

Aggro効果が有効な場合は `effectiveValue = rawValue * 2` で計算。
Aggroプレイヤーの手で結果がマイナスになった場合、そのプレイヤーは敗北して脱落し（setNumber巻き戻し・原因カード除外）、生存者2人以上ならゲームは続行する。生存者が1人になったらその1人が勝利（詳細は detail-design.md §8.4 Aggro）。

---

## フェーズ状態機械

```
[normal]
  ├─ 山札が尽きた                → [showdown]
  ├─ 0カードが出された（reset選択）→ [normal] リセット（0カード除外、セット数・手札リセット）
  └─ 0カードが出された（raid選択） → [raid]

[showdown]
  └─ 勝者確定                    → ゲーム終了

[raid]
  ├─ bossHP <= 0                 → ゲーム終了（勝者判定）
  └─ 全プレイヤーHP <= 0         → ボスがセッション勝利
```

フェーズ遷移条件は `PhaseDef.transitionConditions` に定義し、`PhaseController` に埋め込まない。

---

## 効果解決の実装方針

### EffectHandler の型

```typescript
type EffectHandler = (game: Game, ctx: EffectContext) => GamePatch;

interface EffectContext {
  actorId: string;
  triggerCard?: FieldCard;
  targetId?: string;
}
```

### ハンドラ実装場所

- 戦略カード: `src/server/effects/handlers/strategies/`
- バグカード: `src/server/effects/handlers/bugs/`
- 各ファイルは1ハンドラ1ファイル

### 新効果を追加するとき

1. `rules/*.yaml` に効果定義を追記
2. `handlers/strategies/` または `handlers/bugs/` にハンドラファイルを追加
3. `EffectRegistry` に登録
4. `src/server/effects/` 以外のコードは**変更不要**

---

## WebSocketメッセージ設計

### 命名規則

- クライアント要求: `client:*`（例: `client:action`）
- サーバ通知: `server:*`（例: `server:action_result`）

### メッセージ基本構造

```typescript
// クライアント → サーバ
interface ClientMessage {
  id: MessageId; // UUID（重複検知用）
  type: ClientMessageType;
  roomId: RoomId;
  gameId?: GameId;
  senderId: PlayerId;
  payload: unknown;
}

// サーバ → クライアント
interface ServerMessage {
  id: MessageId;
  type: ServerMessageType;
  roomId: RoomId;
  gameId?: GameId;
  payload: unknown;
  visibility: "all" | "player" | "spectator";
  targetPlayerId?: PlayerId; // visibility="player" の場合のみ
}
```

### 重複送信対策

- `seen_msgs` で受信済みMessageIdを60秒間保持
- 重複時は `server:error (WS_DUPLICATE_MESSAGE, recoverable: true)` を返す

### 再接続フロー

1. クライアントが同じ `playerId` で `client:join_room` を再送
2. `ConnectionManager` が既存playerIdを照合し再参加として処理
3. `server:state_sync` で最新状態を全量送信（手札は本人のみ）

---

## エラーコード体系

形式: `"{PREFIX}_{SCREAMING_SNAKE_CASE}"`

| プレフィックス | 対象           |
| -------------- | -------------- |
| `ROOM_`        | ルーム管理     |
| `SESSION_`     | セッション管理 |
| `ACTION_`      | ゲーム行動     |
| `WS_`          | WebSocket接続  |
| `RULE_`        | ルール定義     |

`recoverable: true` → クライアントはトースト表示して再試行可能  
`recoverable: false` → モーダル表示してトップ画面へ遷移

主要なエラーコードは `detail-design.md` 第10章を参照。

---

## ルール定義YAMLフォーマット

`rules/basic.yaml` を正本として実装を確認すること。
ルールの継承は `extends: basic` で記述し、`overrides:` で差分のみ定義する。

`RuleSetLoader` は起動時にYAMLを読み込み、`RuleSetRegistry` に登録する。
`RuleSetRegistry.get(id)` でどこからでも参照可能にすること。

---

## テスト戦略

### レイヤー

| レイヤー    | ディレクトリ        | 実行タイミング |
| ----------- | ------------------- | -------------- |
| unit        | `test/unit/`        | push/PR時      |
| integration | `test/integration/` | push/PR時      |
| scenario    | `test/scenario/`    | push/PR時      |
| e2e         | （別途）            | リリース前のみ |

### 必須シナリオテスト

以下のシナリオは `applyAction()` を連続呼び出しで検証する:

- `normalWin.test.ts` — セット数を0にして通常勝利
- `showdown.test.ts` — 山札枯渇→決戦フェーズ→最近値プレイヤー勝利
- `raidBossWin.test.ts` — ボスHP=0でプレイヤー側勝利（生存者全員+1）
- `raidPlayerWin.test.ts` — 全プレイヤーHP=0でボスがセッション勝利
- `bugResidual.test.ts` — バグ残留→次ゲームで発動→1ゲーム後クリア
- `illegalNegotiation.test.ts` — ゲーム外交渉が `illegal_negotiation_flagged` として記録される

### 新ルール追加時の回帰確認

1. `test/scenario/` の全basicシナリオを再実行
2. `RuleSetLoader.test.ts` でバリデーション通過を確認
3. 新ハンドラが既存 `EffectRegistry` に影響しないことを確認

---

## よくある実装ミスと対策

| ミスのパターン                       | 正しい実装                                                        |
| ------------------------------------ | ----------------------------------------------------------------- |
| カード効果をif文で分岐               | 効果IDで `EffectRegistry` からハンドラをディスパッチ              |
| クライアント側でゲーム勝敗を判定     | 判定はすべてサーバ。クライアントは補助表示のみ                    |
| 手札をbroadcastで全員に送信          | `visibility: "player"` で本人のみに送信                           |
| HP算出にeffectiveValueを使用         | `rawValue` を使う（Value-Corruption等の効果は含めない）           |
| フェーズ遷移条件をエンジン本体に書く | `PhaseDef.transitionConditions` に定義し `PhaseController` で参照 |
| `appendEvents` を配列置換で実装      | 既存 `events` に追記する（置換しない）                            |

---

## デザインシステム

デザインモックは `docs/design/` に HTML ファイルとして格納されている。実装時は必ずこれを参照すること。

### デザインコンセプト

サイバーパンク / ターミナル風のダークテーマ。グリッド背景・スキャンライン・グロウ効果でゲームの非日常感を演出する。

### フォント

```css
@import url("https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&display=swap");

--font-mono: "Share Tech Mono", "Courier New", monospace; /* 本文・UI全般 */
--font-title:
  "Orbitron", "Share Tech Mono", monospace; /* タイトル・数値・ロゴ */
```

### カラートークン

```css
:root {
  --bg: #060b14; /* ページ背景 */
  --bg-panel: #0c1521; /* パネル背景 */
  --bg-card: #0f1e30; /* カード背景 */
  --border: #0d3a5e; /* 通常ボーダー */
  --border-glow: #1a5fa0; /* 強調ボーダー */
  --cyan: #00e5ff; /* メインアクセント（選択・強調・ロゴ） */
  --cyan-dim: #007a99; /* フォーカスリング */
  --purple: #8b5cf6; /* セカンダリアクセント（Join・紫系） */
  --green: #00ff8c; /* 接続中・Ready・手番 */
  --red: #ff1a4b; /* バグ・エラー・危険 */
  --amber: #ffaa00; /* ルームID・戦略公開・ホスト */
  --text: #c8d8e8; /* 本文 */
  --text-dim: #4a6080; /* 補助テキスト */
  --text-muted: #2a3a50; /* 最弱テキスト・プレースホルダー */
}
```

### 背景エフェクト（全画面共通）

```css
/* グリッド */
body::before {
  background-image:
    linear-gradient(rgba(0, 229, 255, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 229, 255, 0.025) 1px, transparent 1px);
  background-size: 40px 40px;
}

/* スキャンライン */
body::after {
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.12) 2px,
    rgba(0, 0, 0, 0.12) 4px
  );
}
```

### 共通レイアウト

- ページ幅: `1440px`（固定幅）
- ヘッダー高: `48px`（ボーダーボトム付き）
- フッター高: `36px`（ボーダートップ付き）
- ヘッダー右端要素: `margin-left: auto`

### ボタンスタイル

| 種別      | 色                         | 用途                              |
| --------- | -------------------------- | --------------------------------- |
| Primary   | `--cyan` ボーダー + グロウ | Create Room / Play Card / Rematch |
| Secondary | `--purple` ボーダー        | Join Room                         |
| Ready     | `--green` ボーダー         | Ready ボタン                      |
| Ghost     | `--border` → hover `--red` | Leave / Disband                   |

全ボタン共通: `background: transparent`、`font-family: var(--font-mono)`、`letter-spacing: 0.3em`、`text-transform: uppercase`

### 画面別レイアウト詳細

#### 01 — Top（`/`）

- 縦中央配置: ヒーロータイトル → ルーム作成/参加パネル → Info strip
- パネル: 2カラムグリッド（Create / Join）、最大幅 `720px`
- ヒーロータイトル: `font-size: 72px`、`--cyan` グロウ
- Info strip: 3カラムグリッド（Players / Win Condition / Cards）
- パネル角飾り: 左上・右下に `24px` L字ボーダー（`opacity: 0.4`）

#### 02 — Room Lobby（`/room/:id`）

- 2カラムレイアウト: `1fr 360px`（左: プレイヤー + 戦略選択 / 右: コントロール）
- プレイヤースロット: 2×2グリッド。`self` は cyan ボーダー + 上辺 2px ライン、空席は dashed + opacity 0.4
- 戦略グリッド: 4カラム × 2行（全8種）。選択中は cyan 上辺ライン + 背景薄シアン
- 戦略は他プレイヤーには非公開（セッション終了まで `???` 表示）
- 右カラム: ルームステータス → レディ進捗バー → アクションボタン → アクティビティログ
- ルームID: `--amber`、`font-family: var(--font-title)`
- レディ進捗バー: `linear-gradient(90deg, var(--cyan), var(--purple))`

#### 03 — Game Board（`/room/:id/game`）

- 3カラムレイアウト: `220px 1fr 260px`（左: プレイヤー / 中央: フィールド + 手札 + アクション / 右: バグ + ログ）
- ヘッダーに常時表示: フェーズチップ / セット数 / 手番プレイヤー / 接続状態 / ゲーム番号
- フェーズチップ色分け: normal=cyan / showdown=amber / raid=red
- 手番プレイヤー: `--green` ボーダー + `turnGlow` アニメーション
- 左パネル（プレイヤーリスト）:
  - 自分: cyan 左ボーダー2px、手番中: green 左ボーダー2px
  - 勝利数: `8px` 正方形の pip で表示（filled=amber）
  - 他プレイヤーの戦略: `???` 表示
  - バグ付与中: `--red` のチップをプレイヤー名下に表示
  - 山札残数: 左パネル下部に固定表示
- 中央フィールド:
  - カードサイズ: `60×84px`。最新カード = cyan ボーダー + グロウ、0カード = red グロウ
  - カード間に演算子シンボル（`op-sym`）を挿入
  - 直前カードと同値でない場合: 乗除算ボタンを `opacity: 0.2` + `cursor: not-allowed`
- 手札: `56×78px`、hover で `translateY(-6px)`、selected で `translateY(-10px)`
- 右パネル:
  - 残留バグ: 除去ボタン付き（コスト支払い不可時は `disabled`）
  - イベントログ: スクロール可能。プレイヤー名を cyan / green / amber / purple / red で色分け
  - チャット: `Negotiation / Chat` ラベル付きの入力欄 + SEND ボタン

#### 04 — Session Result（`/room/:id/result`）

- 縦中央配置: 勝者ブロック → スコアボード → サマリーstrip → アクションボタン
- 勝者名: `font-size: 64px`、`nameGlow` アニメーション（cyan）
- 勝者ブロック: 四隅に L字コーナー装飾（`--cyan`）
- 背景: `radial-gradient` cyan の `winnerPulse` アニメーション
- スコアボード: 6カラムグリッド（# / Player / Wins / Games / Pips / badge）
- セッション終了後に全員の戦略が公開（`--amber`）
- アクション: `↺ REMATCH`（cyan）/ `✕ DISBAND ROOM`（ghost → hover red）

### アニメーション定義

```css
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.2;
  }
}
@keyframes turnGlow {
  0%,
  100% {
    box-shadow: 0 0 10px rgba(0, 255, 140, 0.2);
  }
  50% {
    box-shadow: 0 0 20px rgba(0, 255, 140, 0.4);
  }
}
@keyframes nameGlow {
  0%,
  100% {
    text-shadow:
      0 0 20px rgba(0, 229, 255, 0.8),
      0 0 60px rgba(0, 229, 255, 0.4);
  }
  50% {
    text-shadow:
      0 0 30px rgba(0, 229, 255, 1),
      0 0 80px rgba(0, 229, 255, 0.6);
  }
}
@keyframes winnerPulse {
  0%,
  100% {
    transform: translate(-50%, -50%) scale(1);
  }
  50% {
    transform: translate(-50%, -50%) scale(1.1);
    opacity: 0.7;
  }
}
```

---

## 実装を始める前のチェックリスト

- [ ] `src/shared/types/domain.ts` に `detail-design.md` 第3章の型定義をすべて反映した
- [ ] `src/shared/types/messages.ts` に `detail-design.md` 第6章のメッセージ型を反映した
- [ ] `rules/basic.yaml` の内容を `RuleSetLoader` が正しくパースできることを確認した
- [ ] `applyAction` が副作用なしの純粋関数になっている
- [ ] 手札の `visibility` 制御が実装されている
- [ ] `seen_msgs` による重複メッセージ検知が動作する
