import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash } from "../src/store.js";
import { InventoryStore } from "../src/inventory.js";
import { ComputerPairing } from "../src/computer-pairing.js";
import { TenancyStore } from "../src/tenancy.js";
import { createApp } from "../src/app.js";

test("pre-account computer credentials and owner sessions are retired on upgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "slopticus-owner-retirement-"));
  const path = join(dir, "relay.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA user_version=1;
    CREATE TABLE logins(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE access_codes(code_hash TEXT PRIMARY KEY,login_hash TEXT NOT NULL REFERENCES logins(token_hash),expires INTEGER NOT NULL);
    CREATE TABLE computers(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,
      revoked INTEGER NOT NULL DEFAULT 0,last_seen INTEGER,sequence INTEGER NOT NULL DEFAULT 0,
      report_hash TEXT,coverage TEXT NOT NULL DEFAULT 'unconnected');
    CREATE TABLE inventory_instances(computer_id TEXT NOT NULL REFERENCES computers(id),instance TEXT NOT NULL,body TEXT NOT NULL,last_seen INTEGER NOT NULL,PRIMARY KEY(computer_id,instance));
    INSERT INTO logins VALUES('old-owner',9999999999999);
    INSERT INTO access_codes VALUES('old-code','old-owner',9999999999999);`);
  old
    .prepare("INSERT INTO computers(id,name,token_hash) VALUES(?,?,?)")
    .run("old-mac", "Old Mac", hash("old-credential"));
  old.exec(
    "INSERT INTO inventory_instances VALUES('old-mac','old-instance','{}',1)",
  );
  old.close();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new Store(path);
      try {
        assert.equal(
          new InventoryStore(store.db).authenticate("old-credential"),
          undefined,
        );
        for (const table of [
          "computers",
          "inventory_instances",
          "computer_pairings",
          "organizations",
          "workspaces",
        ])
          assert.equal(
            store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
            0,
          );
        for (const table of ["logins", "access_codes", "tenancy_settings"])
          assert.equal(
            store.db
              .prepare("SELECT name FROM sqlite_master WHERE name=?")
              .get(table),
            undefined,
          );
        assert.deepEqual(
          store.db.prepare("PRAGMA foreign_key_check").all(),
          [],
        );
        assert.equal(
          store.db.prepare("PRAGMA user_version").get()!.user_version,
          2,
        );
      } finally {
        store.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("retirement deletes only unowned legacy data and preserves account credentials and claimed workspaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopticus-owner-preservation-"));
  const path = join(dir, "relay.sqlite");
  let store = new Store(path);
  try {
    const account = await new TenancyStore(store.db).createAccount(
      "owner",
      "Owner",
      "safe password 12345",
    );
    const accountId = account.account_id;
    const inventory = new InventoryStore(store.db);
    const computer = inventory.pair(
      "Account Mac",
      "account-credential",
      account.workspace_id,
    );
    store.db
      .prepare("INSERT INTO account_logins VALUES(?,?,?)")
      .run(hash("account-cookie"), accountId, Date.now() + 600000);
    store.db
      .prepare("INSERT INTO account_access_codes VALUES(?,?,?)")
      .run(hash("account-code"), hash("account-cookie"), Date.now() + 600000);
    store.db
      .exec(`INSERT INTO organizations VALUES('retired-org','Existing Slopticus','legacy');
      INSERT INTO workspaces VALUES('retired-workspace','retired-org','Existing computers','private');
      INSERT INTO computers(id,name,token_hash,workspace_id) VALUES('retired-mac','Old Mac','old-hash','retired-workspace');
      INSERT INTO inventory_instances VALUES('retired-mac','old-instance','{}',1);
      INSERT INTO computer_pairings VALUES('old-secret','old-code','Old Mac',9999999999999,1,'retired-mac','retired-workspace');
      INSERT INTO organizations VALUES('claimed-org','Claimed space','legacy');
      INSERT INTO workspaces VALUES('claimed-workspace','claimed-org','Claimed computers','private');
      CREATE TABLE logins(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
      CREATE TABLE access_codes(code_hash TEXT PRIMARY KEY,login_hash TEXT NOT NULL REFERENCES logins(token_hash),expires INTEGER NOT NULL);
      CREATE TABLE tenancy_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO logins VALUES('old-owner',9999999999999);
      INSERT INTO access_codes VALUES('old-code','old-owner',9999999999999);
      PRAGMA user_version=1;`);
    store.db
      .prepare(
        "INSERT INTO organization_members VALUES('claimed-org',?,'owner')",
      )
      .run(accountId);
    store.db
      .prepare(
        "INSERT INTO workspace_members VALUES('claimed-workspace',?,'owner')",
      )
      .run(accountId);
    const claimed = inventory.pair(
      "Claimed Mac",
      "claimed-credential",
      "claimed-workspace",
    );
    const pending = new ComputerPairing(store.db, inventory).begin(
      "Old pending request",
    );
    store.close();
    store = new Store(path);
    const updatedInventory = new InventoryStore(store.db);
    assert.equal(
      updatedInventory.authenticate("account-credential"),
      computer.id,
    );
    assert.equal(
      updatedInventory.authenticate("claimed-credential"),
      claimed.id,
    );
    assert.equal(
      store.db
        .prepare("SELECT kind FROM organizations WHERE id='claimed-org'")
        .get()!.kind,
      "personal",
    );
    assert.equal(
      store.db
        .prepare("SELECT id FROM organizations WHERE id='retired-org'")
        .get(),
      undefined,
    );
    assert.equal(
      store.db.prepare("SELECT id FROM computers WHERE id='retired-mac'").get(),
      undefined,
    );
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM inventory_instances").get()!
        .n,
      0,
    );
    assert.equal(
      new ComputerPairing(store.db, updatedInventory).claim(
        pending.device_code,
      ),
      undefined,
    );
    assert.equal(
      await new TenancyStore(store.db).authenticate(
        "owner",
        "safe password 12345",
      ),
      accountId,
    );
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM account_logins").get()!.n,
      1,
    );
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM account_access_codes").get()!
        .n,
      1,
    );
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    const fresh = new ComputerPairing(store.db, updatedInventory).begin(
      "New pending request",
    );
    store.close();
    store = new Store(path);
    assert.deepEqual(
      new ComputerPairing(store.db, new InventoryStore(store.db)).claim(
        fresh.device_code,
      ),
      { status: "pending" },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});

test("only the signup setting controls fresh accounts and retired owner routes cannot authenticate", async () => {
  for (const publicSignup of [false, true]) {
    const store = new Store(":memory:");
    const server = createApp(store, {
      origin: "http://localhost",
      publicSignup,
    }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "slopticus=retired-owner-cookie",
        },
        body: JSON.stringify(body),
      });
    try {
      assert.deepEqual(await (await fetch(base + "/api/config")).json(), {
        public_signup: publicSignup,
        push: false,
      });
      for (const path of ["/api/login", "/api/legacy/claim"])
        assert.equal(
          (
            await post(path, {
              token: "old-owner-key",
              recovery_key: "old-owner-key",
            })
          ).status,
          404,
        );
      assert.equal(
        (
          await fetch(base + "/api/me", {
            headers: { cookie: "slopticus=retired-owner-cookie" },
          })
        ).status,
        401,
      );
      const response = await post("/api/signup", {
        username: "fresh",
        display_name: "Fresh",
        password: "safe password 12345",
      });
      assert.equal(response.status, publicSignup ? 200 : 403);
      if (publicSignup) {
        const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
        const identity = (await (
          await fetch(base + "/api/me", { headers: { cookie } })
        ).json()) as { kind: string; workspaces: unknown[] };
        assert.equal(identity.kind, "account");
        assert.equal(identity.workspaces.length, 1);
        assert.equal("legacy_available" in identity, false);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  }
});
