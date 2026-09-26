import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { TenancyStore } from "./tenancy.js";

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
];
const PURGED_VERSION = 1;
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS logins(token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access_codes(code_hash TEXT PRIMARY KEY, login_hash TEXT UNIQUE NOT NULL
        REFERENCES logins(token_hash) ON DELETE CASCADE, expires INTEGER NOT NULL);`);
    new TenancyStore(this.db);
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
      for (const name of RETIRED_TABLES)
        if (present.includes(name)) this.db.exec(`DROP TABLE ${name}`);
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
