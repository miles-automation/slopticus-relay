import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { Store, hash } from "../src/store.js";
import { createApp } from "../src/app.js";
import { InventoryStore } from "../src/inventory.js";

async function fixture(publicSignup = true): Promise<{
  store: Store;
  base: string;
  call: (path: string, body?: unknown, cookie?: string) => Promise<Response>;
  close: () => Promise<void>;
}> {
  const store = new Store(":memory:");
  const server: Server = createApp(store, {
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
