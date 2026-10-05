declare const __CYRENE_GMAIL_CLIENT_ID__: string | undefined;

export function getGmailClientId(): string | null {
  if (typeof __CYRENE_GMAIL_CLIENT_ID__ !== "string") return null;
  const clientId = __CYRENE_GMAIL_CLIENT_ID__.trim();
  return clientId.length > 0 ? clientId : null;
}
