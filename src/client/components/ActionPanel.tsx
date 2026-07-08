import { useState, useEffect } from "react";
import type { CardId, Operation, Action, PhaseId, Room, PlayerId } from "../../shared/types/domain";
import type { InterventionOffer, BossBugChoiceOffer } from "../hooks/useGameState";
import s from "./ActionPanel.module.css";

interface Props {
  hand:                CardId[];
  phase:               PhaseId;
  isMyTurn:            boolean;
  resetOrRaidPending:  boolean;
  /** A1: private intervention offer addressed to this player */
  interventionOffer?:  InterventionOffer | null;
  /** D2: private raid-bug choice offer addressed to the boss */
  bossBugChoice?:      BossBugChoiceOffer | null;
  /** A1: the game is frozen waiting for intervention responses */
  interventionPending?: boolean;
  selectedCardId:      CardId | null;
  /** Showdown: up to 2 selected cards */
  selectedCardIds?:    CardId[];
  /** Showdown: this player already submitted */
  hasSubmitted?:       boolean;
  lastFieldRawValue?:  number;
  room:                Room | null;
  playerId:            PlayerId;
  raidBossPlayerId?:   PlayerId;
  raidTurnOrder?:      PlayerId[];
  raidTurnIndex?:      number;
  onAction:            (action: Action) => void;
  onResetOrRaid:       (choice: "reset" | "raid") => void;
}

const OPS: { op: Operation; symbol: string }[] = [
  { op: "add", symbol: "+" },
  { op: "sub", symbol: "−" },
  { op: "mul", symbol: "×" },
  { op: "div", symbol: "÷" },
];

/**
 * A1: "activate your strategy?" prompt with a countdown. The server times the
 * window authoritatively (5s) — this countdown is display only.
 */
function InterventionPrompt({
  offer,
  onAction,
}: {
  offer: InterventionOffer;
  onAction: (action: Action) => void;
}) {
  const [responded, setResponded] = useState(false);
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, offer.deadline - Date.now()));

  useEffect(() => {
    setResponded(false);
    setRemainingMs(Math.max(0, offer.deadline - Date.now()));
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, offer.deadline - Date.now()));
    }, 100);
    return () => clearInterval(timer);
  }, [offer.deadline]);

  const respond = (activate: boolean) => {
    if (responded) return;
    setResponded(true);
    onAction({ type: "intervention_response", activate });
  };

  if (responded) {
    return (
      <div className={s.container}>
        <div className={s.hintText}>Response sent — waiting for resolution...</div>
      </div>
    );
  }

  const seconds = (remainingMs / 1000).toFixed(1);
  const expired = remainingMs <= 0;

  return (
    <div className={s.container}>
      <div className={s.hintText}>
        ⚡ {offer.strategyId} — activate on card {offer.triggerCard.rawValue}? ({seconds}s)
      </div>
      <div className={s.actionsRow}>
        <button
          type="button"
          className={`${s.btn} ${s.btnPlay}`}
          disabled={expired}
          onClick={() => respond(true)}
        >
          ⚡ ACTIVATE
        </button>
        <button
          type="button"
          className={`${s.btn} ${s.btnDraw}`}
          disabled={expired}
          onClick={() => respond(false)}
        >
          ✕ PASS
        </button>
      </div>
    </div>
  );
}

/**
 * D2: "which bug does the boss unleash this round?" prompt with a countdown.
 * Shown privately to the boss at the start of each raid round. The server times
 * the window authoritatively (5s) and picks a random candidate on timeout —
 * this countdown is display only, so no action is forced from the client.
 */
function BossBugChoicePrompt({
  offer,
  onAction,
}: {
  offer: BossBugChoiceOffer;
  onAction: (action: Action) => void;
}) {
  const [responded, setResponded] = useState(false);
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, offer.deadline - Date.now()));

  useEffect(() => {
    setResponded(false);
    setRemainingMs(Math.max(0, offer.deadline - Date.now()));
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, offer.deadline - Date.now()));
    }, 100);
    return () => clearInterval(timer);
  }, [offer.deadline]);

  const choose = (bugId: string) => {
    if (responded) return;
    setResponded(true);
    onAction({ type: "choose_raid_bug", bugId });
  };

  if (responded) {
    return (
      <div className={s.container}>
        <div className={s.hintText}>Bug chosen — starting round...</div>
      </div>
    );
  }

  const seconds = (remainingMs / 1000).toFixed(1);
  const expired = remainingMs <= 0;

  return (
    <div className={s.container}>
      <div className={s.hintText}>
        ⚔ RAID ROUND {offer.roundIndex + 1} — choose the bug to unleash ({seconds}s)
      </div>
      <div className={s.targetBtns}>
        {offer.candidates.map((bugId) => (
          <button
            key={bugId}
            type="button"
            className={`${s.targetBtn} ${s.bugChoiceBtn}`}
            disabled={expired}
            onClick={() => choose(bugId)}
          >
            🐛 {bugId}
          </button>
        ))}
      </div>
      {expired && (
        <div className={s.hintText}>Time up — boss picks at random...</div>
      )}
    </div>
  );
}

export function ActionPanel({
  hand,
  phase,
  isMyTurn,
  resetOrRaidPending,
  interventionOffer,
  bossBugChoice,
  interventionPending,
  selectedCardId,
  selectedCardIds = [],
  hasSubmitted = false,
  lastFieldRawValue,
  room,
  playerId,
  raidBossPlayerId,
  raidTurnOrder,
  raidTurnIndex,
  onAction,
  onResetOrRaid,
}: Props) {
  const [selectedOp, setSelectedOp] = useState<Operation>("add");
  const [selectedTarget, setSelectedTarget] = useState<PlayerId | "boss">("boss");

  // mul/div availability: card value must match last field card's raw value (ArithmeticJudge rule)
  // CardId format: "{value}-{serial}" e.g. "3-007"
  const selectedCardValue = selectedCardId ? parseInt(selectedCardId.split("-")[0], 10) : NaN;
  const canMulDiv = lastFieldRawValue !== undefined
    && lastFieldRawValue !== 0
    && !isNaN(selectedCardValue)
    && selectedCardValue !== 0
    && selectedCardValue === lastFieldRawValue;

  // Auto-reset selectedOp to "add" when mul/div becomes unavailable
  useEffect(() => {
    if (!canMulDiv && (selectedOp === "mul" || selectedOp === "div")) {
      setSelectedOp("add");
    }
  }, [canMulDiv, selectedOp]);

  // Reset target when boss/player turn switches (W-2)
  const isBossTurn = raidTurnOrder != null && raidTurnIndex != null && raidBossPlayerId != null
    ? raidTurnOrder[raidTurnIndex] === raidBossPlayerId
    : false;

  useEffect(() => {
    if (phase === "raid") {
      setSelectedTarget(isBossTurn ? "" as PlayerId : "boss");
    }
  }, [isBossTurn, phase]);

  // D2: the boss must choose this round's bug before any raid action — this is
  // addressed privately to the boss (not necessarily the turn player), so it
  // renders before the isMyTurn guard, ahead of everything else.
  if (bossBugChoice) {
    return <BossBugChoicePrompt offer={bossBugChoice} onAction={onAction} />;
  }

  // A1: intervention offer prompt takes priority — the offeree is NOT the turn
  // player, so this must render before the isMyTurn guard.
  if (interventionOffer) {
    return <InterventionPrompt offer={interventionOffer} onAction={onAction} />;
  }

  // A1: the game is frozen while someone else decides — block all actions
  if (interventionPending) {
    return (
      <div className={s.container}>
        <div className={s.hintText}>⚡ Resolving interventions...</div>
      </div>
    );
  }

  // Showdown: no turn order — every surviving player submits 1-2 cards + operation.
  // Placed before the isMyTurn guard because isMyTurn is meaningless here.
  if (phase === "showdown") {
    if (hasSubmitted) {
      return (
        <div className={s.container}>
          <div className={s.hintText}>SUBMITTED — waiting for other players...</div>
        </div>
      );
    }
    const values = selectedCardIds.map((id) => parseInt(id.split("-")[0], 10));
    const needsOp = selectedCardIds.length === 2;
    const divByZero = needsOp && selectedOp === "div" && values[1] === 0;
    const preview = !needsOp
      ? values[0]
      : selectedOp === "add" ? values[0] + values[1]
      : selectedOp === "sub" ? values[0] - values[1]
      : selectedOp === "mul" ? values[0] * values[1]
      : values[1] === 0 ? NaN : Math.ceil(values[0] / values[1]);
    const canSubmit = selectedCardIds.length >= 1 && !divByZero;

    return (
      <div className={s.container}>
        <div className={s.hintText}>
          SHOWDOWN — pick 1-2 cards{needsOp ? " + operation" : ""}
          {selectedCardIds.length > 0 && !Number.isNaN(preview) && ` (value: ${preview})`}
        </div>
        {needsOp && (
          <div className={s.opsRow}>
            {OPS.map(({ op, symbol }) => {
              const disabled = op === "div" && values[1] === 0;
              return (
                <button
                  key={op}
                  type="button"
                  className={[
                    s.opBtn,
                    selectedOp === op && !disabled ? s.opBtnSelected : "",
                    disabled ? s.opBtnDisabled : "",
                  ].join(" ")}
                  disabled={disabled}
                  onClick={() => !disabled && setSelectedOp(op)}
                >
                  {symbol}
                </button>
              );
            })}
          </div>
        )}
        <div className={s.actionsRow}>
          <button
            type="button"
            className={`${s.btn} ${s.btnPlay}`}
            disabled={!canSubmit}
            onClick={() => {
              if (!canSubmit) return;
              onAction({
                type:    "showdown_submit",
                cardIds: selectedCardIds,
                ...(needsOp ? { operation: selectedOp } : {}),
              });
            }}
          >
            ▶ SUBMIT
          </button>
        </div>
      </div>
    );
  }

  if (!isMyTurn) {
    return (
      <div className={s.container}>
        <div className={s.hintText}>Waiting for other players...</div>
      </div>
    );
  }

  // ResetOrRaid prompt (triggered after playing a 0-value card)
  if (resetOrRaidPending) {
    return (
      <div className={s.container}>
        <div className={s.hintText}>0 card played — choose action:</div>
        <div className={s.actionsRow}>
          <button
            type="button"
            className={`${s.btn} ${s.btnReset}`}
            onClick={() => onResetOrRaid("reset")}
          >
            ↺ RESET
          </button>
          <button
            type="button"
            className={`${s.btn} ${s.btnRaid}`}
            onClick={() => onResetOrRaid("raid")}
          >
            ⚔ RAID
          </button>
        </div>
      </div>
    );
  }

  // Raid phase
  if (phase === "raid") {
    // Boss turn: boss attacks players. Player turn: players attack boss.
    const targets: { id: PlayerId | "boss"; label: string }[] = isBossTurn
      ? (room?.players
          .filter((p) => p.role === "player" && p.id !== playerId)
          .map((p) => ({ id: p.id as PlayerId, label: p.name })) ?? [])
      : [{ id: "boss" as const, label: "BOSS" }];

    const effectiveTarget = selectedTarget || (targets[0]?.id ?? "boss");

    return (
      <div className={s.container}>
        <div className={s.targetRow}>
          <div className={s.targetLabel}>Target</div>
          <div className={s.targetBtns}>
            {targets.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`${s.targetBtn} ${effectiveTarget === t.id ? s.targetBtnSelected : ""}`}
                onClick={() => setSelectedTarget(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* No operator selection in raid */}
        <div className={s.actionsRow}>
          <button
            type="button"
            className={`${s.btn} ${s.btnPlay}`}
            disabled={!selectedCardId || !effectiveTarget}
            onClick={() => {
              if (!selectedCardId || !effectiveTarget) return;
              onAction({
                type:      "play_card",
                cardId:    selectedCardId,
                operation: "add",
                targetId:  effectiveTarget,
              });
            }}
          >
            ▶ ATTACK
          </button>
        </div>
      </div>
    );
  }

  // Normal phase
  const opIsDisabled = (selectedOp === "mul" || selectedOp === "div") && !canMulDiv;
  const canPlay = !!selectedCardId && !opIsDisabled;

  return (
    <div className={s.container}>
      {/* Operation selector */}
      <div className={s.opsRow}>
        {OPS.map(({ op, symbol }) => {
          const disabled = (op === "mul" || op === "div") && !canMulDiv;
          return (
            <button
              key={op}
              type="button"
              className={[
                s.opBtn,
                selectedOp === op && !disabled ? s.opBtnSelected : "",
                disabled ? s.opBtnDisabled : "",
              ].join(" ")}
              disabled={disabled}
              onClick={() => !disabled && setSelectedOp(op)}
            >
              {symbol}
            </button>
          );
        })}
      </div>

      <div className={s.actionsRow}>
        <button
          type="button"
          className={`${s.btn} ${s.btnPlay}`}
          disabled={!canPlay}
          onClick={() => {
            if (!selectedCardId) return;
            onAction({ type: "play_card", cardId: selectedCardId, operation: selectedOp });
          }}
        >
          ▶ PLAY
        </button>
        <button
          type="button"
          className={`${s.btn} ${s.btnDraw}`}
          disabled={hand.length === 0}
          onClick={() => onAction({ type: "draw_card" })}
        >
          ↓ DRAW
        </button>
      </div>
    </div>
  );
}
