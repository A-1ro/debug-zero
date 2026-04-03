import type { BugId, Action } from "../../shared/types/domain";
import s from "./BugDisplay.module.css";

interface Props {
  bugs:     BugId[];
  isMyTurn: boolean;
  onAction: (action: Action) => void;
}

export function BugDisplay({ bugs, isMyTurn, onAction }: Props) {
  return (
    <div className={s.container}>
      <div className={s.label}>Residual Bugs ({bugs.length})</div>
      <div className={s.bugList}>
        {bugs.length === 0 ? (
          <span className={s.emptyText}>— NO BUGS —</span>
        ) : (
          bugs.map((bugId) => (
            <div key={bugId} className={s.bugChip}>
              <span className={s.bugId}>{bugId}</span>
              {isMyTurn && (
                <button
                  type="button"
                  className={s.removeBtn}
                  title="Remove bug"
                  onClick={() => onAction({ type: "remove_bug", bugId })}
                >
                  ✕
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
