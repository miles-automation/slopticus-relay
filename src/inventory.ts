import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const INVENTORY_TTL = 45000;
export const observationSchema = z
  .object({
    instance: z.string().uuid(),
    native: z.string().min(1).max(160),
    provider: z.enum(["claude", "codex"]),
    source: z.enum(["claude-hook", "slopticus-bridge"]),
    surface: z.enum(["desktop", "terminal", "managed", "unknown"]),
    project: z.string().max(240),
    activity: z.enum(["working", "idle", "ended", "unknown"]),
    observed: z.number().int().nonnegative(),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;
export const reportSchema = z
  .object({
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    observations: z.array(observationSchema).max(200),
    coverage: z.enum(["instrumented", "degraded"]),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      new Set(data.observations.map((o) => o.instance)).size !==
      data.observations.length
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate instance",
      });
  });
export type InventoryReport = z.infer<typeof reportSchema>;
export type ComputerView = {
  id: string;
  name: string;
  revoked: boolean;
  online: boolean;
  last_seen: number | null;
  coverage: string;
  sessions: (Observation & { stale: boolean; reported_at: number })[];
};
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export class InventoryStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS computers(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      revoked INTEGER NOT NULL DEFAULT 0, last_seen INTEGER, sequence INTEGER NOT NULL DEFAULT 0,
      report_hash TEXT, coverage TEXT NOT NULL DEFAULT 'unconnected',
      workspace_id TEXT REFERENCES workspaces(id));
      CREATE TABLE IF NOT EXISTS inventory_instances(
        computer_id TEXT NOT NULL REFERENCES computers(id), instance TEXT NOT NULL,
        body TEXT NOT NULL, last_seen INTEGER NOT NULL,
        PRIMARY KEY(computer_id,instance));`);
    if (
      !db
        .prepare("PRAGMA table_info(computers)")
        .all()
        .some((column) => column.name === "workspace_id")
    )
      db.exec(
        "ALTER TABLE computers ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
      );
  }
  pair(
    name: string,
    token = randomUUID() + randomUUID(),
    workspaceId: string,
  ): { id: string; token: string } {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO computers(id,name,token_hash,workspace_id) VALUES(?,?,?,?)",
      )
      .run(id, name, digest(token), workspaceId);
    return { id, token };
  }
  authenticate(token: string): string | undefined {
    const row = this.db
      .prepare("SELECT id FROM computers WHERE token_hash=? AND revoked=0")
      .get(digest(token));
    return row ? String(row.id) : undefined;
  }
  workspaceOf(id: string): string | undefined {
    const row = this.db
      .prepare("SELECT workspace_id FROM computers WHERE id=?")
      .get(id);
    return row ? String(row.workspace_id) : undefined;
  }
  revoke(id: string, workspaceId?: string): boolean {
    const result = workspaceId
      ? this.db
          .prepare(
            "UPDATE computers SET revoked=1 WHERE id=? AND workspace_id=?",
          )
          .run(id, workspaceId)
      : this.db.prepare("UPDATE computers SET revoked=1 WHERE id=?").run(id);
    return result.changes > 0;
  }
  report(id: string, input: InventoryReport, now = Date.now()): void {
    const report = reportSchema.parse(input);
    const computer = this.db
      .prepare(
        "SELECT sequence,report_hash FROM computers WHERE id=? AND revoked=0",
      )
      .get(id);
    if (!computer) throw new Error("Computer disconnected");
    const fingerprint = digest(JSON.stringify(report));
    if (
      report.sequence === computer.sequence &&
      computer.report_hash === fingerprint
    )
      return;
    if (report.sequence <= Number(computer.sequence))
      throw new Error("Stale or conflicting report sequence");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const observation of report.observations) {
        const old = this.db
          .prepare(
            "SELECT body FROM inventory_instances WHERE computer_id=? AND instance=?",
          )
          .get(id, observation.instance);
        if (old) {
          const previous = observationSchema.parse(
            JSON.parse(String(old.body)),
          );
          if (previous.activity === "ended" && observation.activity !== "ended")
            throw new Error("Ended instance cannot reopen");
          if (
            previous.native !== observation.native ||
            previous.provider !== observation.provider ||
            previous.source !== observation.source
          )
            throw new Error("Instance identity changed");
        }
        this.db
          .prepare(
            "INSERT INTO inventory_instances VALUES(?,?,?,?) ON CONFLICT(computer_id,instance) DO UPDATE SET body=excluded.body,last_seen=excluded.last_seen",
          )
          .run(id, observation.instance, JSON.stringify(observation), now);
      }
      this.db
        .prepare(
          "UPDATE computers SET sequence=?,report_hash=?,last_seen=?,coverage=? WHERE id=?",
        )
        .run(report.sequence, fingerprint, now, report.coverage, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(now = Date.now(), workspaceId?: string): ComputerView[] {
    return this.db
      .prepare(
        `SELECT id,name,revoked,last_seen,coverage FROM computers
        ${workspaceId ? "WHERE workspace_id=?" : ""} ORDER BY name,id`,
      )
      .all(...(workspaceId ? [workspaceId] : []))
      .map((row) => {
        const online =
          !row.revoked &&
          row.last_seen !== null &&
          now - Number(row.last_seen) < INVENTORY_TTL;
        return {
          id: String(row.id),
          name: String(row.name),
          revoked: Boolean(row.revoked),
          online,
          last_seen: row.last_seen === null ? null : Number(row.last_seen),
          coverage: String(row.coverage),
          sessions: this.db
            .prepare(
              "SELECT body,last_seen FROM inventory_instances WHERE computer_id=? ORDER BY last_seen DESC,instance",
            )
            .all(row.id!)
            .map((item) => {
              const observation = observationSchema.parse(
                JSON.parse(String(item.body)),
              );
              const stale =
                !online || now - Number(item.last_seen) >= INVENTORY_TTL;
              return {
                ...observation,
                reported_at: Number(item.last_seen),
                activity:
                  stale && observation.activity !== "ended"
                    ? "unknown"
                    : observation.activity,
                stale,
              };
            }),
        };
      });
  }
}
