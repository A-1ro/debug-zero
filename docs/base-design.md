# 基本設計

## 1. システム構成概要

```
[クライアント: React]
    ↕ WebSocket
[サーバ: Cloudflare Workers + Hono]
    ├── ルーム管理
    ├── 接続管理
    ├── セッション管理
    ├── ゲーム進行エンジン
    ├── ルール定義ローダー
    ├── 効果解決エンジン
    └── ログ記録
```

- サーバが唯一の正（Single Source of Truth）
- クライアントは表示と入力のみ担当
- 全ゲームロジックはサーバ側で完結
- 将来的な永続化は Durable Objects を前提とした設計とする

---

## 2. レイヤー構成

```
src/
├── client/              # Reactフロントエンド
│   ├── components/      # UIコンポーネント
│   ├── hooks/           # WebSocket接続・状態管理hook
│   └── views/           # 画面単位のコンポーネント
└── server/              # Cloudflare Workers + Hono
    ├── index.ts         # エントリポイント・ルーティング
    ├── room/            # ルーム管理
    ├── session/         # セッション管理
    ├── game/            # ゲーム進行エンジン
    ├── rules/           # ルール定義ローダー・バリデーター
    ├── effects/         # 効果解決エンジン
    ├── ws/              # WebSocket接続管理
    └── log/             # イベントログ記録
```

---

## 3. ドメインモデル

### 3.1 エンティティ一覧

```
RuleSet        ルール定義セット（例: basic）
Session        セッション（複数ゲームを包含）
Game           1ゲーム分の状態
Room           参加プレイヤーを束ねるルーム
Player         プレイヤー
Deck           山札
Hand           手札（プレイヤーごと）
Field          場（現在ラウンドで出されたカード列）
TurnOrder      手番順序
Strategy       戦略カード定義
Bug            バグカード定義
Effect         効果（カード効果・残留効果）
Phase          フェーズ定義（通常/決戦/レイド）
Action         プレイヤーの行動1件
EventLog       イベントログ1件
```

### 3.2 主要データ構造

```typescript
type RuleSetId = string; // e.g. "basic"

interface RuleSet {
  id: RuleSetId;
  version: string;
  deck: DeckConfig;
  strategies: StrategyDef[];
  bugs: BugDef[];
  phases: PhaseDef[];
  winCondition: WinConditionDef;
  initialConfig: InitialConfig;
}

interface DeckConfig {
  cards: { value: number; count: number }[];
}

interface StrategyDef {
  id: string;             // e.g. "Aggro"
  effect: EffectDef;
  exclusionCondition?: ExclusionCondition; // e.g. Zero: 3人以上選択で無効
}

interface BugDef {
  id: string;             // e.g. "Odd-Forbidden"
  effect: EffectDef;
  removalCost: RemovalCost;
}

interface EffectDef {
  trigger: TriggerCondition;
  target: TargetDef;
  action: EffectAction;
  constraints?: ConstraintDef[];
  usageLimit?: number;    // nullで無制限、数値で回数制限
}

interface PhaseDef {
  id: "normal" | "showdown" | "raid";
  transitionConditions: TransitionCondition[];
}

interface WinConditionDef {
  winsRequired: number;   // basic: 3
}

interface InitialConfig {
  recommendedPlayers: number; // basic: 4
  initialHandSize: number;    // basic: 5
  initialHP: number;          // basic: 10 (レイド戦)
  setNumberFormula: string;   // basic: "gameIndex * 10"
}
```

```typescript
interface Room {
  id: string;
  hostPlayerId: string;
  players: Player[];
  maxPlayers: number;
  status: "waiting" | "in-session";
  ruleSetId: RuleSetId;
  sessionId?: string;
}

interface Session {
  id: string;
  roomId: string;
  ruleSetId: RuleSetId;
  players: SessionPlayer[];
  games: Game[];
  currentGameIndex: number;
  status: "in-progress" | "finished";
  winnerId?: string;
}

interface SessionPlayer {
  playerId: string;
  strategyId: string;
  wins: number;
}

interface Game {
  id: string;
  sessionId: string;
  gameIndex: number;           // 1始まり
  setNumber: number;           // gameIndex * 10
  phase: "normal" | "showdown" | "raid";
  status: "in-progress" | "finished";
  deck: CardId[];
  field: FieldCard[];          // 場に出ているカード列
  hands: Record<string, CardId[]>; // playerId -> 手札
  turnOrder: string[];         // playerId配列（順番）
  currentTurnIndex: number;
  residualBugs: BugId[];       // 残留バグ
  raidState?: RaidState;
  winnerId?: string;
  events: EventLog[];
}

interface FieldCard {
  cardId: CardId;
  playerId: string;
  operation: "add" | "sub" | "mul" | "div";
  effectiveValue: number;      // 戦略効果適用後の値
  rawValue: number;            // カード額面値
}

interface RaidState {
  bossPlayerId: string;
  bossHP: number;
  playerHPs: Record<string, number>;
  activeBugId: BugId;
  roundIndex: number;
  turnOrder: string[];         // 1D10決定後の順序
}

interface Player {
  id: string;
  name: string;
  role: "player" | "spectator";
  connectionStatus: "connected" | "disconnected";
}

interface EventLog {
  id: string;
  timestamp: number;
  type: EventType;
  actorId: string;
  payload: Record<string, unknown>;
}
```

---

## 4. モジュール設計

### 4.1 ルーム管理 (`room/`)

責務: ルームのライフサイクル管理

```
RoomRepository   ルーム状態の保持・取得
RoomService      作成・参加・退出・ホスト操作
```

主要操作:
- `createRoom(hostPlayer, ruleSetId)` → Room
- `joinRoom(roomId, player)` → Room
- `leaveRoom(roomId, playerId)` → Room
- `startSession(roomId, hostPlayerId)` → Session（セッション管理に委譲）

### 4.2 セッション管理 (`session/`)

責務: セッション単位の状態管理・ゲーム間の勝利数集計

```
SessionService   セッション開始・終了・次ゲーム遷移
```

主要操作:
- `startSession(room)` → Session
- `startNextGame(sessionId)` → Game（ゲーム進行エンジンに委譲）
- `recordWin(sessionId, playerId)` → Session
- `checkSessionWin(session)` → string | null（勝者ID）
- `endSession(sessionId)` → Session

### 4.3 ゲーム進行エンジン (`game/`)

責務: 1ゲーム内の状態遷移・手番管理・勝敗判定

```
GameEngine       ゲーム状態遷移の中核
TurnManager      手番順・スキップ禁止の管理
ActionValidator  行動の合法性チェック
ArithmeticJudge  四則演算裁定
PhaseController  フェーズ遷移制御（通常→決戦/レイド）
```

主要操作:
- `startGame(session, gameIndex)` → Game
- `applyAction(game, action)` → Game（純粋関数）
- `validateAction(game, action)` → ValidationResult
- `resolveArithmetic(game, card, operation)` → ArithmeticResult
- `checkPhaseTransition(game)` → Phase | null
- `checkGameWin(game)` → WinResult | null

四則演算裁定ルール実装:
```
加算・減算: 常に可能
乗算・除算: field[-1].rawValue === card.rawValue の場合のみ可能
除算端数: Math.ceil（常に切り上げ）
```

### 4.4 ルール定義ローダー (`rules/`)

責務: ルールセット定義の読み込み・管理

```
RuleSetLoader    YAMLまたはJSONのルール定義を読み込む
RuleSetRegistry  複数ルールセットの登録・取得
```

- ルール定義はコードと分離し、`rules/*.yaml` または `rules/*.json` で管理
- `RuleSetRegistry.get(id)` でどこからでも参照可能
- ルール追加時はファイル追加のみ（既存コード変更不要）

### 4.5 効果解決エンジン (`effects/`)

責務: カード効果・戦略効果・バグ効果の解決

```
EffectResolver   効果定義に従い状態変更を生成
EffectRegistry   効果IDと実装のマッピング
```

設計方針:
- 効果は `発動条件(trigger)` `対象(target)` `処理(action)` `制約(constraints)` に分解
- `if` 文の積み上げを避け、効果IDで実装をディスパッチ
- 各効果は独立したハンドラ関数として実装

```typescript
type EffectHandler = (game: Game, ctx: EffectContext) => GamePatch;

interface EffectContext {
  actorId: string;
  triggerCard?: FieldCard;
  targetId?: string;
}

// 例: Aggroハンドラ
const aggroHandler: EffectHandler = (game, ctx) => {
  // 自身が出したカードのeffectiveValueを2倍にするpatchを返す
};
```

### 4.6 WebSocket接続管理 (`ws/`)

責務: 接続・切断・メッセージ配信の管理

```
ConnectionManager  接続IDとプレイヤーIDのマッピング
MessageRouter      受信メッセージを各サービスにルーティング
Broadcaster        対象プレイヤー・全員・観戦者への配信
```

- クライアント要求（`client:*`）とサーバ通知（`server:*`）を明確に分離
- 再接続時に最新状態を全量同期
- 重複送信はメッセージIDで検知・無視

### 4.7 ログ記録 (`log/`)

責務: 全イベントの時系列記録・裁定追跡

```
EventLogger   イベントをGameに追記
LogQuery      イベント履歴の取得・フィルタ
```

- 全行動・効果発動・状態変更をイベントとして記録
- 裁定検証・デバッグに使用可能

---

## 5. フェーズ状態機械

```
[通常フェーズ]
  ↓ 山札が尽きた
[決戦フェーズ] → 最も近い数字を作ったプレイヤー勝利

[通常フェーズ]
  ↓ 0のカードが出された（プレイヤーが選択）
  ├─ リセット選択 → [通常フェーズ] (セット数・手札リセット、0カード除外)
  └─ レイド戦選択 → [レイド戦フェーズ]

[レイド戦フェーズ]
  ├─ ボスHP <= 0 → レイド戦終了（勝者判定）
  └─ 全プレイヤーHP <= 0 → ボスがセッション勝利
```

フェーズ遷移条件は `PhaseDef.transitionConditions` に定義し、エンジン本体に埋め込まない。

---

## 6. WebSocket通信設計

### 6.1 メッセージ基本構造

```typescript
// クライアント → サーバ（要求）
interface ClientMessage {
  id: string;           // 重複検知用メッセージID（UUID）
  type: ClientMessageType;
  roomId: string;
  gameId?: string;
  senderId: string;
  payload: unknown;
}

// サーバ → クライアント（通知）
interface ServerMessage {
  id: string;
  type: ServerMessageType;
  roomId: string;
  gameId?: string;
  payload: unknown;
  visibility: "all" | "player" | "spectator";
  targetPlayerId?: string; // visibility="player" の場合
}
```

### 6.2 メッセージ種別

```
// クライアント要求
client:join_room          ルーム参加
client:leave_room         ルーム退出
client:ready              準備完了
client:start_game         ゲーム開始（ホストのみ）
client:action             行動要求（カードを出す/バグ除去/手札補充）
client:reset_or_raid      0カード後のリセット/レイド選択
client:select_strategy    戦略カード選択

// サーバ通知
server:room_updated       ルーム状態更新
server:session_started    セッション開始
server:game_started       ゲーム開始
server:action_result      行動結果
server:phase_changed      フェーズ遷移
server:game_ended         ゲーム終了
server:session_ended      セッション終了
server:state_sync         状態全量同期（再接続時など）
server:error              エラー通知
```

### 6.3 情報配信のvisibility制御

- 手札（Hand）は本人にのみ送信（`visibility: "player"`）
- ゲーム状態（セット数・場・ターン）は全員に送信
- 観戦者には手札を除いた状態を送信

---

## 7. UI設計方針

### 7.1 画面構成

```
/                    トップ（ルーム作成・参加）
/room/:id            ルーム待機画面
/room/:id/session    セッション中画面
  └── GameBoard      ゲームボード（メイン）
      ├── PhaseDisplay       現在フェーズ表示
      ├── SetNumberDisplay   セット数 / ボスHP表示
      ├── TurnIndicator      手番プレイヤー表示
      ├── FieldDisplay       場のカード表示
      ├── HandDisplay        手札表示（自分のみ）
      ├── ActionPanel        実行可能行動のみ表示
      ├── BugDisplay         残留バグ・アクティブバグ表示
      ├── PlayerList         参加者・HP・勝利数一覧
      ├── EventLogPanel      行動履歴・効果ログ
      └── ChatArea           交渉・相談テキスト入力
/room/:id/result     セッション結果画面
```

### 7.2 クライアント状態管理

- WebSocketから受信した状態をそのままUIに反映（サーバが正）
- クライアント側での補助表示（実行可能行動ハイライト等）はUIのみの責務
- 接続状態（connected/disconnected/reconnecting）を常に表示

---

## 8. ルール拡張設計

### 8.1 新ルールセット追加手順

1. `rules/<new-ruleset>.yaml` を追加
2. `RuleSetRegistry` に登録（自動スキャンまたは手動登録）
3. 新カード効果があれば `effects/` にハンドラを追加
4. 既存エンジン・UI・通信プロトコルの変更は不要

### 8.2 basicルールの継承拡張

```yaml
# rules/basic-variant.yaml の例
extends: basic
overrides:
  winCondition:
    winsRequired: 5
  strategies:
    - id: NewStrategy
      effect: ...
```

---

## 9. テスト設計方針

| テスト対象 | 手法 |
|---|---|
| 四則演算裁定 | `ArithmeticJudge` の単体テスト |
| フェーズ遷移 | `PhaseController` の単体テスト（純粋関数） |
| 各カード効果 | `EffectResolver` の単体テスト（効果ハンドラごと） |
| セッション進行 | シナリオテスト（`applyAction` を連続適用） |
| ゲーム外交渉の禁止 | EventLogに記録された宣言内容の検証 |
| WebSocket切断・再接続 | 状態全量同期の結合テスト |
| 重複送信 | メッセージID重複時の無視の単体テスト |
| basicルール回帰 | 新ルール追加後にbasicシナリオテストを再実行 |

- ゲーム進行ロジック（`applyAction` 等）は純粋関数で実装し、テスト容易性を最優先
- WebSocketや接続管理は副作用として分離し、ロジックと混在させない

---

## 10. 今後の詳細化対象

本書の次段階として以下を詳細化する。

- 画面遷移図
- ドメインモデル詳細（型定義一覧）
- 状態遷移図（フェーズ・セッション）
- WebSocketメッセージ仕様（全ペイロード定義）
- ルール定義YAMLフォーマット仕様
- 効果解決インターフェース仕様
- 永続化方針（Durable Objects設計）
- テスト戦略詳細
