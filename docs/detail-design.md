# 詳細設計

## 1. 目的と本書の位置づけ

本書は、要件定義（`docs/require.md`）・基本設計（`docs/base-design.md`）を受け、実装者がそのままコードへ落とせる精度まで仕様を確定させる詳細設計書である。

**本書が確定する範囲**
- 全型定義（TypeScript インターフェース）
- 画面一覧・画面遷移
- 状態遷移（セッション・ゲーム・フェーズ）
- WebSocket 全メッセージのペイロード定義
- ルール定義 YAML フォーマット仕様
- 効果解決インターフェース仕様
- 永続化方針（Durable Objects 設計）
- エラーコード定義
- テスト戦略詳細

**本書が確定しない範囲（実装時判断に委ねる）**
- ライブラリバージョン選定
- CI/CD パイプライン詳細
- デプロイ手順

**章の依存関係**

```
3章（ドメインモデル）
  └→ 5章（状態遷移: 型を使って状態を記述）
  └→ 6章（メッセージ: 型を使ってペイロードを記述）
  └→ 7章（YAML: 型との対応を示す）
  └→ 8章（効果解決: GamePatch等の型を使う）
  └→ 9章（永続化: 型を使ってストレージキーを定義）
  └→ 10章（エラー: ActionValidatorが返すコードを定義）
  └→ 11章（テスト: 全章の仕様を検証対象として参照）
```

---

## 2. ディレクトリ構造詳細

```
debug-zero/
├── rules/
│   └── basic.yaml                  # basicルール定義
├── docs/
│   ├── require.md
│   ├── base-design.md
│   └── detail-design.md
└── src/
    ├── shared/                      # サーバ・クライアント共通型
    │   ├── types/
    │   │   ├── domain.ts            # ドメイン型定義（Game, Session, Player 等）
    │   │   ├── messages.ts          # WebSocket メッセージ型定義
    │   │   ├── rules.ts             # ルール定義型
    │   │   └── effects.ts           # 効果定義型
    │   └── constants.ts             # 共通定数（エラーコード等）
    ├── server/
    │   ├── index.ts                 # Hono エントリポイント・ルーティング定義
    │   ├── room/
    │   │   ├── RoomRepository.ts    # ルーム状態の保持・取得
    │   │   └── RoomService.ts       # 作成・参加・退出・ホスト操作
    │   ├── session/
    │   │   └── SessionService.ts    # セッション開始・終了・次ゲーム遷移・勝利数集計
    │   ├── game/
    │   │   ├── GameEngine.ts        # ゲーム状態遷移の中核（applyAction）
    │   │   ├── TurnManager.ts       # 手番順・スキップ禁止の管理
    │   │   ├── ActionValidator.ts   # 行動の合法性チェック
    │   │   ├── ArithmeticJudge.ts   # 四則演算裁定（純粋関数）
    │   │   └── PhaseController.ts   # フェーズ遷移制御
    │   ├── rules/
    │   │   ├── RuleSetLoader.ts     # YAML 読み込み・パース・バリデーション
    │   │   └── RuleSetRegistry.ts   # 複数ルールセットの登録・取得
    │   ├── effects/
    │   │   ├── EffectResolver.ts    # 効果解決の統括（トリガー→ハンドラ呼び出し→パッチ生成）
    │   │   ├── EffectRegistry.ts    # 効果 ID と EffectHandler のマッピング
    │   │   └── handlers/
    │   │       ├── strategies/
    │   │       │   ├── aggro.ts
    │   │       │   ├── controlAdd.ts
    │   │       │   ├── controlSub.ts
    │   │       │   ├── hack.ts
    │   │       │   ├── trickStar.ts
    │   │       │   └── zero.ts
    │   │       └── bugs/
    │   │           ├── oddForbidden.ts
    │   │           ├── evenForbidden.ts
    │   │           ├── stackForbidden.ts
    │   │           ├── aggroForbidden.ts
    │   │           ├── controlForbidden.ts
    │   │           ├── hackForbidden.ts
    │   │           ├── trickStarForbidden.ts
    │   │           └── valueCorruption.ts
    │   ├── ws/
    │   │   ├── ConnectionManager.ts # 接続 ID とプレイヤー ID のマッピング
    │   │   ├── MessageRouter.ts     # 受信メッセージを各サービスにルーティング
    │   │   └── Broadcaster.ts       # 対象プレイヤー・全員・観戦者への配信
    │   └── log/
    │       ├── EventLogger.ts       # イベントを Game に追記
    │       └── LogQuery.ts          # イベント履歴の取得・フィルタ
    ├── client/
    │   ├── main.tsx                 # React エントリポイント
    │   ├── hooks/
    │   │   ├── useWebSocket.ts      # WebSocket 接続・メッセージ受信
    │   │   └── useGameState.ts      # ゲーム状態管理（受信状態をそのまま保持）
    │   ├── views/
    │   │   ├── TopView.tsx          # トップ（ルーム作成・参加）
    │   │   ├── RoomView.tsx         # ルーム待機
    │   │   ├── SessionView.tsx      # セッション中（GameBoard を包含）
    │   │   └── ResultView.tsx       # セッション結果
    │   └── components/
    │       ├── GameBoard.tsx        # ゲームボード全体
    │       ├── PhaseDisplay.tsx
    │       ├── SetNumberDisplay.tsx
    │       ├── TurnIndicator.tsx
    │       ├── FieldDisplay.tsx
    │       ├── HandDisplay.tsx
    │       ├── ActionPanel.tsx
    │       ├── BugDisplay.tsx
    │       ├── PlayerList.tsx
    │       ├── EventLogPanel.tsx
    │       └── ChatArea.tsx
    └── test/
        ├── unit/
        │   ├── ArithmeticJudge.test.ts
        │   ├── ActionValidator.test.ts
        │   ├── PhaseController.test.ts
        │   ├── effects/            # 各ハンドラの単体テスト
        │   └── RuleSetLoader.test.ts
        ├── integration/
        │   ├── ws-reconnect.test.ts
        │   └── durable-objects.test.ts
        └── scenario/
            ├── normalWin.test.ts
            ├── showdown.test.ts
            ├── raidBossWin.test.ts
            ├── raidPlayerWin.test.ts
            ├── bugResidual.test.ts
            └── illegalNegotiation.test.ts
```

**命名規則**
- ファイル名: PascalCase（クラス・コンポーネント）/ camelCase（フック・ユーティリティ）
- 型名: PascalCase インターフェース
- 効果ハンドラファイル名: カード名を camelCase に変換（`Control-Add` → `controlAdd.ts`）

---

## 3. ドメインモデル詳細

### 3.1 プリミティブ型

```typescript
type PlayerId   = string; // UUID
type RoomId     = string; // 短い識別子（表示用）、例: "ABC123"
type SessionId  = string; // UUID
type GameId     = string; // UUID
type CardId     = string; // "{value}-{serial}" 例: "3-007"（デッキ内で一意）
type BugId      = string; // バグカード識別子 例: "Odd-Forbidden"
type StrategyId = string; // 戦略カード識別子 例: "Aggro"
type RuleSetId  = string; // ルールセット識別子 例: "basic"
type EffectId   = string; // 効果識別子 例: "basic:aggro"
type MessageId  = string; // UUID（重複検知用）
type EventId    = string; // UUID
```

### 3.2 カード定義

```typescript
// デッキ内の個別カード（インスタンス）
interface Card {
  id: CardId;       // "{value}-{serial}" デッキ内で一意
  value: number;    // 0〜9 の額面値
}

// 場に出ているカード
interface FieldCard {
  cardId:         CardId;
  playerId:       PlayerId;        // 出したプレイヤー
  operation:      Operation;       // 適用した演算
  rawValue:       number;          // カード額面値（HP算出等で参照）
  effectiveValue: number;          // 戦略効果適用後の値（Aggro等で変わる）
}

type Operation = "add" | "sub" | "mul" | "div";
```

### 3.3 ルール定義型

```typescript
interface RuleSet {
  id:            RuleSetId;
  version:       string;
  extends?:      RuleSetId;          // 継承元ルールセット ID
  deck:          DeckConfig;
  strategies:    StrategyDef[];
  bugs:          BugDef[];
  phases:        PhaseDef[];
  winCondition:  WinConditionDef;
  initialConfig: InitialConfig;
}

interface DeckConfig {
  cards: { value: number; count: number }[]; // value 0〜9
}

interface StrategyDef {
  id:                  StrategyId;
  effect:              EffectDef;
  exclusionCondition?: ExclusionCondition;
}

interface BugDef {
  id:          BugId;
  effect:      EffectDef;
  removalCost: RemovalCost;
}

// 効果定義（カード効果・バグ効果共通）
interface EffectDef {
  id:           EffectId;
  trigger:      TriggerCondition;
  target:       TargetDef;
  action:       EffectAction;
  constraints?: ConstraintDef[];
  usageLimit?:  number;            // undefined で無制限、1 なら1ゲーム1回
}

// トリガー条件
type TriggerCondition =
  | { type: "on_card_played" }
  | { type: "on_card_played_by_other" }
  | { type: "on_game_start" }
  | { type: "on_round_start" }        // レイド戦ラウンド開始時
  | { type: "on_turn_start" }
  | { type: "always" };               // 常時発動（禁止系バグ等）

// 対象定義
type TargetDef =
  | { type: "self" }                  // 効果を持つプレイヤー自身
  | { type: "actor" }                 // 効果を発動したプレイヤー
  | { type: "field_card" }            // 場の特定カード
  | { type: "any_player" }            // 任意のプレイヤー（ボス含む）
  | { type: "boss" }
  | { type: "all_players" }
  | { type: "hand" };                 // 手札

// 効果アクション
type EffectAction =
  | { type: "multiply_effective_value"; factor: number }  // Aggro
  | { type: "change_operation"; from: Operation; to: Operation } // Control系
  | { type: "steal_card" }           // Hack: 場のカードを自分のものにする
  | { type: "remove_field_card" }    // TrickStar: 場からカードを除外
  | { type: "add_card_to_hand"; cardValue: number }  // Zero
  | { type: "invalidate_strategy" }  // Forbidden 系（戦略を無効化）
  | { type: "forbid_card_parity"; parity: "odd" | "even" }
  | { type: "forbid_stack" }         // Stack-Forbidden
  | { type: "override_card_value"; value: number };  // Value-Corruption

// 制約定義
type ConstraintDef =
  | { type: "usage_limit_per_game"; limit: number }
  | { type: "no_retroactive" }        // 遡及禁止
  | { type: "card_parity"; parity: "odd" | "even" }  // 特定数字パリティで発動
  | { type: "strategy_match"; strategyId: StrategyId } // 特定戦略選択者にのみ有効
  | { type: "selection_count_threshold"; min: number }; // Zero: 2人以上で無効

// 除外条件（戦略カードが無効化されるルール）
interface ExclusionCondition {
  type:  "selection_count_threshold";
  min:   number;    // basic/Zero: 2
}

// 除去コスト（バグカード除去時の支払い）
type RemovalCost =
  | { type: "hp"; amount: number }               // HP -3 等
  | { type: "hand_card"; value: "even" | "odd" | number; amount: number }
  | { type: "composite"; costs: RemovalCost[] }; // 複合コスト（Value-Corruption等）

// フェーズ定義
interface PhaseDef {
  id:                  PhaseId;
  transitionConditions: TransitionCondition[];
}

type PhaseId = "normal" | "showdown" | "raid";

type TransitionCondition =
  | { type: "deck_empty"; to: "showdown" }
  | { type: "card_zero_played"; to: "raid" | "reset" }  // 0カード後の選択
  | { type: "boss_hp_zero_or_less"; to: "finished" }
  | { type: "all_players_hp_zero_or_less"; to: "session_win_boss" };

interface WinConditionDef {
  winsRequired: number; // basic: 3
}

interface InitialConfig {
  recommendedPlayers: number; // basic: 4
  initialHandSize:    number; // basic: 5
  initialHP:          number; // basic: 10（レイド戦プレイヤーHP）
  setNumberFormula:   string; // basic: "gameIndex * 10"
}
```

### 3.4 ルーム・セッション・ゲーム型

```typescript
interface Room {
  id:           RoomId;
  hostPlayerId: PlayerId;
  players:      Player[];
  maxPlayers:   number;
  status:       RoomStatus;
  ruleSetId:    RuleSetId;
  sessionId?:   SessionId;
}

type RoomStatus = "waiting" | "strategy-selection" | "in-session";

interface Player {
  id:               PlayerId;
  name:             string;
  role:             "player" | "spectator";
  connectionStatus: ConnectionStatus;
}

type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

// ---

interface Session {
  id:               SessionId;
  roomId:           RoomId;
  ruleSetId:        RuleSetId;
  players:          SessionPlayer[];
  gameIds:          GameId[];          // 進行順に格納
  currentGameIndex: number;            // 0始まり
  status:           SessionStatus;
  winnerId?:        PlayerId;
}

type SessionStatus = "in-progress" | "finished";

interface SessionPlayer {
  playerId:   PlayerId;
  strategyId: StrategyId;
  wins:       number;
  // Zero 戦略の有効性は EffectResolver が判定する（選択者数）
}

// ---

interface Game {
  id:               GameId;
  sessionId:        SessionId;
  gameIndex:        number;            // 1始まり
  setNumber:        number;            // gameIndex * 10
  phase:            PhaseId;
  status:           GameStatus;
  deck:             CardId[];          // 山札（先頭が次に引くカード）
  excludedCards:    CardId[];          // 除外されたカード（0カードリセット使用済み等）
  field:            FieldCard[];       // 場のカード列（時系列順）
  hands:            Record<PlayerId, CardId[]>;
  usedStrategyCounts: Record<PlayerId, Record<StrategyId, number>>; // 使用回数管理
  turnOrder:        PlayerId[];        // 手番順（ゲーム開始時に決定）
  currentTurnIndex: number;
  resetCount:       number;            // 0カードリセット回数（最大2）
  residualBugs:     BugId[];           // 前ゲームからの残留バグ
  raidState?:       RaidState;
  pendingIntervention?: PendingIntervention; // A1: 介入オファーの応答待ち（下記）
  status_:          GameStatus;
  winnerId?:        PlayerId;
  events:           EventLog[];
}

type GameStatus = "initializing" | "in-progress" | "finished";

interface RaidState {
  bossPlayerId: PlayerId;
  bossHP:       number;                // 場のカード合計（額面値）
  playerHPs:    Record<PlayerId, number>; // 初期値 10
  activeBugId:  BugId;                 // ボスが選択したバグ（D2）。未選択時は ""
  roundIndex:   number;                // 1始まり
  turnOrder:    PlayerId[];            // 1D10 で決定した手番順（ボスは含まない・D3）
  currentTurnIndex: number;            // プレイヤー手番中のみ有効なインデックス
  bossActionsLeft:  number;            // Math.ceil(playerCount / 2)
  // D3: 全プレイヤー行動後のボス手番中は true（currentTurnIndex は末尾スロットを指す）。
  // undefined=プレイヤー手番。
  bossTurn?:        boolean;
  // D3: このラウンドの手番順を決めた各プレイヤーの最終1D10ロール。
  // 旧stateとの互換のため optional。
  diceResults?:     Record<PlayerId, number>;
  // D2: ラウンド頭でボスのバグ選択を待っている間 true。選択が済む（or タイムアウトで
  // ランダム代打）まで、レイドの戦闘アクションは一切受け付けない。
  awaitingBugChoice?: boolean;
  // D2: このラウンドでボスが選べる未発動バグの候補。
  bugCandidates?:   BugId[];
}

// A1（オーナー裁定）: 介入系戦略（Control-Add/Sub/Mul/Div・Hack・TrickStar）の
// 任意発動待ち。トリガー成立時に自動発動せず、候補者全員の accept/pass が
// 揃うまでゲームは凍結される（手番前進なし・他アクション拒否）。
interface PendingIntervention {
  triggerCard:     FieldCard;          // トリガーカードのスナップショット
  actorId:         PlayerId;           // トリガーカードを出したプレイヤー
  setNumberBefore: number;             // カード演算前のセット数（undo/redo用）
  candidates:      { playerId: PlayerId; strategyId: StrategyId }[];
                                       // 解決優先順（actorの次から手番順）
  responses:       Record<PlayerId, boolean>; // playerId → 発動するか
}
```

### 3.5 アクション型

```typescript
// クライアントから送られる行動
type Action =
  | PlayCardAction
  | RemoveBugAction
  | DrawCardAction
  | ResetOrRaidAction
  | SelectStrategyAction
  | InterventionResponseAction
  | ChooseRaidBugAction;

interface PlayCardAction {
  type:      "play_card";
  cardId:    CardId;
  operation: Operation;
  // レイド戦の場合は targetId が必要
  targetId?: PlayerId | "boss";
}

interface RemoveBugAction {
  type:        "remove_bug";
  bugId:       BugId;
  // 除去コストが手札カードの場合
  costCardIds?: CardId[];
}

interface DrawCardAction {
  type: "draw_card";
}

interface ResetOrRaidAction {
  type:   "reset_or_raid";
  choice: "reset" | "raid";
}

interface SelectStrategyAction {
  type:       "select_strategy";
  strategyId: StrategyId;
}

// A1: server:intervention_offer への応答。activate=false（パス）や
// タイムアウトでは 1ゲーム1回の発動権を消費しない
interface InterventionResponseAction {
  type:     "intervention_response";
  activate: boolean;
}

// D2: server:boss_bug_choice への応答。ボスがそのラウンドのバグを選ぶ。
// bugId は bugCandidates のいずれかでなければならない。無応答はサーバが
// ランダム代打（従来のランダム発生と同挙動）。
interface ChooseRaidBugAction {
  type:  "choose_raid_bug";
  bugId: BugId;
}
```

### 3.6 処理結果型

```typescript
interface ValidationResult {
  valid:    boolean;
  errorCode?: ErrorCode;
  detail?:  string;
}

interface ArithmeticResult {
  before:     number;   // 演算前の値（setNumber または HP）
  after:      number;   // 演算後の値
  operation:  Operation;
  cardValue:  number;   // 使用した effectiveValue
}

interface WinResult {
  type:        GameWinType;
  winnerId?:   PlayerId;     // null の場合は複数勝者（決戦引き分け等）
  winnerIds?:  PlayerId[];   // 決戦フェーズで複数勝者の場合
}

type GameWinType =
  | "set_number_zero"          // セット数を 0 にした
  | "showdown_closest"         // 決戦フェーズ: 最も近い数字
  | "raid_boss_hp_exact_zero"  // レイド戦: ボスHP ちょうど 0（生存者全員勝利）
  | "raid_boss_hp_below_zero"  // レイド戦: ボスHP 0 未満（トドメ刺したプレイヤー）
  | "raid_all_players_dead";   // レイド戦: プレイヤー全滅（ボスがセッション勝利）

interface GamePatch {
  setNumber?:             number;
  phase?:                 PhaseId;
  status?:                GameStatus;
  deck?:                  CardId[];
  excludedCards?:         CardId[];
  field?:                 FieldCard[];
  hands?:                 Record<PlayerId, CardId[]>;
  usedStrategyCounts?:    Record<PlayerId, Record<StrategyId, number>>;
  currentTurnIndex?:      number;
  resetCount?:            number;
  raidState?:             RaidState | null;
  winnerId?:              PlayerId;
  residualBugs?:          BugId[];
  appendEvents?:          EventLog[];   // 追記するイベント（置換ではない）
}
```

### 3.7 イベントログ型

```typescript
interface EventLog {
  id:        EventId;
  timestamp: number;          // Unix ミリ秒
  type:      EventType;
  actorId:   PlayerId | "system" | "boss";
  payload:   EventPayload;
}

type EventType =
  | "game_started"
  | "card_played"
  | "operation_changed"       // Control 系効果
  | "card_stolen"             // Hack 効果
  | "card_removed_from_field" // TrickStar 効果
  | "strategy_invalidated"
  | "bug_activated"
  | "bug_removed"
  | "bug_residual"            // バグ残留確定
  | "phase_changed"
  | "game_reset"
  | "raid_started"
  | "raid_round_started"
  | "hp_changed"
  | "card_drawn"
  | "game_ended"
  | "session_ended"
  | "negotiation_declared"    // ゲーム内交渉の宣言記録
  | "illegal_negotiation_flagged"; // ゲーム外交渉の記録（違反）

type EventPayload = Record<string, unknown>;
```

### 3.8 エンティティ関連図

```
RuleSet
  └─ strategies[] → StrategyDef → EffectDef
  └─ bugs[]       → BugDef      → EffectDef, RemovalCost
  └─ phases[]     → PhaseDef    → TransitionCondition[]

Room ──→ Session ──→ Game[]
  └─ players[]          └─ SessionPlayer[]  └─ field: FieldCard[]
                                            └─ hands: {PlayerId: Card[]}
                                            └─ raidState?: RaidState
                                            └─ events: EventLog[]
```

### 3.9 可視性ルール

| フィールド | 本人 | 他プレイヤー | 観戦者 |
|---|---|---|---|
| `game.hands[自分]` | ○ 全枚数・全値 | × 枚数のみ | × 枚数のみ |
| `game.hands[他者]` | × 枚数のみ | × 枚数のみ | × 枚数のみ |
| `game.deck` | × 枚数のみ | × 枚数のみ | × 枚数のみ |
| `game.field` | ○ | ○ | ○ |
| `game.setNumber` | ○ | ○ | ○ |
| `raidState.playerHPs` | ○ | ○ | ○ |
| `raidState.bossHP` | ○ | ○ | ○ |
| `game.events` | ○ | ○ | ○ |
| `session.players[].wins` | ○ | ○ | ○ |
| `session.players[].strategyId` | ○（自分） | × | × |

---

## 4. 画面一覧と画面遷移

### 4.1 画面一覧

| URL | 画面名 | 目的 | 主要表示要素 |
|---|---|---|---|
| `/` | トップ | ルーム作成・参加 | 名前入力、ルームID入力、作成ボタン、参加ボタン |
| `/room/:id` | ルーム待機 | 参加者確認・戦略選択・ゲーム開始待機 | プレイヤー一覧、戦略選択UI、準備完了ボタン、ゲーム開始ボタン（ホスト） |
| `/room/:id/game` | ゲームボード | ゲーム進行 | フェーズ表示、セット数/HP、場、手札、行動パネル、バグ表示、ログ、チャット |
| `/room/:id/result` | セッション結果 | 勝者表示・再戦/解散選択 | 勝者名、各プレイヤー勝利数、再戦ボタン、解散ボタン |

**観戦者ビュー**: `/room/:id/game` と同 URL・同コンポーネントだが、`player.role === "spectator"` の場合に `HandDisplay` と `ActionPanel` を非表示にする。

### 4.2 画面遷移図

```
[/]
  ├─ ルーム作成 → [/room/:id] (server:room_updated 受信)
  └─ ルーム参加 → [/room/:id] (server:room_updated 受信)

[/room/:id]（ルーム待機）
  ├─ server:game_started 受信 → [/room/:id/game]
  └─ （自分が退出またはルーム解散）→ [/]

[/room/:id/game]（ゲームボード）
  ├─ server:session_ended 受信 → [/room/:id/result]
  └─ 切断 → 再接続待機（同画面で再接続インジケーター表示）
      └─ server:state_sync 受信 → 同画面を最新状態で復元

[/room/:id/result]（セッション結果）
  ├─ 再戦（ホストがゲーム開始）→ [/room/:id] → [/room/:id/game]
  └─ 解散 → [/]
```

**WebSocket イベントによる自動遷移**: `server:game_started`, `server:session_ended`, `server:state_sync`

**手動操作による遷移**: ルーム作成、参加、退出、解散

### 4.3 ゲームボードのフェーズ別表示切り替え

| コンポーネント | normal | showdown | raid |
|---|---|---|---|
| `SetNumberDisplay` | セット数表示 | セット数表示 | ボスHP / 各プレイヤーHP |
| `FieldDisplay` | 場のカード列 | 場のカード列 | 場のカード列 |
| `HandDisplay` | 自分の手札（操作可） | 自分の手札（2枚選択UI） | 自分の手札（操作可） |
| `ActionPanel` | カードを出す | 2枚選出・演算組合せ | カードを出す / バグ除去 / 手札補充 |
| `BugDisplay` | 残留バグのみ | 残留バグのみ | アクティブバグ + 残留バグ |
| `ResetOrRaidModal` | 0カード後のみ表示 | 非表示 | 非表示 |

**実行可能行動のクライアント補助表示**:
- 乗算・除算選択肢は `field[-1].rawValue === card.value` が満たされるカードに対してのみ有効化
- バグ除去ボタンは除去コスト支払い可能な場合のみ有効化（HP残量・手札確認）
- 手札補充ボタンは手札枚数 < 5 かつレイド戦フェーズ のみ表示
- **補助表示はあくまで補助。最終判定はサーバが行う**

---

## 5. 状態遷移図

### 5.1 セッション状態遷移

```
[waiting]
  ─ client:ready（全員）→ [strategy-selection]

[strategy-selection]
  ─ client:select_strategy（全員完了）& client:start_game（ホスト）→ [in-progress]

[in-progress]
  ─ checkSessionWin() で勝者確定 → [finished]

[finished]（終端）
```

### 5.2 ゲーム状態遷移

```
[initializing]
  初期化シーケンス:
  1. 手番決定（各プレイヤーが 1 枚引いて最大値のプレイヤーが先攻、時計回り）
  2. デッキシャッフル・手札配布（各 5 枚）
  3. セット数算出（gameIndex * 10）
  4. 残留バグ適用（前ゲームのバグが residualBugs に入っている場合）
  5. Zero 戦略の有効性判定（2人以上選択の場合無効化イベントを記録）
  ─ 初期化完了 → [in-progress]

[in-progress]
  ─ checkGameWin() → WinResult → [finished]
  ─ checkPhaseTransition() → "showdown" → [in-progress(showdown phase)]
  ─ checkPhaseTransition() → "raid" → [in-progress(raid phase)]

[finished]（終端）
  → SessionService.recordWin() → checkSessionWin()
```

### 5.3 フェーズ状態遷移（通常フェーズ内手番サイクル）

```
[通常フェーズ: 手番待機]
  ─ client:action (play_card)
    → ActionValidator.validate()
      → 不正: server:error
      → 合法:
        → ArithmeticJudge.resolve()
        → EffectResolver.resolve(on_card_played)
        → GamePatch 適用
        → 0カードか確認
          → 0カード: [0カード選択待機]
          → 0以外: カード補充 → checkPhaseTransition()
            → 山札空: [決戦フェーズ]
            → 継続: 次プレイヤーへ

[0カード選択待機]
  ─ client:reset_or_raid (reset)
    → resetCount < 2 ならリセット実行
      → セット数再算出、全手札引き直し、0カード除外
      → [通常フェーズ: 手番待機] (手番リセット)
  ─ client:reset_or_raid (raid)
    → [レイド戦フェーズ]

[決戦フェーズ]
  各プレイヤーが手札から2枚以下を選び任意演算
  → 全員提出後に最接近プレイヤーを判定
  → WinResult 確定 → game.status = "finished"

[レイド戦フェーズ]
  → 初期化: ボスHP算出（場のカード額面値合計）、プレイヤーHP=10、場リセット
  → [レイド戦ラウンド]

[レイド戦ラウンド]
  1. ボスがバグカード選択 (client:action { choose_raid_bug } by boss / D2)
     → ラウンド頭は raidState.awaitingBugChoice=true でボスの選択待ち。
       サーバは server:boss_bug_choice をボスへ個別送信。
       候補（未発動バグ）が空なら選択を飛ばして step2 へ直行。
       タイムアウト（timeouts.bossBugChoice）でサーバがランダム代打。
  2. 各プレイヤーが1D10 → 降順ソートで手番順決定 (D3)
     → サーバ権威で各プレイヤーに1D10を振る。同値は当該プレイヤーのみ
       振り直して順位を確定。ボスは手番順に含まない（turnOrder はプレイヤーのみ）。
       server:raid_round_started に turnOrder と diceResults を載せて配信。
  3. プレイヤー手番サイクル:
     各プレイヤーが「カードを出す」「バグ除去」「手札補充」から1選択
  4. ボス行動: ceil(playerCount/2) 回カードを出す（raidState.bossTurn=true）
  5. 山札空なら場を山札に戻してシャッフル
  6. checkRaidEnd()
     → ボスHP <= 0: WinResult(raid_boss_*) → game.status = "finished"
     → 全プレイヤーHP <= 0: WinResult(raid_all_players_dead) → session 終了
     → 継続: [レイド戦ラウンド] (roundIndex++、step1 のバグ選択待ちへ)
```

### 5.4 接続状態遷移

```
[disconnected]
  ─ WebSocket 接続確立 → [connected]

[connected]
  ─ 切断検知 → [disconnected]
  ─ ルーム参加 → [synced]

[synced]（ゲーム参加中）
  ─ 切断検知 → [reconnecting]

[reconnecting]
  ─ 再接続成功 → ConnectionManager が playerId を照合
    → server:state_sync 送信 → [synced]
  ─ タイムアウト → [disconnected]
```

---

## 6. WebSocket メッセージ仕様

### 6.1 共通構造

```typescript
// クライアント → サーバ
interface ClientMessage {
  id:       MessageId;   // UUID、重複検知用
  type:     ClientMessageType;
  roomId:   RoomId;
  gameId?:  GameId;      // ゲーム中の行動時は必須
  senderId: PlayerId;
  payload:  ClientPayload;
}

// サーバ → クライアント
interface ServerMessage {
  id:              MessageId;
  type:            ServerMessageType;
  roomId:          RoomId;
  gameId?:         GameId;
  payload:         ServerPayload;
  visibility:      "all" | "player" | "spectator";
  targetPlayerId?: PlayerId;  // visibility="player" のみ設定
}
```

**重複検知**: サーバは受信した `MessageId` を直近 60 秒間保持し、重複した場合は `server:error (WS_DUPLICATE_MESSAGE)` を返す。

### 6.2 クライアント要求メッセージ

#### `client:join_room`
```typescript
payload: {
  playerName: string;          // 表示名
  role: "player" | "spectator";
}
// 送信条件: 未参加状態
// サーバ処理: RoomService.joinRoom → server:room_updated を全員に送信
```

#### `client:leave_room`
```typescript
payload: {}
// 送信条件: 参加中
// サーバ処理: RoomService.leaveRoom → server:room_updated を全員に送信
```

#### `client:ready`
```typescript
payload: {}
// 送信条件: ルーム待機中、未準備完了
// サーバ処理: Room 内の ready 状態を更新 → server:room_updated
```

#### `client:select_strategy`
```typescript
payload: {
  strategyId: StrategyId;
}
// 送信条件: strategy-selection フェーズ
// サーバ処理: SessionPlayer.strategyId を設定 → server:room_updated
// バリデーション: 存在する strategyId か確認
```

#### `client:start_game`
```typescript
payload: {}
// 送信条件: ホストのみ、全員が戦略選択済み
// サーバ処理: SessionService.startNextGame → GameEngine.startGame → server:game_started
```

#### `client:action`
```typescript
payload: Action; // PlayCardAction | RemoveBugAction | DrawCardAction | InterventionResponseAction
// 送信条件: 自分の手番中（intervention_response のみ手番外＝オファー対象者が送信）
// サーバ処理: ActionValidator → GameEngine.applyAction → EffectResolver
//            → server:action_result (全員) + server:state_sync (手札のみ対象者)
// A1: オファー待機中（pendingIntervention あり）は intervention_response 以外の
//     全アクションを ACTION_INTERVENTION_PENDING で拒否する
```

#### `client:reset_or_raid`
```typescript
payload: {
  choice: "reset" | "raid";
}
// 送信条件: 0カード後の選択待機中、自分の手番
// サーバ処理: choice に応じてリセット or レイド戦開始
//            → server:phase_changed または server:action_result
```

### 6.3 サーバ通知メッセージ

#### `server:room_updated`
```typescript
payload: {
  room: Room;   // hands フィールドは含まない
}
visibility: "all"
```

#### `server:session_started`
```typescript
payload: {
  sessionId: SessionId;
  players:   SessionPlayer[];
  ruleSetId: RuleSetId;
}
visibility: "all"
```

#### `server:game_started`
```typescript
payload: {
  gameId:     GameId;
  gameIndex:  number;
  setNumber:  number;
  turnOrder:  PlayerId[];
  deckCount:  number;          // 山札枚数（中身は非公開）
  residualBugs: BugId[];
  hand:       CardId[];        // 自分の手札のみ（visibility="player" で個別送信）
  handCounts: Record<PlayerId, number>; // 他プレイヤーの手札枚数（全員送信分）
}
// 手札は visibility="player" で個別送信
// 枚数情報は visibility="all" で全員送信
```

#### `server:action_result`
```typescript
payload: {
  action:         Action;
  actorId:        PlayerId;
  arithmeticResult?: ArithmeticResult;   // play_card の場合
  fieldCard?:     FieldCard;             // 場に追加されたカード
  effectsApplied: EffectId[];            // 発動した効果
  newSetNumber?:  number;                // 更新後のセット数
  raidHpChanges?: Record<PlayerId | "boss", number>; // レイド戦HP変動
  deckCount:      number;
  turnOrder:        PlayerId[];          // 権威的な手番順
  currentTurnIndex: number;              // 権威的な現在手番
  events:         EventLog[];            // このアクションで追記されたイベント
  interventionPending?: boolean;         // A1: 介入オファーの応答待ち中は true。
                                         // 候補者・戦略は秘匿のため boolean のみ
}
visibility: "all"
// 手札補充結果は別途 visibility="player" で個別送信
// レイド戦中は turnOrder/currentTurnIndex を raidState から投影して送る（サーバ側手番修正）：
//   turnOrder = [...raidState.turnOrder, bossPlayerId]（ボスを末尾に付与）
//   currentTurnIndex は bossTurn/awaitingBugChoice 中はボスを指す。
//   → クライアント/bot は raid 中も turnOrder[currentTurnIndex] で現在手番を読める。
```

#### `server:boss_bug_choice`（D2: レイド戦ラウンドのバグ選択オファー、個別送信）
```typescript
payload: {
  gameId:     GameId;
  roundIndex: number;
  candidates: BugId[];    // ボスが選べる未発動バグ
  timeoutMs:  number;     // 応答期限（rules timeouts.bossBugChoice = 5000ms）
  deadline:   number;     // サーバ側期限の目安（epoch ms・表示用）
}
visibility: "player"
targetPlayerId: PlayerId  // ボスにのみ送信
// 応答: client:action { type: "choose_raid_bug", bugId }
// タイムアウト（サーバ権威・DOアラーム）で無応答はランダム代打（従来挙動）
// 候補が空のラウンドではこのオファーは送られず、そのままラウンドが始まる
```

#### `server:intervention_offer`（A1: 介入発動の確認オファー、個別送信）
```typescript
payload: {
  gameId:      GameId;
  triggerCard: FieldCard;    // トリガーとなったカード
  strategyId:  StrategyId;   // 受信者自身の発動可能な戦略
  timeoutMs:   number;       // 応答期限（rules timeouts.intervention = 5000ms）
  deadline:    number;       // サーバ側期限の目安（epoch ms・表示用）
}
visibility: "player"
targetPlayerId: PlayerId     // 候補者ごとに個別送信（戦略は非公開情報のため）
// 応答: client:action { type: "intervention_response", activate: boolean }
// タイムアウト（サーバ権威・DOアラーム）で無応答はパス扱い。
// 他プレイヤーには action_result の interventionPending でぼかして通知する
```

#### `server:hand_updated`（手札更新、個別送信）
```typescript
payload: {
  hand: CardId[];
}
visibility: "player"
targetPlayerId: PlayerId
```

#### `server:phase_changed`
```typescript
payload: {
  from:  PhaseId;
  to:    PhaseId;
  reason: TransitionReason;
  raidState?: RaidState;       // raid への遷移時
}
type TransitionReason = "deck_empty" | "card_zero_played_reset" | "card_zero_played_raid";
visibility: "all"
```

#### `server:raid_round_started`
```typescript
payload: {
  roundIndex:   number;
  activeBugId:  BugId;
  turnOrder:    PlayerId[];    // 1D10 決定後の順序
  diceResults:  Record<PlayerId, number>; // 各プレイヤーのダイス値
}
visibility: "all"
```

#### `server:game_ended`
```typescript
payload: {
  gameId:    GameId;
  winResult: WinResult;
  sessionPlayers: SessionPlayer[]; // 更新後の勝利数
}
visibility: "all"
```

#### `server:session_ended`
```typescript
payload: {
  sessionId: SessionId;
  winnerId:  PlayerId;
  players:   SessionPlayer[];
}
visibility: "all"
```

#### `server:state_sync`（再接続時・全量同期）
```typescript
payload: {
  room:    Room;
  session: Session;           // gameIds のみ（Game 詳細は game に分離）
  game:    GameView;          // 可視性フィルタ済みゲーム状態
}

// GameView: 受信者に応じて手札フィールドをマスクした Game
interface GameView {
  id:             GameId;
  gameIndex:      number;
  setNumber:      number;
  phase:          PhaseId;
  status:         GameStatus;
  deckCount:      number;             // 枚数のみ
  field:          FieldCard[];
  hand:           CardId[];           // 自分の手札（spectator は空配列）
  handCounts:     Record<PlayerId, number>;
  turnOrder:      PlayerId[];
  currentTurnIndex: number;
  resetCount:     number;
  residualBugs:   BugId[];
  raidState?:     RaidState;
  events:         EventLog[];         // 全イベント履歴
}
visibility: "player"  // 個別にフィルタして送信
```

#### `server:error`
```typescript
payload: {
  code:        ErrorCode;
  message:     string;         // 人間が読めるエラー説明
  detail?:     string;         // デバッグ用詳細
  recoverable: boolean;        // true: 操作を再試行可能、false: ページ遷移が必要
}
visibility: "player"
targetPlayerId: PlayerId   // エラーを起こしたプレイヤーのみ
```

---

## 7. ルール定義 YAML フォーマット仕様

### 7.1 全スキーマ

```yaml
id: string                        # 必須。ルールセット識別子
version: string                   # 必須。セマンティックバージョン
extends: string                   # 任意。継承元ルールセット ID

deck:
  cards:
    - value: integer              # 必須。0〜9
      count: integer              # 必須。1以上

strategies:
  - id: string                    # 必須
    effect:
      id: string                  # 必須。"${ruleSetId}:${camelCaseId}" 形式
      trigger:
        type: string              # 必須。TriggerCondition.type のいずれか
      target:
        type: string              # 必須。TargetDef.type のいずれか
      action:
        type: string              # 必須。EffectAction.type のいずれか
        # action.type に応じた追加フィールド
      constraints:                # 任意
        - type: string
          # constraint.type に応じた追加フィールド
      usageLimit: integer         # 任意。省略で無制限
    exclusionCondition:           # 任意
      type: string
      min: integer

bugs:
  - id: string                    # 必須
    effect:
      id: string
      trigger:
        type: string
      target:
        type: string
      action:
        type: string
      constraints:
        - type: string
    removalCost:
      type: string                # "hp" | "hand_card" | "composite"
      amount: integer             # type="hp" または "hand_card" の場合
      value: string | integer     # type="hand_card" の場合: "even" | "odd" | 数値
      costs:                      # type="composite" の場合
        - type: string
          amount: integer

phases:
  - id: string                    # "normal" | "showdown" | "raid"
    transitionConditions:
      - type: string
        to: string

winCondition:
  winsRequired: integer           # 必須

initialConfig:
  recommendedPlayers: integer     # 必須
  initialHandSize: integer        # 必須
  initialHP: integer              # 必須（レイド戦プレイヤー初期HP）
  setNumberFormula: string        # 必須。例: "gameIndex * 10"
```

### 7.2 basic.yaml の記述例（抜粋）

```yaml
id: basic
version: "1.0.0"

deck:
  cards:
    - value: 0
      count: 2
    - value: 1
      count: 4
    # ... 省略

strategies:
  - id: Aggro
    effect:
      id: "basic:aggro"
      trigger:
        type: on_card_played
      target:
        type: self
      action:
        type: multiply_effective_value
        factor: 2
      constraints:
        - type: usage_limit_per_game
          limit: 0       # 0 = 毎回発動（回数制限なし・常時効果）
      usageLimit: null   # 常時有効

  - id: Control-Add
    effect:
      id: "basic:controlAdd"
      trigger:
        type: on_card_played_by_other
      target:
        type: field_card
      action:
        type: change_operation
        from: sub
        to: add
      constraints:
        - type: usage_limit_per_game
          limit: 1
        - type: no_retroactive
      usageLimit: 1

  - id: Zero
    effect:
      id: "basic:zero"
      trigger:
        type: on_game_start
      target:
        type: hand
      action:
        type: add_card_to_hand
        cardValue: 0
      exclusionCondition:
        type: selection_count_threshold
        min: 2

bugs:
  - id: Odd-Forbidden
    effect:
      id: "basic:oddForbidden"
      trigger:
        type: always
      target:
        type: all_players
      action:
        type: forbid_card_parity
        parity: odd
    removalCost:
      type: hand_card
      value: even
      amount: 1       # 偶数カード1枚（ルール記述は "-3" だが数値調整用にamountで管理）

  - id: Value-Corruption
    effect:
      id: "basic:valueCorruption"
      trigger:
        type: always
      target:
        type: all_players
      action:
        type: override_card_value
        value: 10
    removalCost:
      type: composite
      costs:
        - type: hp
          amount: 1
        - type: hand_card
          value: any
          amount: 1

phases:
  - id: normal
    transitionConditions:
      - type: deck_empty
        to: showdown
      - type: card_zero_played
        to: raid    # プレイヤーが raid を選んだ場合
  - id: showdown
    transitionConditions: []   # 全員提出後に勝者判定
  - id: raid
    transitionConditions:
      - type: boss_hp_zero_or_less
        to: finished
      - type: all_players_hp_zero_or_less
        to: session_win_boss

winCondition:
  winsRequired: 3

initialConfig:
  recommendedPlayers: 4
  initialHandSize: 5
  initialHP: 10
  setNumberFormula: "gameIndex * 10"
```

### 7.3 ルール継承（extends/overrides）の動作仕様

- `extends` が指定された場合、継承元の全フィールドをベースとして読み込む
- `strategies`, `bugs`, `phases` は配列で、同 `id` のエントリが存在する場合は**上書き**、存在しない場合は**追記**
- `winCondition`, `initialConfig`, `deck` はオブジェクト全体を上書き
- 継承元で定義済みの戦略・バグを削除するには `disabled: true` フィールドで明示的に無効化する

### 7.4 YAML バリデーション仕様

起動時（`RuleSetLoader.load()`）に以下を検証する:

| チェック項目 | エラーコード |
|---|---|
| `id`, `version` が存在すること | `RULE_VALIDATION_FAILED` |
| `deck.cards` の `value` が 0〜9 の整数であること | `RULE_VALIDATION_FAILED` |
| `effect.id` が `"{ruleSetId}:{camelCase}"` 形式であること | `RULE_VALIDATION_FAILED` |
| `trigger.type` が定義済み値であること | `RULE_VALIDATION_FAILED` |
| `action.type` が定義済み値であること | `RULE_VALIDATION_FAILED` |
| `extends` で指定したルールセットが存在すること | `RULE_NOT_FOUND` |
| `winCondition.winsRequired` が 1 以上の整数であること | `RULE_VALIDATION_FAILED` |

---

## 8. 効果解決インターフェース仕様

### 8.1 EffectHandler インターフェース

```typescript
// 効果ハンドラのシグネチャ
type EffectHandler = (game: Game, ctx: EffectContext) => GamePatch;

interface EffectContext {
  actorId:      PlayerId;       // 効果を発動したプレイヤー
  triggerCard?: FieldCard;      // on_card_played 系トリガーで出されたカード
  targetId?:    PlayerId | "boss"; // 対象プレイヤー（レイド戦等）
  ruleSet:      RuleSet;
}
```

**`GamePatch` は純粋なデータ差分**であり、副作用を含まない。エンジン側がパッチをゲーム状態にマージする。

### 8.2 EffectRegistry インターフェース

```typescript
interface EffectRegistry {
  register(effectId: EffectId, handler: EffectHandler): void;
  get(effectId: EffectId): EffectHandler | undefined;
  has(effectId: EffectId): boolean;
}
```

- 効果 ID の命名規則: `"{ruleSetId}:{camelCaseEffectName}"` 例: `"basic:aggro"`
- 未登録 ID に対するフォールバック: `GamePatch = {}` を返し `RULE_EFFECT_UNREGISTERED` を `server:error` に記録

### 8.3 効果解決の処理フロー

```
1. ActionValidator.validate(game, action) → 不正なら STOP
2. ArithmeticJudge.resolve(game, card, operation) → ArithmeticResult
3. GamePatch 生成（演算結果の反映）
4. EffectResolver.resolve(game, trigger, ctx)
   a. 全戦略ハンドラを走査し trigger が一致するものを収集
   b. 全バグハンドラを走査し trigger が一致するものを収集
   c. Forbidden 系バグが有効なら対応戦略ハンドラを除外
   d. 各ハンドラを順番に実行し GamePatch を accumulate
5. GameEngine.applyPatch(game, patch) → 新 Game 状態
6. EventLogger.append(game, events)
7. Broadcaster.broadcast(room, serverMessages)
```

**複数効果の解決順序**:
1. 常時発動系バグ（Forbidden 系）の判定（ActionValidator で先行チェック）
2. 戦略効果（自分の効果 → 他プレイヤーの介入効果の順）
3. バグ効果（常時発動系は最後に適用）

**介入効果の任意発動フロー（A1・オーナー裁定）**:

介入系戦略（トリガー `on_card_played_by_other`: Control-Add/Sub/Mul/Div・Hack・
TrickStar）は自動発動しない。カードプレイ時の処理は次の2段階になる。

```
play_card
  1. 自分の戦略効果（on_card_played）を解決
  2. EffectResolver.collectInterventionCandidates で介入候補を列挙
     - トリガー一致・使用回数残あり・Forbidden 非適用・ハンドラ dry-run が
       no-op でない（偶奇・from演算などの条件成立）プレイヤーのみ
     - 候補ゼロ → 待ちなしで従来どおり即続行
  3. 候補あり → game.pendingIntervention を立てて凍結
     - 手番は進まない・補充ドローもしない
     - 各候補者へ server:intervention_offer を個別送信（visibility="player"）
     - 待機中は intervention_response 以外の全アクションを
       ACTION_INTERVENTION_PENDING で拒否

intervention_response（各候補者が accept / pass を返す）
  4. 全候補の応答が揃ったら、accept した介入を候補順に解決
     - 候補順 = 手番順（actor の次の席から時計回り）
     - 先行介入で対象が消えた後続介入は no-op（発動権は消費しない）
  5. 解決後に通常の継続処理: Aggro バースト判定 → 0カード待ち →
     setNumber==0 勝利 → 補充ドロー → 手番前進 → フェーズ遷移

タイムアウト（サーバ権威・DO アラーム）
  - 応答期限は rules/*.yaml の timeouts.intervention（basic: 5000ms）。
    全候補で1本の共通期限（誰かの応答で延長しない）
  - 無応答はパス扱い: 発動せず、1ゲーム1回の発動権も消費しない
    （トリガー不成立として温存。ルール文書に「見送りで権利消費」の規定は
    ないためこの裁定を採用）
  - クライアントのカウントダウンは表示用（サーバ側期限が正）

情報の可視性: オファーは候補者本人のみに届く。他プレイヤーには
server:action_result の `interventionPending: boolean` のみ通知し、
「誰が発動権を持つか」（＝非公開の戦略情報）は漏らさない。候補列挙時に
Forbidden で除外されたプレイヤーの strategy_invalidated イベントも記録しない
（発動試行ではないため）。

なお Aggro（`on_card_played`・自分）と Zero（`on_game_start`）は従来どおり
自動発動のまま。

**Forbidden 系バグと戦略の相互作用**:
- `Control-Forbidden` が有効: `EffectResolver` で Control 系ハンドラを呼び出す前に除外
- `Aggro-Forbidden` が有効: Aggro ハンドラを呼び出す前に除外
- 除外した場合は `strategy_invalidated` イベントを記録

### 8.4 各戦略カード効果の詳細仕様

#### Aggro (`basic:aggro`)
- **トリガー**: `on_card_played`（自分がカードを出した時）
- **処理**: `fieldCard.effectiveValue = fieldCard.rawValue * 2`
- **マイナス判定（バースト）**: アクション適用後に `game.setNumber < 0` かつ Aggro プレイヤーが原因の場合、そのプレイヤーは**敗北して脱落**する（この時点では勝者は決まらない）。処理内容:
  - バーストしたプレイヤーを `turnOrder` から除外し、手札をクリアする（`player_eliminated` イベントを記録）
  - バーストの原因カードを場から取り除いて `excludedCards` へ移し、`setNumber` をカードプレイ前の値に巻き戻す
  - 生存者が2人以上ならゲームは**続行**する
  - 生存者が1人になった場合のみ、その1人が勝利してゲーム終了（`game.status = "finished"`, `winnerId` = 最後の生存者, reason = `last_player_standing`）
  - ※ Aggro 以外のプレイヤーが `setNumber` を負にするのは合法で、ゲームは通常どおり続行する
- **Aggro-Forbidden との相互作用**: バグ有効時はハンドラをスキップし `effectiveValue = rawValue`

#### Control-Add / Control-Sub (`basic:controlAdd` 等)
- **トリガー**: `on_card_played_by_other`（他プレイヤーがカードを出した時）
- **発動方式**: 任意発動（A1）。トリガー成立時にオファーが届き、accept した場合のみ発動。pass/タイムアウトは発動権を消費しない
- **タイミング**: カードが場に出た直後・演算適用前に発動可能
- **遡及禁止**: `game.field` の最新カード（= 今出たカード）にのみ適用可能
- **使用回数**: `game.usedStrategyCounts[actorId]["Control-Add"]` で管理。1 以上なら `ACTION_USAGE_LIMIT_EXCEEDED`
- **処理**: `fieldCard.operation` を `from` から `to` へ変更 → `ArithmeticJudge` を再計算

#### Hack (`basic:hack`)
- **トリガー**: `on_card_played_by_other`（偶数カードが出た時）
- **発動方式**: 任意発動（A1・オファー方式。Control 系と同じ）
- **条件**: `triggerCard.rawValue % 2 === 0`
- **処理**: `fieldCard.playerId = actorId`（所有権移転）、`effectiveValue` を Hack 発動者の戦略で再計算
- **結果**: セット数への影響は変わらないが、**決戦フェーズ・レイド戦での有利不利**に影響

#### TrickStar (`basic:trickStar`)
- **トリガー**: `on_card_played_by_other`（奇数カードが出た時）
- **発動方式**: 任意発動（A1・オファー方式。Control 系と同じ）
- **条件**: `triggerCard.rawValue % 2 !== 0`
- **処理**: `fieldCard` を `game.field` から削除し `game.excludedCards` へ追加、演算を取り消し（setNumber を元に戻す）

#### Zero (`basic:zero`)
- **トリガー**: `on_game_start`
- **処理**: 山札から 0 のカードを 1 枚取り出し `game.hands[actorId]` に追加
- **無効化条件**: セッション内で Zero を選んだプレイヤーが 2 人以上の場合、全員の Zero を無効化（`strategy_invalidated` イベントを記録）
- **無効化判定タイミング**: `game` 開始時（`on_game_start` トリガー処理前）

### 8.5 各バグカード効果の詳細仕様

#### Odd-Forbidden / Even-Forbidden
- **トリガー**: `always`
- **処理**: `ActionValidator` で `card.value % 2 === parity` のカードを `ACTION_BUG_FORBIDDEN` エラーで拒否
- **除去コスト**: 偶数（Odd-Forbidden）または奇数（Even-Forbidden）手札カード1枚を `game.excludedCards` へ移動

#### Stack-Forbidden
- **処理**: `ActionValidator` で `card.rawValue === field[-1].rawValue` の場合 `ACTION_BUG_FORBIDDEN` エラー
- **除去コスト**: HP -3（`raidState.playerHPs[actorId] -= 3`）

#### Aggro/Control/Hack/TrickStar-Forbidden
- **処理**: `EffectResolver` で対応する戦略ハンドラを除外（ハンドラが呼ばれない）
- **除去コスト**: HP -3

#### Value-Corruption
- **処理**: 全カードの `effectiveValue` を 10 として扱う（`on_card_played` トリガーで上書き）
  - ただしレイド戦 HP 算出時は `rawValue` を参照（場のカード合計は額面値で計算）
- **残留**: ボスHP が 0 未満になった場合、このバグが `game.residualBugs` に追加される
- **除去コスト**: HP -1 かつ 任意手札カード 1 枚（composite コスト）

---

## 9. 永続化方針（Durable Objects 設計）

### 9.1 Durable Object の立て方

**Room 単位**で 1 つの Durable Object を立てる。

理由:
- WebSocket 接続管理とゲーム状態が同一 Room に属するため同居が自然
- Game は Session に包含され Session は Room に属するため、Room DO に全状態を持たせることで Stub 呼び出しを最小化できる
- Cloudflare Workers の Durable Objects は 1 インスタンス = 1 WebSocket ハブとして機能する

### 9.2 RoomDurableObject クラス設計

```typescript
export class RoomDurableObject implements DurableObject {
  private state:   DurableObjectState;
  private env:     Env;
  private connections: Map<string, WebSocket>; // connectionId → WebSocket
  private playerConnections: Map<PlayerId, string>; // playerId → connectionId
  private seenMessageIds: Set<MessageId>; // 重複検知（TTL 60秒）

  // 永続化ストレージ（DurableObject Storage API）
  // キー: "room"           値: Room
  // キー: "session"        値: Session | null
  // キー: "game:{gameId}"  値: Game
  // キー: "seen_msgs"      値: { id: MessageId, expiry: number }[]

  async fetch(request: Request): Promise<Response> {
    // WebSocket upgrade 処理
  }

  async webSocketMessage(ws: WebSocket, message: string): Promise<void> {
    // MessageRouter に委譲
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // ConnectionManager に委譲
  }
}
```

### 9.3 ストレージキー設計

| キー | 値の型 | 説明 |
|---|---|---|
| `"room"` | `Room` | ルーム状態 |
| `"session"` | `Session \| null` | 現在のセッション |
| `"game:{gameId}"` | `Game` | ゲーム状態（ゲームごとに独立保存） |
| `"seen_msgs"` | `{ id: MessageId; expiry: number }[]` | 重複検知用メッセージID一覧 |

**保存タイミング**: 各行動適用後（`applyAction` 完了後）に即時保存。

### 9.4 WebSocket 接続管理との統合

```typescript
// 接続確立時
connectionId = crypto.randomUUID();
connections.set(connectionId, ws);
// 参加メッセージ受信後
playerConnections.set(playerId, connectionId);

// 切断時
connectionId = findConnectionId(ws);
playerConnections.delete(playerId);
connections.delete(connectionId);
// プレイヤーの connectionStatus を "disconnected" に更新して全員に server:room_updated
```

### 9.5 再接続・状態復旧フロー

```
1. クライアントが WebSocket 再接続
2. client:join_room を同じ playerId で送信
3. ConnectionManager が playerConnections を照合
   → 既存 playerId なら再参加として処理
4. game.hands[playerId] の内容を server:state_sync で送信
   （GameView を生成: 手札は本人のみ、他は枚数のみ）
5. クライアントが state_sync を受信して画面を現在状態に復元
```

### 9.6 seen_msgs の管理

- `seen_msgs` に `{ id, expiry: Date.now() + 60000 }` を追加
- メッセージ受信時に expired なエントリを削除してから重複チェック
- 重複検知時は `server:error (WS_DUPLICATE_MESSAGE, recoverable: true)` を返す

### 9.7 データ削除方針

- セッション終了後、`session` キーを `null` に更新（上書き）
- ゲームデータ（`game:{gameId}`）はセッション終了後 24 時間保持してから削除（Alarm API 使用）
- ルーム解散時に全キーを削除

---

## 10. エラーコード定義

### 10.1 エラーコード体系

```typescript
type ErrorCode = string; // "{PREFIX}_{SCREAMING_SNAKE_CASE}"

// server:error ペイロード
interface ErrorPayload {
  code:        ErrorCode;
  message:     string;      // 日本語の人間向け説明
  detail?:     string;      // デバッグ用詳細（開発時のみ）
  recoverable: boolean;     // true: 再試行可, false: ページ遷移が必要
}
```

### 10.2 エラーコード一覧

#### ルーム系 `ROOM_`

| コード | 説明 | recoverable |
|---|---|---|
| `ROOM_NOT_FOUND` | ルーム ID が存在しない | false |
| `ROOM_FULL` | 参加人数上限に達している | false |
| `ROOM_ALREADY_STARTED` | セッション開始済みで参加不可 | false |
| `ROOM_HOST_REQUIRED` | ホストのみ実行可能な操作 | true |
| `ROOM_NOT_ALL_READY` | 全員が準備完了していない | true |

#### セッション系 `SESSION_`

| コード | 説明 | recoverable |
|---|---|---|
| `SESSION_INVALID_STRATEGY` | 存在しない strategyId | true |
| `SESSION_STRATEGY_NOT_SELECTED` | 戦略未選択で開始しようとした | true |
| `SESSION_NOT_IN_PROGRESS` | セッションが進行中でない | false |

#### アクション系 `ACTION_`

| コード | 説明 | recoverable |
|---|---|---|
| `ACTION_NOT_YOUR_TURN` | 手番でないプレイヤーの操作 | true |
| `ACTION_INVALID_CARD` | 手札に存在しないカード | true |
| `ACTION_INVALID_OPERATION` | 演算条件を満たさない（乗除算の制約違反） | true |
| `ACTION_HAND_EMPTY` | 手札が空でカードを出せない | true |
| `ACTION_HAND_FULL` | 手札が 5 枚で補充できない | true |
| `ACTION_BUG_FORBIDDEN` | バグ効果によりカード使用禁止 | true |
| `ACTION_USAGE_LIMIT_EXCEEDED` | 戦略効果の使用回数上限超過 | true |
| `ACTION_RESET_LIMIT_EXCEEDED` | リセット可能回数（2 回）を超過 | true |
| `ACTION_INVALID_BUG_REMOVAL_COST` | 除去コストを支払えない | true |
| `ACTION_INVALID_PHASE` | 現在のフェーズで許可されていない操作 | true |
| `ACTION_INTERVENTION_PENDING` | 介入オファーの応答待ち中は他のアクション不可（A1） | true |
| `ACTION_NO_PENDING_INTERVENTION` | オファーが無い/対象外なのに intervention_response を送信 | true |

#### WebSocket 系 `WS_`

| コード | 説明 | recoverable |
|---|---|---|
| `WS_DUPLICATE_MESSAGE` | 同一 MessageId のメッセージを重複受信 | true |
| `WS_AUTH_FAILED` | senderId が不正（ルーム内に存在しない） | false |
| `WS_RECONNECT_FAILED` | 再接続に失敗（ルームが解散済み等） | false |

#### ルール系 `RULE_`

| コード | 説明 | recoverable |
|---|---|---|
| `RULE_NOT_FOUND` | 指定の ruleSetId が存在しない | false |
| `RULE_VALIDATION_FAILED` | YAML バリデーション失敗 | false |
| `RULE_EFFECT_UNREGISTERED` | 効果 ID に対応するハンドラが未登録 | false |

### 10.3 クライアント側エラー表示方針

| recoverable | 表示方法 | 動作 |
|---|---|---|
| `true` | トースト通知（3 秒で自動消去） | 操作を再試行可能 |
| `false` | モーダル | ユーザーが確認後、トップ画面へ遷移 |
| `WS_RECONNECT_FAILED` | 再接続インジケーター | 自動再試行（最大 3 回）、失敗でモーダル |

---

## 11. テスト戦略詳細

### 11.1 テストレイヤー構成

| レイヤー | 対象 | 境界 |
|---|---|---|
| unit | 純粋関数・クラスの単一メソッド | 外部依存なし（モック不要） |
| integration | モジュール間の連携・Durable Objects 読み書き | WebSocket は除く |
| scenario | `applyAction` 連続適用による E2E ゲーム進行 | サーバ側ロジックのみ |
| e2e | WebSocket 接続を含む実通信テスト | Miniflare または実 Workers 環境 |

### 11.2 単体テスト：ArithmeticJudge

```typescript
describe("ArithmeticJudge", () => {
  // 加算（常に可能）
  test("加算: setNumber=10, card=3 → 13");
  test("減算: setNumber=10, card=3 → 7");
  // 乗算・除算（直前カードと同値の場合のみ）
  test("乗算: 直前カードが3, 出すカードが3 → 可能");
  test("乗算: 直前カードが3, 出すカードが4 → ACTION_INVALID_OPERATION");
  test("除算: 端数切り上げ。setNumber=10, card=3 → ceil(10/3) = 4");
  test("除算: setNumber=7, card=2 → ceil(7/2) = 4");
  // Aggro 適用後
  test("Aggro有効: card=3 → effectiveValue=6 で計算");
  // Aggro マイナス敗北（バースト脱落）
  test("Aggro有効かつ結果がマイナス: Aggroプレイヤーが脱落しゲームは続行する（生存者1人なら勝利確定）");
  // Value-Corruption 適用後
  test("Value-Corruption有効: card=3 → effectiveValue=10 で計算");
});
```

### 11.3 単体テスト：ActionValidator

各 `ErrorCode` に対応する入力パターンを 1 テストずつ用意:
- `ACTION_NOT_YOUR_TURN`: 手番でないプレイヤーの action
- `ACTION_INVALID_CARD`: hands に存在しないカード ID
- `ACTION_INVALID_OPERATION`: 前のカードと異なる値での乗算
- `ACTION_HAND_FULL`: 手札 5 枚での draw_card
- `ACTION_BUG_FORBIDDEN`: Odd-Forbidden 発動中に奇数カードを出す
- `ACTION_USAGE_LIMIT_EXCEEDED`: Control-Add を 2 回目に使用

### 11.4 単体テスト：効果ハンドラ

各ハンドラで最低限以下を検証:

| ハンドラ | テストケース |
|---|---|
| aggro | effectiveValue が 2 倍になること |
| aggro | マイナスになった場合にプレイヤーが脱落しゲームが続行すること（GameEngine のバースト分岐との結合） |
| controlAdd | fieldCard.operation が sub → add に変わること |
| controlAdd | 2 回目の使用で usedStrategyCounts の値が上限に達していること（Validator との結合） |
| hack | fieldCard.playerId が奪ったプレイヤーに変わること |
| hack | 奇数カードには発動しないこと |
| trickStar | field から対象カードが消えること、setNumber が元に戻ること |
| trickStar | 偶数カードには発動しないこと |
| zero | hands に value=0 のカードが追加されること |
| zero | 3 人以上選択時に strategy_invalidated イベントが返ること |
| oddForbidden | 奇数カードを出した時に空 GamePatch を返し Validator でエラーになること |
| valueCorruption | effectiveValue が 10 になること |
| valueCorruption | レイド戦 HP 算出時は rawValue を参照すること |

### 11.5 シナリオテスト

各シナリオは `applyAction()` を連続呼び出しし、最終的なゲーム状態を検証する。

#### 通常勝利シナリオ
```
gameIndex=1, setNumber=10
P1: play_card(5, sub) → setNumber=5
P2: play_card(3, sub) → setNumber=2
P3: play_card(2, sub) → setNumber=0
→ WinResult(set_number_zero, winnerId=P3)
```

#### 決戦フェーズ移行シナリオ
```
山札を枯渇させた後
→ phase="showdown"
各プレイヤーが2枚選出・演算提出
→ 最もsetNumberに近いプレイヤーが勝利
同値の場合: 枚数の少ない方、さらに同じなら全員が勝利
```

#### レイド戦: ボスHP ちょうど 0 シナリオ
```
P1が0カードを出す → choice=raid
bossHP = 場のカード合計（額面値）
プレイヤーたちがカードを出してbossHP=0にする
→ WinResult(raid_boss_hp_exact_zero, winnerIds=[P2, P3, P4])
→ 全生存プレイヤーの wins +1
```

#### レイド戦: ボスHP 0 未満（バグ残留）シナリオ
```
P4（ボス）が Value-Corruption を選択
プレイヤーたちがボスHPを 0 未満に
→ WinResult(raid_boss_hp_below_zero, winnerId=トドメ刺したプレイヤー)
→ game.residualBugs に "Value-Corruption" が追加される
→ 次ゲーム開始時に Value-Corruption が適用される
```

#### バグ残留シナリオ
```
前ゲームで residualBugs=["Value-Corruption"] が設定された状態で次ゲーム開始
→ on_game_start トリガーで Value-Corruption が発動（全カードeffectiveValue=10）
→ バグ除去はできない（残留バグは除去不可）
→ 1ゲーム後に residualBugs がクリアされる
```

#### ゲーム外交渉記録シナリオ
```
P1 が ChatArea に「このセッションの後ご飯を奢る」と送信
→ サーバ側で EventLogger に type="illegal_negotiation_flagged" を記録
→ 全員に EventLog として配信（将来的な裁定のための記録）
```

### 11.6 結合テスト

```typescript
describe("WebSocket 切断・再接続", () => {
  test("切断後に再接続した場合、state_sync で最新状態が復元される");
  test("手札情報は本人の state_sync のみに含まれる");
  test("観戦者の state_sync には手札が含まれない");
});

describe("重複送信", () => {
  test("同一 MessageId を 2 回送信すると 2 回目は WS_DUPLICATE_MESSAGE");
  test("60 秒後に同一 MessageId を送信すると正常処理される");
});
```

### 11.7 回帰テスト方針

新ルールセット追加・既存ルール変更時:
1. `test/scenario/` の全 `basic` シナリオテストを再実行
2. `test/unit/` の `RuleSetLoader.test.ts` でバリデーション通過を確認
3. 新ルールの効果ハンドラが既存の `EffectRegistry` に影響しないことを確認

CI パイプライン（例: GitHub Actions）で:
- `push` / `pull_request` 時に unit + integration + scenario テストを自動実行
- e2e テストはリリース前のみ実行
