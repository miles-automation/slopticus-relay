import {
  connect,
  constants,
  type ClientHttp2Session,
  type SecureClientSessionOptions,
} from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

export type ApnsEnvironment = "sandbox" | "production";
export type ApnsConfig = {
  key: string;
  keyId: string;
  teamId: string;
  topic: string;
};
export type ApnsAlert = {
  body: string;
  collapseId: string;
  threadId: string;
  data: Record<string, string>;
};
export type ApnsResult = { status: number; reason: string | null };
export interface PushSender {
  send(
    token: string,
    environment: ApnsEnvironment,
    alert: ApnsAlert,
  ): Promise<ApnsResult>;
  close(): void;
}

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
export const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;
const APNS_TIMEOUT_MS = 10_000;

export function apnsKey(raw: string): KeyObject {
  const text = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  const pem = text.includes("BEGIN PRIVATE KEY")
    ? text
    : Buffer.from(text.trim(), "base64").toString("utf8");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ec")
    throw new Error("The APNs key must be an EC P-256 key");
  return key;
}

export function apnsConfigFromEnv(
  env: NodeJS.ProcessEnv,
): ApnsConfig | undefined {
  const key = env.SLOPTICUS_APNS_KEY_P8;
  const keyId = env.SLOPTICUS_APNS_KEY_ID?.trim();
  const teamId = env.SLOPTICUS_APNS_TEAM_ID?.trim();
  const topic = env.SLOPTICUS_APNS_TOPIC?.trim();
  if (!key || !keyId || !teamId || !topic) return undefined;
  return { key, keyId, teamId, topic };
}

export function apnsPayload(alert: ApnsAlert): string {
  return JSON.stringify({
    aps: {
      alert: { body: alert.body },
      sound: "default",
      "thread-id": alert.threadId,
    },
    slopticus: alert.data,
  });
}

const base64url = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64url");

export class ApnsSender implements PushSender {
  private readonly key: KeyObject;
  private token: { value: string; at: number } | null = null;
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
  constructor(
    private readonly config: ApnsConfig,
    private readonly options: {
      hosts?: Record<ApnsEnvironment, string>;
      now?: () => number;
      tls?: SecureClientSessionOptions;
      timeoutMs?: number;
    } = {},
  ) {
    this.key = apnsKey(config.key);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  bearer(): string {
    const now = this.now();
    if (this.token && now - this.token.at < APNS_TOKEN_TTL_MS)
      return this.token.value;
    const header = base64url(
      JSON.stringify({ alg: "ES256", kid: this.config.keyId }),
    );
    const claims = base64url(
      JSON.stringify({ iss: this.config.teamId, iat: Math.floor(now / 1000) }),
    );
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
      key: this.key,
      dsaEncoding: "ieee-p1363",
    });
    const value = `${header}.${claims}.${base64url(signature)}`;
    this.token = { value, at: now };
    return value;
  }

  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const host = (this.options.hosts ?? APNS_HOSTS)[environment];
    const session = connect(host, this.options.tls);
    session.on("error", () => this.drop(environment, session));
    session.on("goaway", () => this.drop(environment, session));
    session.on("close", () => this.drop(environment, session));
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }

  private drop(environment: ApnsEnvironment, session: ClientHttp2Session) {
    if (this.sessions.get(environment) === session)
      this.sessions.delete(environment);
    if (!session.destroyed) session.destroy();
  }

  async send(
    token: string,
    environment: ApnsEnvironment,
    alert: ApnsAlert,
  ): Promise<ApnsResult> {
    const first = await this.post(token, environment, alert);
    if (first.status === 403 && first.reason === "ExpiredProviderToken") {
      this.token = null;
      return this.post(token, environment, alert);
    }
    return first;
  }

  private post(
    token: string,
    environment: ApnsEnvironment,
    alert: ApnsAlert,
  ): Promise<ApnsResult> {
    const body = apnsPayload(alert);
    return new Promise((resolve) => {
      let session: ClientHttp2Session;
      try {
        session = this.session(environment);
      } catch {
        resolve({ status: 0, reason: "ConnectionFailed" });
        return;
      }
      session.ref();
      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        authorization: `bearer ${this.bearer()}`,
        "apns-topic": this.config.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(this.now() / 1000) + 3600),
        "apns-collapse-id": alert.collapseId.slice(0, 64),
        "content-type": "application/json",
      });
      let status = 0;
      let text = "";
      let settled = false;
      const finish = (result: ApnsResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!session.destroyed) session.unref();
        resolve(result);
      };
      const timer = setTimeout(() => {
        request.close(constants.NGHTTP2_CANCEL);
        finish({ status: 0, reason: "Timeout" });
      }, this.options.timeoutMs ?? APNS_TIMEOUT_MS);
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.on("data", (chunk: string) => {
        if (text.length < 4096) text += chunk;
      });
      request.on("end", () => {
        let reason: string | null = null;
        try {
          const parsed: unknown = JSON.parse(text);
          if (
            parsed &&
            typeof parsed === "object" &&
            "reason" in parsed &&
            typeof parsed.reason === "string"
          )
            reason = parsed.reason;
        } catch {
          reason = null;
        }
        finish({ status, reason });
      });
      request.on("error", () => finish({ status: 0, reason: "StreamFailed" }));
      request.end(body);
    });
  }

  close(): void {
    for (const [environment, session] of this.sessions)
      this.drop(environment, session);
  }
}
