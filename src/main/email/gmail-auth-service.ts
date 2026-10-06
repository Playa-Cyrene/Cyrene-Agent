import { net, shell } from "electron";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client, type Credentials } from "google-auth-library";
import type { GmailConnectionState, GmailAccountStatus } from "../../shared/gmail-types";
import { getGmailClientId } from "./gmail-client-config";
import { GmailTokenStore, type GmailTokens } from "./gmail-token-store";

export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const AUTH_TIMEOUT_MS = 3 * 60 * 1000;

interface PendingAuthorization {
  flowId: string;
  client: OAuth2Client;
  state: string;
  codeVerifier: string;
  server: Server;
  completion: Promise<GmailAccountStatus>;
  resolveCompletion: (status: GmailAccountStatus) => void;
  timer: ReturnType<typeof setTimeout>;
  finished: boolean;
  committing: boolean;
  callbackProcessing: boolean;
  credentialEpoch: number;
}

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function credentialsFromTokens(tokens: GmailTokens): Credentials {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    scope: tokens.scope,
    token_type: tokens.token_type,
  };
}

function toStoredTokens(credentials: Credentials, fallback?: GmailTokens): GmailTokens {
  const accessToken = credentials.access_token ?? fallback?.access_token;
  const refreshToken = credentials.refresh_token ?? fallback?.refresh_token;
  if (!accessToken || !refreshToken) throw new Error("GMAIL_TOKENS_INCOMPLETE");
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(credentials.expiry_date ?? fallback?.expiry_date
      ? { expiry_date: credentials.expiry_date ?? fallback?.expiry_date }
      : {}),
    ...(credentials.scope ?? fallback?.scope ? { scope: credentials.scope ?? fallback?.scope } : {}),
    ...(credentials.token_type ?? fallback?.token_type
      ? { token_type: credentials.token_type ?? fallback?.token_type }
      : {}),
  };
}

function isRevokedRefreshToken(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const root = error as { code?: unknown; response?: { data?: { error?: unknown } } };
  return root.response?.data?.error === "invalid_grant" || root.code === "invalid_grant";
}

function safeAuthFailureCode(error: unknown): { code?: string; parameterIssue?: string; status?: number } {
  if (!error || typeof error !== "object") return {};
  const root = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown; data?: { error?: unknown; error_description?: unknown } };
  };
  const candidate = root.response?.data?.error ?? root.code;
  const code = typeof candidate === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : undefined;
  const description = typeof root.response?.data?.error_description === "string"
    ? root.response.data.error_description.toLowerCase()
    : "";
  const parameter = /\b(code_verifier|redirect_uri|client_id|client_secret|grant_type|code|scope)\b/i.exec(description)?.[1]?.toLowerCase();
  const problem = /\b(missing|required)\b/i.test(description)
    ? "missing"
    : /\b(invalid|malformed|unsupported)\b/i.test(description)
      ? "invalid"
      : undefined;
  const rawStatus = root.response?.status ?? root.status;
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : undefined;
  return {
    ...(code ? { code } : {}),
    ...(problem && parameter ? { parameterIssue: `${problem}_${parameter}` } : {}),
    ...(status ? { status } : {}),
  };
}

function reply(res: import("node:http").ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(message);
}

function createOAuthClient(options: { clientId: string; redirectUri?: string }): OAuth2Client {
  const client = new OAuth2Client(options);
  // Use Chromium's networking stack so OAuth and Gmail API calls honor the app's
  // system proxy/PAC configuration, matching other Electron network requests.
  client.transporter.defaults.fetchImplementation = (input, init) =>
    net.fetch(input instanceof URL ? input.toString() : input, init);
  return client;
}

export class GmailAuthService {
  private readonly pending = new Map<string, PendingAuthorization>();
  private credentialEpoch = 0;
  private tokenWriteQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly tokenStore = new GmailTokenStore(),
    private readonly getClientId: () => string | null = getGmailClientId,
    private readonly openExternal: (url: string) => Promise<void> = (url) => shell.openExternal(url),
  ) {}

  async getStatus(): Promise<GmailConnectionState> {
    if (!this.getClientId()) return "not_configured";
    if ([...this.pending.values()].some((flow) => !flow.finished)) return "authorizing";
    if (!this.tokenStore.isSecureStorageAvailable) return "reauthorization_required";
    try {
      return (await this.tokenStore.load()) ? "connected" : "disconnected";
    } catch {
      return "reauthorization_required";
    }
  }

  async startAuthorization(): Promise<{ flowId: string }> {
    const clientId = this.getClientId();
    if (!clientId) throw new Error("GMAIL_NOT_CONFIGURED");
    if (!this.tokenStore.isSecureStorageAvailable) throw new Error("GMAIL_SAFE_STORAGE_UNAVAILABLE");
    if ([...this.pending.values()].some((flow) => !flow.finished)) throw new Error("GMAIL_AUTH_ALREADY_RUNNING");

    const server = createServer();
    const listening = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("GMAIL_AUTH_CALLBACK_UNAVAILABLE");
      const redirectUri = `http://127.0.0.1:${(address as AddressInfo).port}`;
      const client = createOAuthClient({ clientId, redirectUri });
      const verifier = await client.generateCodeVerifierAsync();
      if (!verifier.codeChallenge) throw new Error("GMAIL_PKCE_UNAVAILABLE");

      let resolveCompletion!: (status: GmailAccountStatus) => void;
      const completion = new Promise<GmailAccountStatus>((resolve) => { resolveCompletion = resolve; });
      const credentialEpoch = ++this.credentialEpoch;
      const flow = {
        flowId: randomUrlSafe(24),
        client,
        state: randomUrlSafe(),
        codeVerifier: verifier.codeVerifier,
        server,
        completion,
        resolveCompletion,
        timer: setTimeout(() => undefined, AUTH_TIMEOUT_MS),
        finished: false,
        committing: false,
        callbackProcessing: false,
        credentialEpoch,
      } satisfies PendingAuthorization;
      clearTimeout(flow.timer);
      flow.timer = setTimeout(() => {
        if (!flow.committing) void this.finishFlow(flow, { state: "disconnected" });
      }, AUTH_TIMEOUT_MS);
      flow.timer.unref?.();

      server.on("request", (req, res) => {
        void this.handleCallback(flow, req, res);
      });
      this.pending.set(flow.flowId, flow);

      const authUrl = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [GMAIL_MODIFY_SCOPE],
        state: flow.state,
        code_challenge: verifier.codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
      });
      try {
        await this.openExternal(authUrl);
      } catch {
        await this.finishFlow(flow, { state: "disconnected" });
        throw new Error("GMAIL_AUTH_BROWSER_FAILED");
      }
      return { flowId: flow.flowId };
    } catch (error) {
      if (server.listening) await this.closeServer(server);
      throw error;
    }
  }

  async waitForAuthorization(flowId: string): Promise<GmailAccountStatus> {
    const flow = this.pending.get(flowId);
    if (!flow) return { state: await this.getStatus() };
    try {
      return await flow.completion;
    } finally {
      this.pending.delete(flowId);
    }
  }

  async cancelAuthorization(flowId: string): Promise<void> {
    const flow = this.pending.get(flowId);
    if (!flow) return;
    if (flow.committing) {
      await flow.completion;
      return;
    }
    await this.finishFlow(flow, { state: "disconnected" });
  }

  async disconnect(): Promise<void> {
    this.credentialEpoch += 1;
    for (const flow of this.pending.values()) {
      if (flow.finished) continue;
      if (flow.committing) await flow.completion;
      else await this.finishFlow(flow, { state: "disconnected" });
    }

    const tokens = await this.serializeTokenWrite(async () => {
      const current = await this.tokenStore.load().catch(() => null);
      await this.tokenStore.clear();
      return current;
    });
    if (!tokens?.refresh_token) return;
    const clientId = this.getClientId();
    if (!clientId) return;
    const client = createOAuthClient({ clientId });
    try {
      await client.revokeToken(tokens.refresh_token);
    } catch {
      // 本地凭据已清除；网络撤销失败不能恢复或记录令牌。
    }
  }

  async shutdown(): Promise<void> {
    this.credentialEpoch += 1;
    await Promise.all([...this.pending.values()].map(async (flow) => {
      if (flow.finished) return;
      if (flow.committing) await flow.completion;
      else await this.finishFlow(flow, { state: "disconnected" });
    }));
    this.pending.clear();
  }

  async getAuthorizedClient(): Promise<OAuth2Client> {
    const clientId = this.getClientId();
    if (!clientId) throw new Error("GMAIL_NOT_CONFIGURED");
    if (!this.tokenStore.isSecureStorageAvailable) throw new Error("GMAIL_SAFE_STORAGE_UNAVAILABLE");
    const credentialEpoch = this.credentialEpoch;
    const tokens = await this.tokenStore.load();
    if (credentialEpoch !== this.credentialEpoch) throw new Error("GMAIL_NOT_CONNECTED");
    if (!tokens) throw new Error("GMAIL_NOT_CONNECTED");

    const client = createOAuthClient({ clientId });
    client.setCredentials(credentialsFromTokens(tokens));
    client.on("tokens", (updated: Credentials) => {
      void this.persistRefreshedCredentials(updated, tokens, credentialEpoch);
    });

    if (tokens.expiry_date !== undefined && tokens.expiry_date <= Date.now() + 60_000) {
      try {
        await client.getAccessToken();
        await this.persistRefreshedCredentials(client.credentials, tokens, credentialEpoch);
      } catch (error) {
        if (credentialEpoch !== this.credentialEpoch) throw new Error("GMAIL_NOT_CONNECTED");
        if (isRevokedRefreshToken(error)) {
          await this.serializeTokenWrite(async () => {
            if (credentialEpoch === this.credentialEpoch) await this.tokenStore.clear();
          });
          throw new Error("GMAIL_REAUTH_REQUIRED");
        }
        throw new Error("GMAIL_REFRESH_TEMPORARY_FAILURE");
      }
    }
    return client;
  }

  private async handleCallback(
    flow: PendingAuthorization,
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    if (flow.finished) {
      reply(res, 409, "This Gmail authorization flow has already finished. You can close this window.");
      return;
    }
    if (req.method !== "GET") {
      reply(res, 405, "Method not allowed.");
      return;
    }

    let callback: URL;
    try {
      callback = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      reply(res, 400, "Invalid authorization response.");
      return;
    }
    if (callback.pathname !== "/") {
      reply(res, 404, "Not found.");
      return;
    }
    const state = callback.searchParams.get("state") ?? "";
    if (!safeEquals(state, flow.state)) {
      reply(res, 400, "Authorization state did not match. Return to the app and try again.");
      return;
    }
    if (flow.callbackProcessing) {
      reply(res, 409, "This Gmail authorization response is already being processed.");
      return;
    }

    const oauthError = callback.searchParams.get("error");
    if (oauthError) {
      reply(res, 200, "Gmail authorization was cancelled. You can return to the app.");
      await this.finishFlow(flow, { state: "disconnected" });
      return;
    }
    const code = callback.searchParams.get("code");
    if (!code) {
      reply(res, 400, "The authorization response did not include a code.");
      await this.finishFlow(flow, { state: "disconnected" });
      return;
    }

    flow.callbackProcessing = true;
    let failureStage = "token_exchange";
    try {
      const { tokens } = await flow.client.getToken({ code, codeVerifier: flow.codeVerifier });
      if (flow.finished || flow.credentialEpoch !== this.credentialEpoch) {
        reply(res, 409, "This Gmail authorization was cancelled. Return to the app.");
        return;
      }
      if (!tokens.access_token) throw new Error("GMAIL_ACCESS_TOKEN_MISSING");
      failureStage = "scope_verification";
      const tokenInfo = await flow.client.getTokenInfo(tokens.access_token);
      if (flow.finished || flow.credentialEpoch !== this.credentialEpoch) {
        reply(res, 409, "This Gmail authorization was cancelled. Return to the app.");
        return;
      }
      if (!tokenInfo.scopes.includes(GMAIL_MODIFY_SCOPE)) {
        reply(res, 400, "Gmail access was not granted. Return to the app and try again.");
        await this.finishFlow(flow, { state: "disconnected" });
        return;
      }
      failureStage = "token_storage";
      const previous = await this.tokenStore.load().catch(() => null);
      const stored = toStoredTokens(tokens, previous ?? undefined);
      flow.committing = true;
      await this.serializeTokenWrite(async () => {
        if (flow.finished || flow.credentialEpoch !== this.credentialEpoch) throw new Error("GMAIL_AUTH_CANCELLED");
        await this.tokenStore.save(stored);
      });
      reply(res, 200, "Gmail is connected. You can return to the app.");
      await this.finishFlow(flow, { state: "connected" });
    } catch (error) {
      const state: GmailConnectionState = error instanceof Error && error.message === "GMAIL_SAFE_STORAGE_UNAVAILABLE"
        ? "reauthorization_required"
        : "disconnected";
      const detail = safeAuthFailureCode(error);
      const diagnostic = [failureStage, detail.code, detail.parameterIssue, detail.status ? `HTTP_${detail.status}` : undefined]
        .filter((item): item is string => Boolean(item))
        .join("_");
      const guidance = detail.parameterIssue === "missing_client_secret"
        ? "Use an OAuth client of type Desktop app, update CYRENE_GMAIL_CLIENT_ID, and restart the app. Do not embed a Web application client secret in the desktop app."
        : "Return to the app and try again.";
      reply(res, 400, `Gmail could not be connected (${diagnostic}). ${guidance}`);
      await this.finishFlow(flow, { state });
    }
  }

  private async persistRefreshedCredentials(updated: Credentials, fallback: GmailTokens, credentialEpoch: number): Promise<void> {
    await this.serializeTokenWrite(async () => {
      if (credentialEpoch !== this.credentialEpoch) return;
      try {
        const current = await this.tokenStore.load();
        if (credentialEpoch !== this.credentialEpoch) return;
        await this.tokenStore.save(toStoredTokens(updated, current ?? fallback));
      } catch {
        // Keep token data out of logs. The next API call will surface reauthorization if persistence failed.
      }
    });
  }

  private serializeTokenWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tokenWriteQueue.then(operation, operation);
    this.tokenWriteQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async finishFlow(flow: PendingAuthorization, status: GmailAccountStatus): Promise<void> {
    if (flow.finished) return;
    flow.finished = true;
    clearTimeout(flow.timer);
    await this.closeServer(flow.server);
    flow.resolveCompletion(status);
  }

  private async closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
