declare const __CYRENE_GMAIL_CLIENT_ID__: string | undefined;
declare const __CYRENE_GMAIL_CLIENT_SECRET__: string | undefined;

export function getGmailClientId(): string | null {
  if (typeof __CYRENE_GMAIL_CLIENT_ID__ !== "string") return null;
  const clientId = __CYRENE_GMAIL_CLIENT_ID__.trim();
  return clientId.length > 0 ? clientId : null;
}

export function getGmailClientSecret(): string | null {
  if (typeof __CYRENE_GMAIL_CLIENT_SECRET__ !== "string") return null;
  const clientSecret = __CYRENE_GMAIL_CLIENT_SECRET__.trim();
  return clientSecret.length > 0 ? clientSecret : null;
}
