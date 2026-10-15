export type GmailConnectionState =
  | "not_configured"
  | "disconnected"
  | "authorizing"
  | "connected"
  | "reauthorization_required";

export interface GmailAccountStatus {
  state: GmailConnectionState;
  emailAddress?: string;
}

export interface GmailClientConfigStatus {
  clientId: string;
  clientSecretConfigured: boolean;
  secureStorageAvailable: boolean;
}

export type GmailErrorCode =
  | "not_configured"
  | "safe_storage_unavailable"
  | "not_connected"
  | "authorization_cancelled"
  | "authorization_failed"
  | "authorization_timeout"
  | "insufficient_scope"
  | "reauthorization_required"
  | "message_not_found"
  | "draft_not_found"
  | "rate_limited"
  | "network_error"
  | "invalid_request"
  | "unknown";

export interface GmailPublicError {
  code: GmailErrorCode;
  message: string;
}
