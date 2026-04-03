import { useEffect, useRef } from "react";
import type { EventLog, Room, PlayerId } from "../../shared/types/domain";
import s from "./EventLogPanel.module.css";

interface Props {
  events:   EventLog[];
  room:     Room | null;
  playerId: PlayerId;
}

function formatTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

function actorLabel(actorId: string, room: Room | null, playerId: PlayerId): string {
  if (actorId === "system" || actorId === "boss") return actorId.toUpperCase();
  if (actorId === playerId) return "YOU";
  return room?.players.find((p) => p.id === actorId)?.name ?? actorId.slice(0, 8);
}

export function EventLogPanel({ events, room, playerId }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  return (
    <div className={s.panel}>
      <div className={s.header}>Activity Log</div>
      <div className={s.body} ref={bodyRef}>
        {events.length === 0 ? (
          <div className={s.empty}>— WAITING —</div>
        ) : (
          events.map((ev) => (
            <div key={ev.id} className={s.entry}>
              <span className={s.time}>{formatTime(ev.timestamp)}</span>
              <span className={s.text}>
                [{actorLabel(ev.actorId, room, playerId)}] {ev.type}
              </span>
            </div>
          ))
        )}
      </div>
      <div className={s.chatPlaceholder}>CHAT — COMING SOON</div>
    </div>
  );
}
