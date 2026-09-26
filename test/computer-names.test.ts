import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";

test("computer names are editable without rotating identity, with administrator and credential boundaries", async () => {
  const store = new Store(":memory:");
  const server = createApp(store, {
    origin: "https://slopticus.test",
    publicSignup: true,
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (
    path: string,
    method: string,
    body?: unknown,
    cookie?: string,
    token?: string,
  ) =>
    fetch(`${base}/api/${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const signup = async (username: string) => {
    const response = await request("signup", "POST", {
      username,
      display_name: username,
      password: "safe password 12345",
    });
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      workspace: ((await response.json()) as { workspace_id: string })
        .workspace_id,
    };
  };
  try {
    const alice = await signup("alice"),
      bob = await signup("bob");
    const paired = await request(
      "computers",
      "POST",
      { name: "First", workspace_id: alice.workspace },
      alice.cookie,
    );
    const computer = (await paired.json()) as { id: string; token: string };
    assert.equal(
      (
        await request(
          `computers/${computer.id}`,
          "PATCH",
          { name: "New", workspace_id: bob.workspace },
          bob.cookie,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          `computers/${computer.id}`,
          "PATCH",
          { name: "New", workspace_id: alice.workspace },
          bob.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `computers/${computer.id}`,
          "PATCH",
          { name: "Work Mac", workspace_id: alice.workspace },
          alice.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "computer/name",
          "POST",
          { name: "Personal Mac" },
          undefined,
          computer.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "computer/name",
          "POST",
          { name: "", id: computer.id },
          undefined,
          computer.token,
        )
      ).status,
      400,
    );
    const identity = await request(
      "computer/identity",
      "GET",
      undefined,
      undefined,
      computer.token,
    );
    const data = (await identity.json()) as { id: string; name: string };
    assert.equal(data.id, computer.id);
    assert.equal(data.name, "Personal Mac");
    await request(
      `computers/${computer.id}/revoke`,
      "POST",
      { workspace_id: alice.workspace },
      alice.cookie,
    );
    assert.equal(
      (
        await request(
          "computer/name",
          "POST",
          { name: "Revoked" },
          undefined,
          computer.token,
        )
      ).status,
      401,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
