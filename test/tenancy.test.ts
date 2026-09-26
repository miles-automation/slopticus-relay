import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash } from "../src/store.js";
import { createApp } from "../src/app.js";
import { InventoryStore } from "../src/inventory.js";
import {
  LEGACY_WORKSPACE_ID,
  LegacyAlreadyClaimedError,
  TenancyStore,
} from "../src/tenancy.js";

async function fixture(
  publicSignup = true,
  ownerToken = publicSignup ? "" : "k".repeat(40),
): Promise<{
  store: Store;
  base: string;
  call: (path: string, body?: unknown, cookie?: string) => Promise<Response>;
  close: () => Promise<void>;
}> {
  const store = new Store(":memory:");
  const server: Server = createApp(store, {
    ownerToken,
    origin: "https://slopticus.test",
    publicSignup,
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (
    path: string,
    body?: unknown,
    cookie?: string,
  ): Promise<Response> =>
    fetch(`${base}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    store,
    base,
    call,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

test("public signup stays closed during the compatibility rollout while the legacy owner can migrate", async () => {
  const f = await fixture(false);
  try {
    assert.deepEqual(await (await f.call("config")).json(), {
      public_signup: false,
    });
    const rejected = await f.call("signup", {
      username: "alice",
      display_name: "Alice",
      password: "safe password 12345",
    });
    assert.equal(rejected.status, 403);
    const legacy = await f.call("login", { token: "k".repeat(40) });
    assert.equal(legacy.status, 200);
    const cookie = legacy.headers.get("set-cookie")!.split(";")[0]!;
    const owner = await signup(f.call, "owner", cookie);
    assert.equal((await f.call("me", undefined, cookie)).status, 401);
    assert.equal((await f.call("me", undefined, owner.cookie)).status, 200);
  } finally {
    await f.close();
  }
});

test("a configured legacy owner key keeps public signup closed even if the flag is on", async () => {
  const f = await fixture(true, "k".repeat(40));
  try {
    assert.deepEqual(await (await f.call("config")).json(), {
      public_signup: false,
    });
    assert.equal(
      (
        await f.call("signup", {
          username: "alice",
          display_name: "Alice",
          password: "safe password 12345",
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("parallel legacy signups create only the account that claims existing computers", async () => {
  const f = await fixture(false);
  try {
    const legacy = await f.call("login", { token: "k".repeat(40) });
    const cookie = legacy.headers.get("set-cookie")!.split(";")[0]!;
    const [first, second] = await Promise.all(
      ["first", "second"].map((username) =>
        f.call(
          "signup",
          {
            username,
            display_name: username,
            password: "safe password 12345",
          },
          cookie,
        ),
      ),
    );
    const responses = [first, second];
    assert.equal(
      responses.filter((response) => response.status === 200).length,
      1,
    );
    assert.ok(
      responses.some((response) => [403, 409].includes(response.status)),
    );
    assert.equal(
      f.store.db.prepare("SELECT count(*) AS n FROM accounts").get()!.n,
      1,
    );
    const winner = responses.find((response) => response.status === 200)!;
    const winnerCookie = winner.headers.get("set-cookie")!.split(";")[0]!;
    const me = (await (await f.call("me", undefined, winnerCookie)).json()) as {
      workspaces: { id: string }[];
    };
    assert.ok(
      me.workspaces.some((workspace) => workspace.id === LEGACY_WORKSPACE_ID),
    );
    assert.equal((await f.call("me", undefined, cookie)).status, 401);
  } finally {
    await f.close();
  }
});

test("atomic legacy claim rolls back a second account after password hashing", async () => {
  const store = new Store(":memory:");
  try {
    const tenancy = new TenancyStore(store.db);
    const results = await Promise.allSettled([
      tenancy.createAccount("first", "First", "safe password 12345", true),
      tenancy.createAccount("second", "Second", "safe password 12345", true),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.ok(
      results.some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof LegacyAlreadyClaimedError,
      ),
    );
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM accounts").get()!.n,
      1,
    );
  } finally {
    store.close();
  }
});

async function signup(
  call: (path: string, body?: unknown, cookie?: string) => Promise<Response>,
  username: string,
  cookie?: string,
): Promise<{ cookie: string; workspaceId: string; recoveryCode: string }> {
  const response = await call(
    "signup",
    {
      username,
      display_name: username,
      password: "safe password 12345",
    },
    cookie,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    workspace_id: string;
    recovery_code: string;
  };
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    workspaceId: body.workspace_id,
    recoveryCode: body.recovery_code,
  };
}

test("account recovery is scoped and rotates credentials and sessions", async () => {
  const f = await fixture();
  try {
    const alice = await signup(f.call, "alice");
    const bob = await signup(f.call, "bob");
    const aliceHash = hash(alice.cookie.split("=")[1]!);
    assert.equal(
      f.store.db
        .prepare("SELECT token_hash FROM logins WHERE token_hash=?")
        .get(aliceHash),
      undefined,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT account_id FROM account_logins WHERE token_hash=?")
        .get(aliceHash) !== undefined,
      true,
    );
    const codeResponse = await f.call("access-codes", {}, alice.cookie);
    assert.equal(codeResponse.status, 200);
    const code = (await codeResponse.json()) as { code: string };
    const redeemed = await f.call("login/code", { code: code.code });
    assert.equal(redeemed.status, 200);
    const redeemedCookie = redeemed.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await f.call("me", undefined, redeemedCookie)).status, 200);
    assert.equal(
      f.store.db
        .prepare("SELECT token_hash FROM logins WHERE token_hash=?")
        .get(hash(redeemedCookie.split("=")[1]!)),
      undefined,
    );
    assert.equal(
      (
        await f.call(
          `computers?workspace_id=${alice.workspaceId}`,
          undefined,
          bob.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call("recover", {
          username: "bob",
          recovery_code: alice.recoveryCode,
          password: "different password 12345",
        })
      ).status,
      401,
    );
    const response = await f.call("recover", {
      username: "alice",
      recovery_code: alice.recoveryCode,
      password: "different password 12345",
    });
    assert.equal(response.status, 200);
    const recovery = (await response.json()) as { recovery_code: string };
    assert.notEqual(recovery.recovery_code, alice.recoveryCode);
    assert.equal((await f.call("me", undefined, alice.cookie)).status, 401);
    assert.equal((await f.call("me", undefined, redeemedCookie)).status, 401);
    assert.equal(
      (
        await f.call("recover", {
          username: "alice",
          recovery_code: alice.recoveryCode,
          password: "another password 12345",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.call("login/account", {
          username: "alice",
          password: "different password 12345",
        })
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("shared workspaces isolate inventory and require a workspace administrator to approve or revoke a Mac", async () => {
  const f = await fixture();
  try {
    const alice = await signup(f.call, "alice");
    const bob = await signup(f.call, "bob");
    const teamResponse = await f.call(
      "organizations",
      { name: "Acme" },
      alice.cookie,
    );
    assert.equal(teamResponse.status, 201);
    const team = (await teamResponse.json()) as {
      id: string;
      organization_id: string;
    };
    assert.equal(
      (await f.call(`computers?workspace_id=${team.id}`, undefined, bob.cookie))
        .status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `organizations/${team.organization_id}/workspaces`,
          { name: "Secret" },
          bob.cookie,
        )
      ).status,
      403,
    );
    const invitation = await f.call(
      `workspaces/${team.id}/invitations`,
      { role: "member" },
      alice.cookie,
    );
    assert.equal(invitation.status, 201);
    const { code } = (await invitation.json()) as { code: string };
    assert.equal(
      (await f.call("invitations/accept", { code }, bob.cookie)).status,
      200,
    );
    assert.equal(
      (await f.call("invitations/accept", { code }, bob.cookie)).status,
      410,
    );
    assert.equal(
      (await f.call(`computers?workspace_id=${team.id}`, undefined, bob.cookie))
        .status,
      200,
    );
    assert.equal(
      (
        await f.call(
          `workspaces/${team.id}/invitations`,
          { role: "admin" },
          bob.cookie,
        )
      ).status,
      403,
    );
    const begin = await f.call("computer-pairing", { name: "Team Mac" });
    const pending = (await begin.json()) as {
      code: string;
      device_code: string;
    };
    assert.equal(
      (
        await f.call(
          `computer-pairing/${pending.code}/decision`,
          { approve: false, workspace_id: team.id },
          bob.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `computer-pairing/${pending.code}/decision`,
          {
            approve: true,
            workspace_id: team.id,
          },
          bob.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `computer-pairing/${pending.code}/decision`,
          {
            approve: true,
            workspace_id: team.id,
          },
          alice.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(
          `computer-pairing/${pending.code}/decision`,
          {
            approve: true,
            workspace_id: alice.workspaceId,
          },
          alice.cookie,
        )
      ).status,
      410,
    );
    const claimed = await f.call("computer-pairing/claim", {
      device_code: pending.device_code,
    });
    const { token } = (await claimed.json()) as { token: string };
    const teamInventory = await f.call(
      `computers?workspace_id=${team.id}`,
      undefined,
      bob.cookie,
    );
    const computers = (await teamInventory.json()) as {
      id: string;
      name: string;
    }[];
    assert.deepEqual(
      computers.map((computer) => computer.name),
      ["Team Mac"],
    );
    assert.deepEqual(
      await (
        await f.call(
          `computers?workspace_id=${alice.workspaceId}`,
          undefined,
          alice.cookie,
        )
      ).json(),
      [],
    );
    assert.equal(
      (
        await f.call(
          `computers/${computers[0]!.id}/revoke`,
          {
            workspace_id: team.id,
          },
          bob.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `computers/${computers[0]!.id}/revoke`,
          {
            workspace_id: alice.workspaceId,
          },
          alice.cookie,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          `computers/${computers[0]!.id}/revoke`,
          {
            workspace_id: team.id,
          },
          alice.cookie,
        )
      ).status,
      200,
    );
    assert.equal(new InventoryStore(f.store.db).authenticate(token), undefined);
    const carol = await signup(f.call, "carol");
    const adminInvite = await f.call(
      `workspaces/${team.id}/invitations`,
      {
        role: "organization_admin",
      },
      alice.cookie,
    );
    assert.equal(adminInvite.status, 201);
    const adminCode = ((await adminInvite.json()) as { code: string }).code;
    assert.equal(
      (await f.call("invitations/accept", { code: adminCode }, carol.cookie))
        .status,
      200,
    );
    const newWorkspace = await f.call(
      `organizations/${team.organization_id}/workspaces`,
      {
        name: "Research",
      },
      carol.cookie,
    );
    assert.equal(newWorkspace.status, 201);
    const research = (await newWorkspace.json()) as { id: string };
    assert.equal(
      (
        await f.call(
          `computers?workspace_id=${research.id}`,
          undefined,
          alice.cookie,
        )
      ).status,
      200,
    );
    const ownerWorkspace = await f.call(
      `organizations/${team.organization_id}/workspaces`,
      { name: "Finance" },
      alice.cookie,
    );
    const finance = (await ownerWorkspace.json()) as { id: string };
    assert.equal(
      (
        await f.call(
          `computers?workspace_id=${finance.id}`,
          undefined,
          carol.cookie,
        )
      ).status,
      403,
    );
    const bobId = (
      (await f
        .call("me", undefined, bob.cookie)
        .then((response) => response.json())) as {
        account: { id: string };
      }
    ).account.id;
    assert.equal(
      (
        await f.call(
          `workspaces/${team.id}/members/${bobId}/remove`,
          {},
          carol.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.call(`computers?workspace_id=${team.id}`, undefined, bob.cookie))
        .status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `computers?workspace_id=${bob.workspaceId}`,
          undefined,
          bob.cookie,
        )
      ).status,
      200,
    );
    const carolId = (
      (await (await f.call("me", undefined, carol.cookie)).json()) as {
        account: { id: string };
      }
    ).account.id;
    const pendingInvite = await f.call(
      `workspaces/${research.id}/invitations`,
      { role: "member" },
      carol.cookie,
    );
    const pendingCode = ((await pendingInvite.json()) as { code: string }).code;
    assert.equal(
      (
        await f.call(
          `organizations/${team.organization_id}/members`,
          undefined,
          bob.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `organizations/${team.organization_id}/members/${carolId}/remove`,
          {},
          bob.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `organizations/${team.organization_id}/members/${carolId}/remove`,
          {},
          alice.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(
          `computers?workspace_id=${research.id}`,
          undefined,
          carol.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.call("invitations/accept", { code: pendingCode }, bob.cookie))
        .status,
      410,
    );
  } finally {
    await f.close();
  }
});

test("existing computer credentials migrate to a legacy workspace and claiming it retires the server key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopticus-tenant-migration-"));
  const path = join(dir, "relay.sqlite");
  const old = new DatabaseSync(path);
  const credential = "old-computer-credential";
  old.exec(`CREATE TABLE logins(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE TABLE computers(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,
    revoked INTEGER NOT NULL DEFAULT 0,last_seen INTEGER,sequence INTEGER NOT NULL DEFAULT 0,
    report_hash TEXT,coverage TEXT NOT NULL DEFAULT 'unconnected');`);
  old
    .prepare("INSERT INTO computers(id,name,token_hash) VALUES(?,?,?)")
    .run("11111111-1111-4111-8111-111111111111", "Old Mac", hash(credential));
  old.close();
  const store = new Store(path);
  try {
    const inventory = new InventoryStore(store.db);
    const tenancy = new TenancyStore(store.db);
    assert.equal(
      inventory.workspaceOf("11111111-1111-4111-8111-111111111111"),
      LEGACY_WORKSPACE_ID,
    );
    assert.equal(
      inventory.authenticate(credential),
      "11111111-1111-4111-8111-111111111111",
    );
    const account = await tenancy.createAccount(
      "owner",
      "Owner",
      "safe password 12345",
    );
    assert.equal(tenancy.claimLegacy(account.account_id), true);
    assert.equal(tenancy.claimLegacy(account.account_id), false);
    assert.equal(
      tenancy.workspace(account.account_id, LEGACY_WORKSPACE_ID)?.role,
      "owner",
    );
    assert.equal(
      inventory.authenticate(credential),
      "11111111-1111-4111-8111-111111111111",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true });
  }
});
