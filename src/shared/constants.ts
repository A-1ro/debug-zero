// ============================================================
// Error codes
// ============================================================

// Room errors
export const ROOM_NOT_FOUND            = "ROOM_NOT_FOUND";
export const ROOM_FULL                 = "ROOM_FULL";
export const ROOM_ALREADY_STARTED      = "ROOM_ALREADY_STARTED";
export const ROOM_HOST_REQUIRED        = "ROOM_HOST_REQUIRED";
export const ROOM_NOT_ALL_READY        = "ROOM_NOT_ALL_READY";
export const ROOM_REBIND_UNAUTHORIZED  = "ROOM_REBIND_UNAUTHORIZED";

// Session errors
export const SESSION_INVALID_STRATEGY      = "SESSION_INVALID_STRATEGY";
export const SESSION_STRATEGY_NOT_SELECTED = "SESSION_STRATEGY_NOT_SELECTED";
export const SESSION_NOT_IN_PROGRESS       = "SESSION_NOT_IN_PROGRESS";

// Action errors
export const ACTION_NOT_YOUR_TURN             = "ACTION_NOT_YOUR_TURN";
export const ACTION_INVALID_CARD              = "ACTION_INVALID_CARD";
export const ACTION_INVALID_OPERATION         = "ACTION_INVALID_OPERATION";
export const ACTION_HAND_EMPTY                = "ACTION_HAND_EMPTY";
export const ACTION_HAND_FULL                 = "ACTION_HAND_FULL";
export const ACTION_BUG_FORBIDDEN             = "ACTION_BUG_FORBIDDEN";
export const ACTION_USAGE_LIMIT_EXCEEDED      = "ACTION_USAGE_LIMIT_EXCEEDED";
export const ACTION_RESET_LIMIT_EXCEEDED      = "ACTION_RESET_LIMIT_EXCEEDED";
export const ACTION_INVALID_BUG_REMOVAL_COST  = "ACTION_INVALID_BUG_REMOVAL_COST";
export const ACTION_INVALID_PHASE             = "ACTION_INVALID_PHASE";
export const ACTION_ALREADY_SUBMITTED         = "ACTION_ALREADY_SUBMITTED";
// A1: intervention offers (optional activation of on_card_played_by_other strategies)
export const ACTION_INTERVENTION_PENDING      = "ACTION_INTERVENTION_PENDING";
export const ACTION_NO_PENDING_INTERVENTION   = "ACTION_NO_PENDING_INTERVENTION";

// WebSocket errors
export const WS_DUPLICATE_MESSAGE  = "WS_DUPLICATE_MESSAGE";
export const WS_AUTH_FAILED        = "WS_AUTH_FAILED";
export const WS_RECONNECT_FAILED   = "WS_RECONNECT_FAILED";

// Rule errors
export const RULE_NOT_FOUND              = "RULE_NOT_FOUND";
export const RULE_VALIDATION_FAILED      = "RULE_VALIDATION_FAILED";
export const RULE_EFFECT_UNREGISTERED    = "RULE_EFFECT_UNREGISTERED";

// ============================================================
// Type alias for ErrorCode
// ============================================================

export type ErrorCode = string;
