// Rebind authentication — pure decision logic for client:join_room on an
// existing player. Guards against connection takeover: without this check any
// client that learns (or guesses) a playerId could rejoin as that player and
// receive their hand.

export interface RebindDecision {
  /** true → the rebind may proceed */
  allow: boolean;
  /**
   * true → the player has no stored token yet (joined before token support);
   * the caller must issue and persist one now.
   */
  issueNew: boolean;
}

/**
 * Decide whether a rejoining connection may bind to an existing player.
 *
 * - No stored token (player predates token support): allow, and issue one.
 * - Stored token present: allow only on an exact string match.
 */
export function verifyRebind(
  storedToken: string | undefined,
  providedToken: unknown
): RebindDecision {
  if (!storedToken) return { allow: true, issueNew: true };
  if (typeof providedToken !== "string") return { allow: false, issueNew: false };
  return { allow: timingSafeEqualStr(providedToken, storedToken), issueNew: false };
}

/**
 * Constant-time string comparison — always scans the full stored token so a
 * mismatch position does not leak through response timing.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
