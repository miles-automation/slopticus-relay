import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";

test("old agent, inbox and session routes answer 426 so installed listeners stop", async () => {
  const store = new Store(":memory:");
  const server: Server = createApp(store, {
    ownerToken: "o".repeat(40),
    origin: "https://slopticus.test",
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const [method, path] of [
      ["GET", "/api/agent/replies"],
      ["POST", "/api/agent/heartbeat"],
      ["POST", "/api/agent/claude-listener"],
      ["GET", "/api/agent/session?version=0.12.0"],
      ["GET", "/api/inbox"],
      ["POST", "/api/sessions"],
      ["POST", "/api/sessions/00000000-0000-4000-8000-000000000001/messages"],
    ]) {
      const response = await fetch(base + path, {
        method,
        headers: {
          authorization: "Bearer old-session-key",
          "content-type": "application/json",
          "slopticus-protocol": "1",
        },
        body: method === "POST" ? "{}" : undefined,
      });
      assert.equal(response.status, 426, path);
      assert.deepEqual(await response.json(), {
        error: "Slopticus agent messaging was retired",
      });
    }
    assert.equal((await fetch(`${base}/api/computers`)).status, 401);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("opening the relay store scrubs retired messaging data, even after an interrupted purge, and keeps logins", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopticus-retired-db-"));
  const path = join(dir, "slopticus.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE claude_sessions(parent_id TEXT NOT NULL REFERENCES sessions(id), child_id TEXT NOT NULL REFERENCES sessions(id));
    CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
    CREATE TABLE replies(id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
    CREATE TABLE outbound(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
    CREATE TABLE subscriptions(endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL);
    CREATE TABLE logins(token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    INSERT INTO sessions VALUES ('s', 'Sturdy');
    INSERT INTO sessions VALUES ('c', 'child');
    INSERT INTO claude_sessions VALUES ('s', 'c');
    INSERT INTO messages VALUES ('m', 's', 'secret prompt');
    INSERT INTO replies VALUES ('r', 'm', 's', 'secret reply');
    INSERT INTO outbound VALUES ('o', 's', 'secret outbound');
    INSERT INTO subscriptions VALUES ('https://push.example/x', '{}');
    INSERT INTO logins VALUES ('h', 9999999999999);`);
  const writer = new DatabaseSync(path);
  writer.exec(
    "PRAGMA wal_autocheckpoint=0; INSERT INTO messages VALUES ('m2', 's', 'secret in wal');",
  );
  old.close();
  assert.equal(readFileSync(`${path}-wal`).includes("secret in wal"), true);
  const interrupted = new DatabaseSync(path);
  interrupted.exec(
    "DROP TABLE claude_sessions; DROP TABLE replies; DROP TABLE outbound; DROP TABLE messages; DROP TABLE sessions; DROP TABLE subscriptions;",
  );
  interrupted.close();
  assert.equal(
    [path, `${path}-wal`].some(
      (file) => existsSync(file) && readFileSync(file).includes("secret"),
    ),
    true,
  );
  try {
    for (let open = 0; open < 2; open++) {
      const store = new Store(path);
      assert.equal(
        store.db.prepare("PRAGMA user_version").get()?.user_version,
        1,
      );
      const tables = store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      assert.deepEqual(tables, [
        "access_codes",
        "account_access_codes",
        "account_logins",
        "accounts",
        "logins",
        "organization_members",
        "organizations",
        "tenancy_settings",
        "workspace_invitations",
        "workspace_members",
        "workspaces",
      ]);
      for (const file of [path, `${path}-wal`])
        if (existsSync(file))
          assert.equal(readFileSync(file).includes("secret"), false, file);
      assert.equal(
        store.db.prepare("SELECT count(*) AS n FROM logins").get()?.n,
        1,
      );
      store.close();
    }
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
