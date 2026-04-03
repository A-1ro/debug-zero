# #19 ユニットテストの実装

> 作成日: 2026-04-03

## 実装意図

`ArithmeticJudge` / `ActionValidator` / `PhaseController` の純粋関数を中心にユニットテストを実装する。これらはすべて副作用のない純関数であるため、テストの記述・実行が容易。

## 合意した前提

- [YES] vitest を devDependency として追加する（現在 package.json に未記載）
- [YES] `vitest.config.ts` を新規作成する。`@cloudflare/vite-plugin` は Cloudflare Workers 用のため vitest では外す
- [YES] `package.json` に `"test": "vitest run"` と `"test:watch": "vitest"` を追加する
- [YES] `test/unit/ArithmeticJudge.test.ts` — `canApplyOperation` と `resolve` の全ケース
- [YES] `test/unit/ActionValidator.test.ts` — play_card / draw_card / remove_bug / reset_or_raid / select_strategy の各バリデーション
- [YES] `test/unit/PhaseController.test.ts` — `checkPhaseTransition` / `resolveZeroCardTransition` / `isTerminalTransition` / `isPhaseTransition`
- [YES] EffectRegistry handlers（16個）と RuleSetLoader は今回スコープ外（YAML 依存と handler 網羅は #20 統合テストで扱う）
- [YES] `Game` / `RuleSet` 等の fixture は各テストファイル内にインラインで定義する（共通 fixture ファイルは作らない）
- [YES] RuleSet は `ruleSet.initialConfig.initialHandSize` など最小限のフィールドだけ持つ最小オブジェクトを使う

## 非対応事項

- EffectRegistry handlers 個別テスト（#20 で対応）
- RuleSetLoader（YAML パース）のテスト（#20 で対応）
- カバレッジレポートの設定

## リスクメモ

- `@cloudflare/vite-plugin` が vite.config.ts にある状態で vitest が動くか確認が必要 → vitest.config.ts を独立させて回避する
