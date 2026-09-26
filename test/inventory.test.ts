import { createTestWorkspace } from "./workspace.js";
import { test } from "node:test";

import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";

import { mkdtempSync, rmSync } from "node:fs";

import { join } from "node:path";

import { tmpdir } from "node:os";

import { Store } from "../src/store.js";

import { createApp } from "../src/app.js";

import {
  InventoryStore,
  INVENTORY_TTL,
  type Observation,
} from "../src/inventory.js";

import { computersHTML } from "../web/computers.js";

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    instance: randomUUID(),
    native: randomUUID(),
    provider: "claude",
    source: "claude-hook",
    surface: "terminal",
    project: "same folder",
    activity: "idle",
    observed: 1000,
    ...overrides,
  };
}

test("inventory persists distinct launches, rejects sequence conflicts, expires presence without declaring closure", () => {
  const directory = mkdtempSync(join(tmpdir(), "slopticus-inventory-"));
  let store = new Store(join(directory, "relay.sqlite"));
  try {
    let inventory = new InventoryStore(store.db);
    const computer = inventory.pair(
        "Work",
        undefined,
        createTestWorkspace(store.db),
      ),
      a = observation(),
      b = observation();
    const report = {
      sequence: 1,
      observations: [a, b],
      coverage: "instrumented" as const,
    };
    inventory.report(computer.id, report, 1000);
    assert.equal(inventory.list(1001)[0].sessions.length, 2);
    inventory.report(computer.id, report, 2000);
    assert.equal(inventory.list(2000)[0].last_seen, 1000);
    assert.throws(() =>
      inventory.report(computer.id, { ...report, observations: [] }, 3000),
    );
    const stale = inventory.list(1000 + INVENTORY_TTL)[0];
    assert.equal(stale.online, false);
    assert.equal(stale.sessions[0].activity, "unknown");
    inventory.report(
      computer.id,
      {
        ...report,
        sequence: 2,
        observations: [
          { ...a, activity: "ended" },
          observation({ native: a.native }),
        ],
      },
      50000,
    );
    assert.equal(inventory.list(50000)[0].sessions.length, 3);
    assert.throws(() =>
      inventory.report(
        computer.id,
        { ...report, sequence: 3, observations: [a] },
        60000,
      ),
    );
    assert.equal(
      inventory.list(50000)[0].sessions.find((s) => s.instance === b.instance)
        ?.stale,
      true,
    );
    assert.throws(() =>
      inventory.report(
        computer.id,
        {
          ...report,
          sequence: 3,
          observations: [{ ...a, native: randomUUID() }],
        },
        60000,
      ),
    );
    assert.equal(inventory.list(60000)[0].last_seen, 50000);
    store.close();
    store = new Store(join(directory, "relay.sqlite"));
    inventory = new InventoryStore(store.db);
    assert.equal(inventory.authenticate(computer.token), computer.id);
    assert.equal(inventory.list(60000)[0].sessions.length, 3);
    inventory.revoke(computer.id);
    assert.equal(inventory.authenticate(computer.token), undefined);
    assert.equal(inventory.list(60000)[0].online, false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("computer credentials cannot read owner data, send agent messages, or report for another computer", async () => {
  const store = new Store(":memory:");
  const server = createApp(store, {
    origin: "http://localhost",
    publicSignup: true,
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (
    path: string,
    key = "",
    body?: unknown,
    cookie = "",
  ): Promise<Response> =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${key}`,
        cookie,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await request("/api/computers")).status, 401);
    const login = await request("/api/signup", "", {
      username: "testowner",
      display_name: "Test owner",
      password: "safe test password 123",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const first = (await (
      await request("/api/computers", "", { name: "Work" }, cookie)
    ).json()) as { id: string; token: string };
    const second = (await (
      await request("/api/computers", "", { name: "Home" }, cookie)
    ).json()) as { id: string; token: string };
    assert.equal(
      (await request("/api/computer/identity", "k".repeat(43))).status,
      401,
    );
    assert.equal((await request("/api/computers", first.token)).status, 401);
    const report = {
      sequence: 1,
      observations: [observation()],
      coverage: "instrumented",
    };
    assert.equal(
      (
        await request("/api/computer/report", first.token, {
          ...report,
          computer_id: second.id,
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/api/computer/report", first.token, report)).status,
      200,
    );
    assert.equal(
      (
        await request("/api/computer/report", first.token, {
          ...report,
          observations: [],
        })
      ).status,
      409,
    );
    const rows = (await (
      await request("/api/computers", "", undefined, cookie)
    ).json()) as { id: string; sessions: Observation[] }[];
    assert.equal(rows.find((row) => row.id === second.id)!.sessions.length, 0);
    assert.equal(rows.find((row) => row.id === first.id)!.sessions.length, 1);
    assert.equal(
      (await request(`/api/computers/${first.id}/revoke`, "", {}, cookie))
        .status,
      200,
    );
    assert.equal(
      (
        await request("/api/computer/report", first.token, {
          ...report,
          sequence: 2,
        })
      ).status,
      401,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test("computer UI escapes host/project metadata, distinguishes stale observations and discloses coverage", () => {
  const html = computersHTML([
    {
      id: randomUUID(),
      name: "<img onerror=alert(1)>",
      online: false,
      revoked: false,
      last_seen: 1,
      coverage: "instrumented",
      sessions: [
        {
          ...observation({
            project: "<script>bad</script>",
            activity: "unknown",
          }),
          stale: true,
          reported_at: 1,
        },
      ],
    },
  ]);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("Unknown · stale"));
  assert.ok(html.includes("Computer offline"));
  assert.ok(html.includes("Independently opened Codex"));
  assert.ok(html.includes("Observation only"));
});
