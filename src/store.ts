import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { TenancyStore } from "./tenancy.js";
import { InventoryStore } from "./inventory.js";
import { ComputerPairing } from "./computer-pairing.js";

export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
const RETIRED_TABLES = [
  "claude_sessions",
  "replies",
  "outbound",
  "messages",
  "sessions",
  "subscriptions",
  "access_codes",
  "logins",
  "tenancy_settings",
];
const PURGED_VERSION = 2;
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    new TenancyStore(this.db);
    new ComputerPairing(this.db, new InventoryStore(this.db));
    this.purgeRetiredTables();
  }
  private purgeRetiredTables() {
    const present = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${RETIRED_TABLES.map(() => "?").join(",")})`,
      )
      .all(...RETIRED_TABLES)
      .map((row) => row.name);
    const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
    if (present.length === 0 && Number(version) >= PURGED_VERSION) return;
    this.db.exec("PRAGMA foreign_keys=OFF; BEGIN");
    try {
      this.db.exec(`CREATE TEMP TABLE retired_workspaces AS
        SELECT w.id FROM workspaces w JOIN organizations o ON o.id=w.organization_id
        WHERE o.kind='legacy'
        AND NOT EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=o.id)
        AND NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id);
        DELETE FROM computer_pairings WHERE workspace_id IS NULL OR workspace_id IN (SELECT id FROM retired_workspaces);
        DELETE FROM inventory_instances WHERE computer_id IN (
          SELECT id FROM computers WHERE workspace_id IS NULL OR workspace_id IN (SELECT id FROM retired_workspaces));
        DELETE FROM computers WHERE workspace_id IS NULL OR workspace_id IN (SELECT id FROM retired_workspaces);
        DELETE FROM workspace_invitations WHERE workspace_id IN (SELECT id FROM retired_workspaces);
        DELETE FROM workspaces WHERE id IN (SELECT id FROM retired_workspaces);
        DELETE FROM organizations WHERE kind='legacy'
          AND NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.organization_id=organizations.id)
          AND NOT EXISTS(SELECT 1 FROM organization_members m WHERE m.organization_id=organizations.id);
        UPDATE organizations SET kind='personal' WHERE kind='legacy';
        DROP TABLE retired_workspaces;`);
      for (const name of RETIRED_TABLES)
        if (present.includes(name)) this.db.exec(`DROP TABLE ${name}`);
      if (this.db.prepare("PRAGMA foreign_key_check").all().length > 0)
        throw new Error("Relay retirement would break account data references");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys=ON");
    }
    this.db.exec("VACUUM");
    for (let attempt = 0; attempt < 50; attempt++) {
      if (
        this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy === 0
      ) {
        this.db.exec(`PRAGMA user_version=${PURGED_VERSION}`);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    throw new Error(
      "Could not truncate the relay WAL after dropping retired tables",
    );
  }
  close() {
    this.db.close();
  }
}
