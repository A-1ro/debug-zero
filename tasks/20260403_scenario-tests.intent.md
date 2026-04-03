# #20 シナリオ／統合テストの実装

> 作成日: 2026-04-03

## 実装意図

`applyAction()` を連続呼び出しするシナリオテストと、効果ハンドラ・RuleSetLoader の統合テストを実装する。GameEngine と SessionService を実際に動かし、ゲーム進行の正しさを端から端まで検証する。

## 合意した前提

- [YES] `test/scenario/` — GameEngine を通じた `applyAction()` 連続実行シナリオ
- [YES] `test/integration/effects/` — 各 EffectHandler の統合テスト（#19 から持ち越し）
- [YES] `test/integration/RuleSetLoader.test.ts` — basic.yaml を実際にパースして検証
- [YES] 通常勝利シナリオ — `applyAction` でsetNumber → 0 → WinResult
- [YES] 決戦フェーズ移行シナリオ — デッキ枯渇 → phase="showdown"
- [YES] レイド戦: bossHP ちょうど 0 シナリオ — raidState のセットアップ検証
- [YES] バグ残留シナリオ — SessionService.startNextGame() で residualBugs が次ゲームに引き継がれる
- [YES] レイド戦 bossHP 0 未満（Value-Corruption 残留）と外交渉記録シナリオは今回スコープ外
- [YES] 効果ハンドラテスト: aggro / controlAdd / hack / valueCorruption（4件）
- [YES] `rules/basic.yaml` を `loadFromFile()` でパースして件数・IDを検証
- [YES] WebSocket / Durable Objects 統合テストはスコープ外（e2e 扱い）
- [YES] `applyAction()` は `Game` を返す（win = game.status==="finished" && game.winnerId）

## 非対応事項

- レイド戦 bossHP 0 未満（Value-Corruption 残留）シナリオ
- 外交渉記録シナリオ
- WebSocket / Durable Objects 統合テスト（e2e）

## リスクメモ

- RuleSetLoader が globalRuleSetRegistry に書き込む設計のため、テスト間で状態が共有される可能性あり → `beforeAll` で一度だけロードする
