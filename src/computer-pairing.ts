import { randomBytes, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { InventoryStore } from "./inventory.js";

export const PAIRING_TTL = 10 * 60_000;
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export class ComputerPairing {
  constructor(
    private db: DatabaseSync,
    private inventory: InventoryStore,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS computer_pairings(
      secret_hash TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      expires INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0,
      computer_id TEXT, workspace_id TEXT REFERENCES workspaces(id));`);
    if (
      !db
        .prepare("PRAGMA table_info(computer_pairings)")
        .all()
        .some((column) => column.name === "workspace_id")
    ) {
      db.exec(
        "ALTER TABLE computer_pairings ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
      );
    }
  }
  begin(
    name: string,
    now = Date.now(),
  ): { device_code: string; code: string; expires: number } {
    this.db.prepare("DELETE FROM computer_pairings WHERE expires<=?").run(now);
    if (
      Number(
        this.db.prepare("SELECT count(*) AS n FROM computer_pairings").get()!.n,
      ) >= 100
    )
      throw new Error(
        "Too many connection requests. Try again in ten minutes.",
      );
    const device_code = randomBytes(32).toString("hex");
    const code = randomBytes(6).toString("hex").toUpperCase();
    const expires = now + PAIRING_TTL;
    this.db
      .prepare(
        "INSERT INTO computer_pairings(secret_hash,code,name,expires) VALUES(?,?,?,?)",
      )
      .run(hash(device_code), code, name, expires);
    return { device_code, code, expires };
  }
  preview(
    code: string,
    now = Date.now(),
  ): { name: string; approved: boolean } | undefined {
    const row = this.db
      .prepare(
        "SELECT name,approved FROM computer_pairings WHERE code=? AND expires>?",
      )
      .get(code, now);
    return row
      ? { name: String(row.name), approved: Boolean(row.approved) }
      : undefined;
  }
  decide(
    code: string,
    approve: boolean,
    now = Date.now(),
    workspaceId: string,
  ): boolean {
    if (approve)
      return (
        this.db
          .prepare(
            "UPDATE computer_pairings SET approved=1,workspace_id=? WHERE code=? AND expires>? AND approved=0 AND computer_id IS NULL",
          )
          .run(workspaceId, code, now).changes > 0
      );
    return (
      this.db
        .prepare(
          "DELETE FROM computer_pairings WHERE code=? AND expires>? AND approved=0 AND computer_id IS NULL",
        )
        .run(code, now).changes > 0
    );
  }
  claim(
    secret: string,
    now = Date.now(),
  ): { status: "pending" } | { status: "approved"; token: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT name,approved,computer_id,workspace_id FROM computer_pairings WHERE secret_hash=? AND expires>?",
      )
      .get(hash(secret), now);
    if (!row) return undefined;
    if (!row.approved) return { status: "pending" };
    if (typeof row.workspace_id !== "string") return undefined;
    const token = hash(`slopticus-computer-reporting:${secret}`);
    if (row.computer_id) {
      if (!this.inventory.authenticate(token)) return undefined;
    } else {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const paired = this.inventory.pair(
          String(row.name),
          token,
          row.workspace_id,
        );
        this.db
          .prepare(
            "UPDATE computer_pairings SET computer_id=? WHERE secret_hash=?",
          )
          .run(paired.id, hash(secret));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    return { status: "approved", token };
  }
}
