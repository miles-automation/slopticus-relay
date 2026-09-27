import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ApnsEnvironment, PushSender } from "./apns.js";

export const PUSH_MAX_DEVICES = 16;
export const pushDeviceSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    environment: z.enum(["sandbox", "production"]),
  })
  .strict();
export const pushDevicesSchema = z
  .object({ devices: z.array(pushDeviceSchema).max(PUSH_MAX_DEVICES) })
  .strict();
export const pushNoticeKinds = ["needs_you", "finished", "ended"] as const;
export const pushNoticeSchema = z
  .object({
    session_id: z.string().uuid(),
    kind: z.enum(pushNoticeKinds),
    agent: z.string().trim().min(1).max(40),
    project: z.string().trim().min(1).max(60),
  })
  .strict();
export type PushDevice = z.infer<typeof pushDeviceSchema>;
export type PushNotice = z.infer<typeof pushNoticeSchema>;
export type PushOutcome = {
  sent: number;
  pruned: string[];
  dropped: "coalesced" | "limited" | "no_devices" | null;
};

export class PushDevices {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS push_devices(
      computer_id TEXT NOT NULL, token TEXT NOT NULL, environment TEXT NOT NULL,
      updated INTEGER NOT NULL, PRIMARY KEY(computer_id, token))`);
  }

  replace(computerId: string, devices: PushDevice[]): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM push_devices WHERE computer_id=?")
        .run(computerId);
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO push_devices(computer_id,token,environment,updated) VALUES(?,?,?,?)",
      );
      for (const device of devices.slice(0, PUSH_MAX_DEVICES))
        insert.run(computerId, device.token, device.environment, Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(computerId: string): PushDevice[] {
    return this.db
      .prepare(
        `SELECT d.token, d.environment FROM push_devices d JOIN computers c ON c.id=d.computer_id
         WHERE d.computer_id=? AND c.revoked=0 ORDER BY d.token`,
      )
      .all(computerId)
      .map((row) => ({
        token: String(row.token),
        environment: String(row.environment) as ApnsEnvironment,
      }));
  }

  prune(token: string): void {
    this.db.prepare("DELETE FROM push_devices WHERE token=?").run(token);
  }
}

const PHRASES: Record<PushNotice["kind"], string> = {
  needs_you: "needs you",
  finished: "finished",
  ended: "ended",
};

export function pushBody(notice: PushNotice): string {
  return `${notice.agent} in ${notice.project} ${PHRASES[notice.kind]}`;
}

const prunable = (status: number, reason: string | null): boolean =>
  status === 410 ||
  (status === 400 && reason === "BadDeviceToken") ||
  reason === "Unregistered";

export class PushNotifier {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly recent = new Map<string, number>();
  constructor(
    private readonly devices: PushDevices,
    private readonly sender: PushSender,
    private readonly options: {
      now?: () => number;
      burst?: number;
      refillMs?: number;
      coalesceMs?: number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private admit(
    computerId: string,
    notice: PushNotice,
  ): PushOutcome["dropped"] {
    const now = this.now();
    const coalesceMs = this.options.coalesceMs ?? 30_000;
    const key = `${computerId}:${notice.session_id}:${notice.kind}`;
    const last = this.recent.get(key);
    if (last !== undefined && now - last < coalesceMs) return "coalesced";
    const burst = this.options.burst ?? 6;
    const refillMs = this.options.refillMs ?? 20_000;
    const bucket = this.buckets.get(computerId) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(
      burst,
      bucket.tokens + (now - bucket.at) / refillMs,
    );
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(computerId, bucket);
      return "limited";
    }
    bucket.tokens -= 1;
    this.buckets.set(computerId, bucket);
    if (this.recent.size > 4096)
      for (const [entry, at] of this.recent)
        if (now - at >= coalesceMs) this.recent.delete(entry);
    this.recent.set(key, now);
    return null;
  }

  async notify(computerId: string, notice: PushNotice): Promise<PushOutcome> {
    const devices = this.devices.list(computerId);
    if (devices.length === 0)
      return { sent: 0, pruned: [], dropped: "no_devices" };
    const dropped = this.admit(computerId, notice);
    if (dropped) return { sent: 0, pruned: [], dropped };
    const alert = {
      body: pushBody(notice),
      collapseId: notice.session_id,
      threadId: notice.session_id,
      data: {
        computer: computerId,
        session: notice.session_id,
        kind: notice.kind,
      },
    };
    const results = await Promise.all(
      devices.map(async (device) => ({
        device,
        result: await this.sender.send(device.token, device.environment, alert),
      })),
    );
    const pruned: string[] = [];
    let sent = 0;
    for (const { device, result } of results) {
      if (result.status === 200) sent++;
      else if (prunable(result.status, result.reason)) {
        this.devices.prune(device.token);
        pruned.push(device.token);
      }
    }
    return { sent, pruned, dropped: null };
  }
}
