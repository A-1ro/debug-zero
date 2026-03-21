# tasks.md — DEBUG-ZERO 実装タスク一覧

実装タスクを優先フェーズ順に記載する。
着手前に依存タスクが完了していることを確認すること。

## 進捗サマリー

- [x] #1 共有型定義の実装 (shared/types/)
- [x] #2 RuleSetLoader / RuleSetRegistry の実装
- [x] #3 ArithmeticJudge の実装
- [x] #4 ActionValidator の実装
- [ ] #5 TurnManager / PhaseController の実装
- [ ] #6 GameEngine (applyAction) の実装
- [ ] #7 EffectRegistry / EffectResolver の実装
- [ ] #8 戦略カード効果ハンドラの実装 (8種)
- [ ] #9 バグカード効果ハンドラの実装 (8種)
- [ ] #10 RoomRepository / RoomService の実装
- [ ] #11 SessionService の実装
- [ ] #12 WebSocket 基盤の実装
- [ ] #13 Hono サーバエントリポイントの実装
- [ ] #14 クライアント基盤の実装
- [ ] #15 TopView の実装
- [ ] #16 RoomView (ロビー) の実装
- [ ] #17 GameBoard コンポーネント群の実装
- [ ] #18 ResultView の実装
- [ ] #19 ユニットテストの実装
- [ ] #20 シナリオ・インテグレーションテストの実装

---

## Phase 1: 基盤

### [ ] #1 共有型定義の実装 (shared/types/)

**依存:** なし

detail-design.md 第3章をもとに以下ファイルを実装する:

- `src/shared/types/domain.ts` — Game, Session, Player, Card, FieldCard, RaidState 等のドメイン型
- `src/shared/types/messages.ts` — ClientMessage, ServerMessage, 全メッセージ型 (第6章)
- `src/shared/types/rules.ts` — RuleSet, PhaseDef, CardDef 等のルール定義型 (第7章)
- `src/shared/types/effects.ts` — EffectHandler, EffectContext, GamePatch 型 (第8章)
- `src/shared/constants.ts` — エラーコード定数 (第10章)

純粋な型定義のみ。実装ロジックは含めない。

---

### [ ] #2 RuleSetLoader / RuleSetRegistry の実装

**依存:** #1

- `src/server/rules/RuleSetLoader.ts` — YAML読み込み・パース・バリデーション。起動時に呼び出す
- `src/server/rules/RuleSetRegistry.ts` — 複数ルールセットの登録・`get(id)` で取得

`rules/basic.yaml` のフォーマットは detail-design.md 第7章に準拠。
YAMLパーサーは js-yaml 等を使用する。

---

## Phase 2: ゲームエンジン

### [x] #3 ArithmeticJudge の実装

**依存:** #1

`src/server/game/ArithmeticJudge.ts` を純粋関数として実装。

裁定ルール:

- 加算・減算: 常に可能
- 乗算・除算: `field[-1].rawValue === card.value` の場合のみ可能
- 除算端数: `Math.ceil`（常に切り上げ）
- Aggro効果が有効な場合: `effectiveValue = rawValue * 2` で計算
- 結果がマイナスになった場合: 即時敗北フラグを立てる

---

### [x] #4 ActionValidator の実装

**依存:** #1, #3

`src/server/game/ActionValidator.ts` を実装。

検証項目:

- 手番プレイヤーかどうか
- 手札にカードが存在するか
- 算術裁定 (ArithmeticJudge を呼び出す)
- バグ制約 (奇数禁止・偶数禁止・スタック禁止等) への準拠
- パス・サレンダー等の特殊アクション検証

エラーコードは `constants.ts` の `ACTION_*` を使用。

---

### [ ] #5 TurnManager / PhaseController の実装

**依存:** #1, #2

- `src/server/game/TurnManager.ts` — 次の手番プレイヤーを返す。スキップ禁止ルールを考慮
- `src/server/game/PhaseController.ts` — フェーズ遷移制御。`PhaseDef.transitionConditions` を参照して遷移を判定（条件をエンジン本体に埋め込まない）

フェーズ状態機械:

```
[normal]
  ├─ 山札が尽きた                → [showdown]
  ├─ 0カードが出された（reset選択）→ [normal] リセット
  └─ 0カードが出された（raid選択） → [raid]

[showdown] → 勝者確定 → ゲーム終了
[raid]
  ├─ bossHP <= 0     → ゲーム終了（勝者判定）
  └─ 全プレイヤーHP <= 0 → ボスがセッション勝利
```

---

### [ ] #6 GameEngine (applyAction) の実装

**依存:** #1, #3, #4, #5, #7

`src/server/game/GameEngine.ts` を実装。ゲームの中核。

- `applyAction(game: Game, action: Action): Game` — 副作用なし純粋関数
- ActionValidator → ArithmeticJudge → EffectResolver → TurnManager → PhaseController の順に呼び出す
- EffectHandler が返す GamePatch を現在の Game にマージして新 Game を生成
- `appendEvents` は置換ではなく追記
- visibility制御は Broadcaster 層で行う（GameEngine には含めない）

detail-design.md 第4章・第5章を参照。

---

## Phase 3: 効果システム

### [ ] #7 EffectRegistry / EffectResolver の実装

**依存:** #1

- `src/server/effects/EffectRegistry.ts` — 効果IDとEffectHandlerのマッピング管理
- `src/server/effects/EffectResolver.ts` — トリガー→ハンドラ呼び出し→GamePatch生成の統括

```typescript
type EffectHandler = (game: Game, ctx: EffectContext) => GamePatch;
interface EffectContext { actorId: string; triggerCard?: FieldCard; targetId?: string; }
```

新ハンドラ追加時は EffectRegistry への登録のみで他は変更不要な設計にする。

---

### [ ] #8 戦略カード効果ハンドラの実装 (8種)

**依存:** #7

`src/server/effects/handlers/strategies/` 以下に1ファイル1ハンドラで実装:

| ファイル | 効果 |
|---|---|
| `aggro.ts` | Aggro効果 (effectiveValue = rawValue * 2) |
| `controlAdd.ts` | 加算制御 |
| `controlSub.ts` | 減算制御 |
| `controlDiv.ts` | 除算制御 |
| `controlMul.ts` | 乗算制御 |
| `hack.ts` | Hack効果 |
| `trickStar.ts` | TrickStar効果 |
| `zero.ts` | 0カード効果 (reset/raid選択トリガー) |

各効果の詳細仕様は detail-design.md 第8章を参照。

---

### [ ] #9 バグカード効果ハンドラの実装 (8種)

**依存:** #7

`src/server/effects/handlers/bugs/` 以下に実装:

| ファイル | 効果 |
|---|---|
| `oddForbidden.ts` | 奇数カード禁止 |
| `evenForbidden.ts` | 偶数カード禁止 |
| `stackForbidden.ts` | スタック禁止 |
| `aggroForbidden.ts` | Aggro使用禁止 |
| `controlForbidden.ts` | Control系使用禁止 |
| `hackForbidden.ts` | Hack使用禁止 |
| `trickStarForbidden.ts` | TrickStar使用禁止 |
| `valueCorruption.ts` | Value-Corruption (HP算出には rawValue を使うこと) |

バグ残留ルール: 次ゲームで発動し1ゲーム後クリア。

---

## Phase 4: サーバ基盤

### [ ] #10 RoomRepository / RoomService の実装

**依存:** #1

- `src/server/room/RoomRepository.ts` — ルーム状態のメモリ保持・取得
- `src/server/room/RoomService.ts` — createRoom / joinRoom (4人上限) / leaveRoom (ホスト引き継ぎ) / disbandRoom

エラーコードは `ROOM_*` を使用。

---

### [ ] #11 SessionService の実装

**依存:** #1, #6, #10

`src/server/session/SessionService.ts` を実装:

- `startSession` — セッション開始・デッキ生成・初期配布
- `endGame` — ゲーム終了・勝利数集計・バグ残留を次ゲームへ引き継ぎ
- `endSession` — セッション終了・全員の戦略公開
- `getStandings` — スコア集計

エラーコードは `SESSION_*` を使用。

---

### [ ] #12 WebSocket 基盤の実装 (ConnectionManager / Broadcaster / MessageRouter)

**依存:** #1, #10, #11

`src/server/ws/` 以下:

- `ConnectionManager.ts` — 接続IDとプレイヤーIDのマッピング。再接続フロー: 同じplayerIdで join_room 再送 → `server:state_sync` 返却
- `Broadcaster.ts` — visibility: "all" / "player" / "spectator" に応じた送信
- `MessageRouter.ts` — 受信メッセージを各サービスにルーティング。`seen_msgs` で重複検知 (60秒保持)

`src/server/log/` も実装:

- `EventLogger.ts` — イベントを Game に追記
- `LogQuery.ts` — 履歴取得・フィルタ

---

### [ ] #13 Hono サーバエントリポイントの実装

**依存:** #12

`src/server/index.ts` を実装:

- Hono ルーティング設定
- WebSocket エンドポイント (`/ws`)
- 起動時に `RuleSetLoader` を呼び出し
- Cloudflare Workers 対応 (wrangler.toml 確認・設定)
- 現在の `src/index.tsx` を整理してサーバ・クライアントエントリを分離

---

## Phase 5: クライアント

### [ ] #14 クライアント基盤の実装 (ルーティング・WebSocket Hook)

**依存:** #1

`src/client/` の基盤を実装:

- `main.tsx` — React エントリポイント・ルーティング設定
  - `/` → TopView
  - `/room/:id` → RoomView
  - `/room/:id/game` → SessionView
  - `/room/:id/result` → ResultView
- `hooks/useWebSocket.ts` — WebSocket接続・メッセージ受信・再接続ロジック
- `hooks/useGameState.ts` — サーバから受信した状態をそのまま保持（クライアント側の判定は補助のみ）

---

### [ ] #15 TopView の実装 (`/`)

**依存:** #14

`src/client/views/TopView.tsx` を実装。デザイン: `docs/design/01-top.html` 参照。

- ヒーロータイトル (72px, --cyan グロウ)
- 2カラムパネル: Create Room / Join Room
- Info strip (3カラム: Players / Win Condition / Cards)
- パネル角飾り (L字ボーダー)

送信: `client:create_room` / `client:join_room`
エラー: `ROOM_*` をトースト表示

---

### [ ] #16 RoomView (ロビー) の実装 (`/room/:id`)

**依存:** #14

`src/client/views/RoomView.tsx` を実装。デザイン: `docs/design/02-room-lobby.html` 参照。

- 2カラムレイアウト (1fr 360px)
- プレイヤースロット 2×2グリッド (self=cyan、空席=dashed)
- 戦略グリッド 4×2 (8種)。他プレイヤーには `???` 表示
- 右カラム: ルームステータス・レディ進捗バー・アクションボタン・アクティビティログ

送信: `client:select_strategy` / `client:ready` / `client:start_session`

---

### [ ] #17 GameBoard コンポーネント群の実装

**依存:** #14

`src/client/components/` 以下を実装。デザイン: `docs/design/03-game-board.html` 参照。

3カラムレイアウト (220px 1fr 260px):

| コンポーネント | 役割 |
|---|---|
| `PlayerList.tsx` | 左パネル。手番中=green左ボーダー、勝利数pip、バグチップ、山札残数 |
| `PhaseDisplay.tsx` | フェーズチップ (normal=cyan / showdown=amber / raid=red) |
| `TurnIndicator.tsx` | 手番プレイヤー表示 |
| `SetNumberDisplay.tsx` | セット数表示 |
| `FieldDisplay.tsx` | カード (60×84px)。最新=cyanグロウ、0カード=redグロウ、op-sym |
| `HandDisplay.tsx` | 手札 (56×78px)。hover=translateY(-6px) |
| `ActionPanel.tsx` | 演算子選択。乗除算は条件不一致時 opacity:0.2 |
| `BugDisplay.tsx` | 残留バグ表示・除去ボタン |
| `EventLogPanel.tsx` | スクロール可能ログ |
| `ChatArea.tsx` | Negotiation/Chat 入力欄 |

`SessionView.tsx` で GameBoard を包含する。

---

### [ ] #18 ResultView の実装 (`/room/:id/result`)

**依存:** #14

`src/client/views/ResultView.tsx` を実装。デザイン: `docs/design/04-result.html` 参照。

- 勝者名 (64px, nameGlow アニメーション)
- 四隅 L字コーナー装飾 (--cyan)
- 背景 radial-gradient + winnerPulse アニメーション
- スコアボード 6カラムグリッド (# / Player / Wins / Games / Pips / badge)
- セッション終了後: 全員の戦略が公開 (--amber 表示)
- ↺ REMATCH (cyan) / ✕ DISBAND ROOM (ghost → hover red)

---

## Phase 6: テスト

### [ ] #19 ユニットテストの実装

**依存:** #3, #4, #5, #8, #9

`test/unit/` 以下:

- `ArithmeticJudge.test.ts` — 四則演算裁定の全ケース
- `ActionValidator.test.ts` — 各バグ制約・不正操作の検証
- `PhaseController.test.ts` — フェーズ遷移条件の全パターン
- `effects/` — 各 EffectHandler の単体テスト (16ハンドラ分)
- `RuleSetLoader.test.ts` — YAML パース・バリデーション通過確認

---

### [ ] #20 シナリオ・インテグレーションテストの実装

**依存:** #6, #11, #12

`test/scenario/` 以下 (`applyAction()` の連続呼び出しで検証):

| ファイル | 内容 |
|---|---|
| `normalWin.test.ts` | セット数を0にして通常勝利 |
| `showdown.test.ts` | 山札枯渇→決戦フェーズ→最近値プレイヤー勝利 |
| `raidBossWin.test.ts` | ボスHP=0でプレイヤー側勝利 (生存者全員+1) |
| `raidPlayerWin.test.ts` | 全プレイヤーHP=0でボスがセッション勝利 |
| `bugResidual.test.ts` | バグ残留→次ゲームで発動→1ゲーム後クリア |
| `illegalNegotiation.test.ts` | ゲーム外交渉が illegal_negotiation_flagged として記録される |

`test/integration/`:

- `ws-reconnect.test.ts` — 再接続フロー検証
