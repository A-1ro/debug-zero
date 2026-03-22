import type { Session, SessionId } from "../../shared/types/domain";

export class SessionRepository {
  private readonly sessions: Map<SessionId, Session> = new Map();

  get(id: SessionId): Session | undefined {
    return this.sessions.get(id);
  }

  save(session: Session): void {
    this.sessions.set(session.id, session);
  }

  delete(id: SessionId): void {
    this.sessions.delete(id);
  }

  has(id: SessionId): boolean {
    return this.sessions.has(id);
  }
}
