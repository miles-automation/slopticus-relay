import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function createTestWorkspace(db: DatabaseSync): string {
  const accountId = randomUUID();
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?,?)").run(
    accountId,
    accountId,
    "Test owner",
    "test-salt",
    "test-hash",
    "test-recovery",
    Date.now(),
  );
  db.prepare("INSERT INTO organizations VALUES(?,?,'personal')").run(
    organizationId,
    "Test organization",
  );
  db.prepare("INSERT INTO organization_members VALUES(?,?,'owner')").run(
    organizationId,
    accountId,
  );
  db.prepare("INSERT INTO workspaces VALUES(?,?,?,'private')").run(
    workspaceId,
    organizationId,
    "Test workspace",
  );
  db.prepare("INSERT INTO workspace_members VALUES(?,?,'owner')").run(
    workspaceId,
    accountId,
  );
  return workspaceId;
}
