import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const LEGACY_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
export const LEGACY_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const passwordOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export type WorkspaceRole = "member" | "admin" | "owner";
export class LegacyAlreadyClaimedError extends Error {}
export type WorkspaceView = {
  id: string;
  name: string;
  kind: "private" | "shared";
  organization_id: string;
  organization_name: string;
  role: WorkspaceRole;
  organization_role: WorkspaceRole;
};

async function passwordDigest(password: string, salt: string): Promise<string> {
  const derived = await new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password, salt, 64, passwordOptions, (error, key) =>
      error ? reject(error) : resolve(key as Buffer),
    ),
  );
  return derived.toString("hex");
}

export class TenancyStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      recovery_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS organizations(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('personal','team','legacy')));
      CREATE TABLE IF NOT EXISTS organization_members(
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
      PRIMARY KEY(organization_id,account_id));
      CREATE TABLE IF NOT EXISTS workspaces(
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('private','shared')));
      CREATE TABLE IF NOT EXISTS workspace_members(
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
      PRIMARY KEY(workspace_id,account_id));
      CREATE TABLE IF NOT EXISTS workspace_invitations(
      code_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      role TEXT NOT NULL CHECK(role IN ('admin','member')),
      organization_role TEXT NOT NULL DEFAULT 'member' CHECK(organization_role IN ('admin','member')),
      expires INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES accounts(id));
      CREATE TABLE IF NOT EXISTS account_logins(
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
      expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_access_codes(
      code_hash TEXT PRIMARY KEY, login_hash TEXT UNIQUE NOT NULL
      REFERENCES account_logins(token_hash) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tenancy_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (
      !db
        .prepare("PRAGMA table_info(workspace_invitations)")
        .all()
        .some((column) => column.name === "organization_role")
    )
      db.exec(
        "ALTER TABLE workspace_invitations ADD COLUMN organization_role TEXT NOT NULL DEFAULT 'member'",
      );
    db.prepare(
      "INSERT OR IGNORE INTO organizations(id,name,kind) VALUES(?,?,'legacy')",
    ).run(LEGACY_ORGANIZATION_ID, "Existing Slopticus");
    db.prepare(
      "INSERT OR IGNORE INTO workspaces(id,organization_id,name,kind) VALUES(?,?,?,'private')",
    ).run(LEGACY_WORKSPACE_ID, LEGACY_ORGANIZATION_ID, "Existing computers");
    db.exec(`INSERT OR IGNORE INTO workspace_members(workspace_id,account_id,role)
      SELECT w.id,om.account_id,'owner' FROM workspaces w
      JOIN organizations o ON o.id=w.organization_id AND o.kind='team'
      JOIN organization_members om ON om.organization_id=o.id AND om.role='owner'`);
  }

  isLegacyClaimed(): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT value FROM tenancy_settings WHERE key='legacy_claimed_by'",
        )
        .get(),
    );
  }

  claimLegacy(accountId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.claimLegacyInTransaction(accountId)) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private claimLegacyInTransaction(accountId: string): boolean {
    if (this.isLegacyClaimed()) return false;
    this.db
      .prepare("INSERT INTO organization_members VALUES(?,?, 'owner')")
      .run(LEGACY_ORGANIZATION_ID, accountId);
    this.db
      .prepare("INSERT INTO workspace_members VALUES(?,?, 'owner')")
      .run(LEGACY_WORKSPACE_ID, accountId);
    this.db
      .prepare("INSERT INTO tenancy_settings VALUES('legacy_claimed_by',?)")
      .run(accountId);
    this.db.prepare("DELETE FROM logins").run();
    return true;
  }

  async createAccount(
    username: string,
    displayName: string,
    password: string,
    claimLegacy = false,
  ): Promise<{
    account_id: string;
    recovery_code: string;
    workspace_id: string;
  }> {
    const salt = randomBytes(16).toString("hex");
    const digest = await passwordDigest(password, salt);
    const recovery = randomBytes(32).toString("base64url");
    const accountId = randomUUID();
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (claimLegacy && this.isLegacyClaimed())
        throw new LegacyAlreadyClaimedError(
          "Existing computers were already claimed",
        );
      this.db
        .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?,?)")
        .run(
          accountId,
          username,
          displayName,
          salt,
          digest,
          hash(recovery),
          Date.now(),
        );
      this.db
        .prepare("INSERT INTO organizations VALUES(?,?,'personal')")
        .run(organizationId, `${displayName}'s space`);
      this.db
        .prepare("INSERT INTO organization_members VALUES(?,?, 'owner')")
        .run(organizationId, accountId);
      this.db
        .prepare("INSERT INTO workspaces VALUES(?,?,?,'private')")
        .run(workspaceId, organizationId, "My computers");
      this.db
        .prepare("INSERT INTO workspace_members VALUES(?,?, 'owner')")
        .run(workspaceId, accountId);
      if (claimLegacy && !this.claimLegacyInTransaction(accountId))
        throw new LegacyAlreadyClaimedError(
          "Existing computers were already claimed",
        );
      this.db.exec("COMMIT");
      return {
        account_id: accountId,
        recovery_code: recovery,
        workspace_id: workspaceId,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async authenticate(
    username: string,
    password: string,
  ): Promise<string | undefined> {
    const row = this.db
      .prepare(
        "SELECT id,password_salt,password_hash FROM accounts WHERE username=?",
      )
      .get(username);
    const digest = await passwordDigest(
      password,
      String(row?.password_salt ?? "0".repeat(32)),
    );
    if (
      !row ||
      !timingSafeEqual(
        Buffer.from(digest),
        Buffer.from(String(row.password_hash)),
      )
    )
      return undefined;
    return String(row.id);
  }

  async recover(
    username: string,
    recoveryCode: string,
    newPassword: string,
  ): Promise<{ account_id: string; recovery_code: string } | undefined> {
    const row = this.db
      .prepare("SELECT id,recovery_hash FROM accounts WHERE username=?")
      .get(username);
    if (
      !row ||
      !timingSafeEqual(
        Buffer.from(hash(recoveryCode)),
        Buffer.from(String(row.recovery_hash)),
      )
    )
      return undefined;
    const salt = randomBytes(16).toString("hex");
    const digest = await passwordDigest(newPassword, salt);
    const replacement = randomBytes(32).toString("base64url");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db
        .prepare(
          "UPDATE accounts SET password_salt=?,password_hash=?,recovery_hash=? WHERE id=? AND recovery_hash=?",
        )
        .run(
          salt,
          digest,
          hash(replacement),
          row.id!,
          row.recovery_hash!,
        ).changes;
      if (!changed) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db
        .prepare("DELETE FROM account_logins WHERE account_id=?")
        .run(row.id!);
      this.db.exec("COMMIT");
      return { account_id: String(row.id), recovery_code: replacement };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  account(
    accountId: string,
  ): { id: string; username: string; display_name: string } | undefined {
    const row = this.db
      .prepare("SELECT id,username,display_name FROM accounts WHERE id=?")
      .get(accountId);
    return row
      ? {
          id: String(row.id),
          username: String(row.username),
          display_name: String(row.display_name),
        }
      : undefined;
  }

  workspaces(accountId: string): WorkspaceView[] {
    return this.db
      .prepare(
        `SELECT w.id,w.name,w.kind,w.organization_id,o.name AS organization_name,
      wm.role,om.role AS organization_role FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.account_id=?
      JOIN organizations o ON o.id=w.organization_id
      JOIN organization_members om ON om.organization_id=o.id AND om.account_id=?
      ORDER BY o.name,w.name`,
      )
      .all(accountId, accountId)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        kind: row.kind as WorkspaceView["kind"],
        organization_id: String(row.organization_id),
        organization_name: String(row.organization_name),
        role: row.role as WorkspaceRole,
        organization_role: row.organization_role as WorkspaceRole,
      }));
  }

  workspace(accountId: string, workspaceId: string): WorkspaceView | undefined {
    return this.workspaces(accountId).find(
      (workspace) => workspace.id === workspaceId,
    );
  }

  createOrganization(accountId: string, name: string): WorkspaceView {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO organizations VALUES(?,?,'team')")
        .run(organizationId, name);
      this.db
        .prepare("INSERT INTO organization_members VALUES(?,?, 'owner')")
        .run(organizationId, accountId);
      this.db
        .prepare("INSERT INTO workspaces VALUES(?,?,?,'shared')")
        .run(workspaceId, organizationId, "Shared computers");
      this.db
        .prepare("INSERT INTO workspace_members VALUES(?,?, 'owner')")
        .run(workspaceId, accountId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.workspace(accountId, workspaceId)!;
  }

  createWorkspace(
    accountId: string,
    organizationId: string,
    name: string,
  ): WorkspaceView | undefined {
    const member = this.db
      .prepare(
        `SELECT om.role FROM organization_members om
      JOIN organizations o ON o.id=om.organization_id
      WHERE o.id=? AND o.kind='team' AND om.account_id=?`,
      )
      .get(organizationId, accountId);
    if (!member || member.role === "member") return undefined;
    const workspaceId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO workspaces VALUES(?,?,?,'shared')")
        .run(workspaceId, organizationId, name);
      this.db
        .prepare(
          `INSERT INTO workspace_members(workspace_id,account_id,role)
          SELECT ?,account_id,'owner' FROM organization_members
          WHERE organization_id=? AND role='owner'`,
        )
        .run(workspaceId, organizationId);
      this.db
        .prepare("INSERT OR IGNORE INTO workspace_members VALUES(?,?, 'admin')")
        .run(workspaceId, accountId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.workspace(accountId, workspaceId);
  }

  invite(
    accountId: string,
    workspaceId: string,
    role: "member" | "admin" | "organization_admin",
  ): string | undefined {
    const workspace = this.workspace(accountId, workspaceId);
    if (
      !workspace ||
      workspace.kind !== "shared" ||
      workspace.role === "member"
    )
      return undefined;
    if (
      role === "organization_admin" &&
      workspace.organization_role !== "owner"
    )
      return undefined;
    const code = randomBytes(24).toString("base64url");
    this.db
      .prepare("INSERT INTO workspace_invitations VALUES(?,?,?,?,?,?)")
      .run(
        hash(code),
        workspaceId,
        role === "member" ? "member" : "admin",
        role === "organization_admin" ? "admin" : "member",
        Date.now() + 7 * 86400000,
        accountId,
      );
    return code;
  }

  members(
    accountId: string,
    workspaceId: string,
  ):
    | {
        id: string;
        username: string;
        display_name: string;
        role: WorkspaceRole;
      }[]
    | undefined {
    const workspace = this.workspace(accountId, workspaceId);
    if (!workspace || workspace.role === "member") return undefined;
    return this.db
      .prepare(
        `SELECT a.id,a.username,a.display_name,wm.role FROM workspace_members wm
      JOIN accounts a ON a.id=wm.account_id WHERE wm.workspace_id=? ORDER BY a.username`,
      )
      .all(workspaceId)
      .map((row) => ({
        id: String(row.id),
        username: String(row.username),
        display_name: String(row.display_name),
        role: row.role as WorkspaceRole,
      }));
  }

  removeMember(
    accountId: string,
    workspaceId: string,
    targetId: string,
  ): boolean {
    const workspace = this.workspace(accountId, workspaceId);
    if (!workspace || workspace.role === "member" || accountId === targetId)
      return false;
    const target = this.db
      .prepare(
        "SELECT role FROM workspace_members WHERE workspace_id=? AND account_id=?",
      )
      .get(workspaceId, targetId);
    if (
      !target ||
      target.role === "owner" ||
      (target.role === "admin" && workspace.role !== "owner")
    )
      return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "DELETE FROM workspace_invitations WHERE workspace_id=? AND created_by=?",
        )
        .run(workspaceId, targetId);
      const removed =
        this.db
          .prepare(
            "DELETE FROM workspace_members WHERE workspace_id=? AND account_id=?",
          )
          .run(workspaceId, targetId).changes > 0;
      this.db.exec("COMMIT");
      return removed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  organizationMembers(
    accountId: string,
    organizationId: string,
  ): { id: string; username: string; role: WorkspaceRole }[] | undefined {
    const actor = this.db
      .prepare(
        "SELECT role FROM organization_members WHERE organization_id=? AND account_id=?",
      )
      .get(organizationId, accountId);
    if (!actor || actor.role !== "owner") return undefined;
    return this.db
      .prepare(
        `SELECT a.id,a.username,om.role FROM organization_members om
        JOIN accounts a ON a.id=om.account_id
        WHERE om.organization_id=? ORDER BY a.username`,
      )
      .all(organizationId)
      .map((row) => ({
        id: String(row.id),
        username: String(row.username),
        role: row.role as WorkspaceRole,
      }));
  }

  removeOrganizationMember(
    accountId: string,
    organizationId: string,
    targetId: string,
  ): boolean {
    if (
      accountId === targetId ||
      !this.organizationMembers(accountId, organizationId)
    )
      return false;
    const target = this.db
      .prepare(
        "SELECT role FROM organization_members WHERE organization_id=? AND account_id=?",
      )
      .get(organizationId, targetId);
    if (!target || target.role === "owner") return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `DELETE FROM workspace_invitations WHERE created_by=? AND workspace_id IN
          (SELECT id FROM workspaces WHERE organization_id=?)`,
        )
        .run(targetId, organizationId);
      this.db
        .prepare(
          `DELETE FROM workspace_members WHERE account_id=? AND workspace_id IN
          (SELECT id FROM workspaces WHERE organization_id=?)`,
        )
        .run(targetId, organizationId);
      const removed =
        this.db
          .prepare(
            "DELETE FROM organization_members WHERE organization_id=? AND account_id=?",
          )
          .run(organizationId, targetId).changes > 0;
      this.db.exec("COMMIT");
      return removed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  acceptInvitation(accountId: string, code: string): WorkspaceView | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `DELETE FROM workspace_invitations
        WHERE code_hash=? AND expires>? RETURNING workspace_id,role,organization_role`,
        )
        .get(hash(code), Date.now());
      if (!row) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const workspaceId = String(row.workspace_id);
      const organization = this.db
        .prepare(
          "SELECT organization_id FROM workspaces WHERE id=? AND kind='shared'",
        )
        .get(workspaceId);
      if (!organization) throw new Error("Invitation workspace unavailable");
      this.db
        .prepare(
          `INSERT INTO organization_members VALUES(?,?,?)
        ON CONFLICT(organization_id,account_id) DO UPDATE SET role=CASE
        WHEN organization_members.role='owner' OR organization_members.role='admin' THEN organization_members.role
        ELSE excluded.role END`,
        )
        .run(organization.organization_id!, accountId, row.organization_role!);
      this.db
        .prepare(
          `INSERT INTO workspace_members VALUES(?,?,?)
        ON CONFLICT(workspace_id,account_id) DO UPDATE SET role=CASE
        WHEN workspace_members.role='owner' OR workspace_members.role='admin' THEN workspace_members.role
        ELSE excluded.role END`,
        )
        .run(workspaceId, accountId, row.role!);
      this.db.exec("COMMIT");
      return this.workspace(accountId, workspaceId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
