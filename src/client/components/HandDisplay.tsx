import type { CardId } from "../../shared/types/domain";
import s from "./HandDisplay.module.css";

interface Props {
  hand:            CardId[];
  selectedCardId:  CardId | null;
  isMyTurn:        boolean;
  onSelect:        (cardId: CardId) => void;
}

export function HandDisplay({ hand, selectedCardId, isMyTurn, onSelect }: Props) {
  return (
    <div className={s.container}>
      <div className={s.label}>Your Hand ({hand.length})</div>
      <div className={s.cardRow}>
        {hand.map((cardId) => {
          const value    = parseInt(cardId.split("-")[0], 10);
          const isSelected = cardId === selectedCardId;
          return (
            <div
              key={cardId}
              role="button"
              tabIndex={isMyTurn ? 0 : -1}
              aria-pressed={isSelected}
              className={[
                s.card,
                isSelected   ? s.cardSelected  : "",
                !isMyTurn    ? s.cardDisabled   : "",
              ].join(" ")}
              onClick={() => isMyTurn && onSelect(cardId)}
              onKeyDown={(e) => {
                if (isMyTurn && (e.key === "Enter" || e.key === " ")) onSelect(cardId);
              }}
            >
              {value}
              <span className={s.cardId}>{cardId.split("-")[1]}</span>
            </div>
          );
        })}
        {hand.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.2em" }}>
            — NO CARDS —
          </span>
        )}
      </div>
    </div>
  );
}
