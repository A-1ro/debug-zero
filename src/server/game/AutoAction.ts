import type { Game, Action, PlayerId, CardId } from "../../shared/types/domain";
import type { RuleSet } from "../../shared/types/rules";
import { raidActor } from "./TurnManager";
import { isRaidCardPlayable, affordableRaidRemoval } from "./ActionValidator";

// ============================================================
// AutoAction — 手番タイムアウト時にサーバが代打で選ぶ「安全な一手」
// ============================================================
//
// 純粋関数。タイムアウトしたプレイヤーが打つべき無難なアクションを返す。
// 方針: ゲームを進めることを最優先し、勝敗を賭けにいかない安全側の手を選ぶ。
//  - normal   : 引ける限りドロー（手番だけ進み、勝敗にも0カード選択にも分岐しない）。
//               引けないときのみ手札最小カードを sub で出す。
//  - showdown : 手札の最小カード1枚を提出（弱い手＝負けやすいが、止めない）。
//  - raid     : プレイヤーはボスへ最小カード攻撃／ボスは生存者へ最小カード攻撃。
//
// 返り値が null のときは「代打すべき手がない」（例: 手札が空でドローもできない、
// 0カードプレイ後の reset/raid 選択待ち＝この関数の対象外）。呼び出し側は null を
// 「今回はスキップ」として扱う。

function cardValue(id: CardId): number {
  return parseInt(id.split("-")[0], 10);
}

/** 手札の最小値カード（同値なら先頭）。空なら undefined。 */
function lowestCard(hand: CardId[]): CardId | undefined {
  if (hand.length === 0) return undefined;
  return [...hand].sort((a, b) => cardValue(a) - cardValue(b))[0];
}

/** 0以外の最小カード。無ければ（全部0なら）最小カードにフォールバック。 */
function lowestNonZeroCard(hand: CardId[]): CardId | undefined {
  const nonZero = hand.filter((c) => cardValue(c) !== 0);
  return lowestCard(nonZero.length ? nonZero : hand);
}

export function autoActionFor(
  game: Game,
  playerId: PlayerId,
  ruleSet: RuleSet,
): Action | null {
  // A1: 介入オファーの応答待ち中。無応答の候補者はタイムアウトでパス扱い
  // （発動しない・1ゲーム1回の権利は消費しない）。
  if (game.pendingIntervention) {
    const pi = game.pendingIntervention;
    const isUnrespondedCandidate =
      pi.candidates.some((c) => c.playerId === playerId) &&
      !(playerId in pi.responses);
    if (isUnrespondedCandidate) {
      return { type: "intervention_response", activate: false };
    }
    return null;
  }

  const hand = game.hands[playerId] ?? [];

  if (game.phase === "showdown") {
    const c = lowestCard(hand);
    return c ? { type: "showdown_submit", cardIds: [c] } : null;
  }

  if (game.phase === "raid" && game.raidState) {
    const rs = game.raidState;
    // D2: ボスのバグ選択待ち。無応答はランダム選択で代打（従来の rng 選択と同挙動）。
    if (rs.awaitingBugChoice) {
      if (playerId !== rs.bossPlayerId) return null;
      const candidates = rs.bugCandidates ?? [];
      if (candidates.length === 0) return null;
      const bugId = candidates[Math.floor(Math.random() * candidates.length)];
      return { type: "choose_raid_bug", bugId };
    }
    // 手番が本当にこのプレイヤーか（防御的チェック）
    if (raidActor(rs) !== playerId) return null;

    // ボス: バグの制約を受けない（オーナー裁定1）。最小カードで生存者を攻撃。
    if (playerId === rs.bossPlayerId) {
      const c = lowestCard(hand);
      if (!c) return null; // ボスは補充・除去できない（手札切れは対象外）
      const target = Object.entries(rs.playerHPs)
        .filter(([, hp]) => hp > 0)
        .map(([id]) => id as PlayerId)[0];
      if (!target) return null;
      return { type: "play_card", cardId: c, operation: "add", targetId: target };
    }

    // 非ボス: 禁止バグに触れない合法カードを最小から選ぶ。
    const playable = hand
      .filter((c) => isRaidCardPlayable(game, c, false))
      .sort((a, b) => cardValue(a) - cardValue(b));
    if (playable.length > 0) {
      return { type: "play_card", cardId: playable[0], operation: "add", targetId: "boss" };
    }
    // 出せる札がない → 補充（ドロー）で手番を渡す
    if (game.deck.length > 0 && hand.length < ruleSet.initialConfig.initialHandSize) {
      return { type: "draw_card" };
    }
    // 補充も不可 → 支払える残バグがあれば除去
    const removal = affordableRaidRemoval(game, playerId, ruleSet);
    if (removal) {
      return { type: "remove_bug", bugId: removal.bugId, costCardIds: removal.costCardIds };
    }
    // 合法手が一切ない（全札禁止・補充不可・除去不可）→ スキップ（裁定2・3）
    return { type: "skip_turn" };
  }

  // normal phase
  const maxHand = ruleSet.initialConfig.initialHandSize;
  if (hand.length < maxHand && game.deck.length > 0) {
    return { type: "draw_card" };
  }
  // ドローできない（手札満杯 or 山札切れ）→ 最小カードを sub で出す（常に合法）。
  // 0カードは reset/raid 選択待ちを生むので、0以外を優先して避ける。
  const c = lowestNonZeroCard(hand);
  return c ? { type: "play_card", cardId: c, operation: "sub" } : null;
}
