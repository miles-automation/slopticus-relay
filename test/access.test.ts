import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { Store, hash } from "../src/store.js";
import { createApp } from "../src/app.js";
import { readFileSync } from "node:fs";
import {
  loginHTML,
  ONE_USE_CODE_DISCLOSURE,
  signInAnotherDeviceInstruction,
} from "../web/login.js";
import {
  APPLE_SILICON_DOWNLOAD,
  INTEL_DOWNLOAD,
  landingHTML,
} from "../web/landing.js";
import {
  loginContextForHash,
  resultForCurrentHash,
  viewForHash,
} from "../web/routes.js";
import {
  selfHostHTML,
  SELF_HOST_SOURCE,
  SELF_HOST_REF,
} from "../web/self-host.js";

test("public landing explains the product, deployment choices, and downloads", () => {
  const html = landingHTML();
  assert.match(html, /What is Slopticus\?/);
  assert.match(html, /Run Claude Code and Codex on your Mac/);
  assert.match(html, /Hosted by Slopticus/);
  assert.match(html, /Create your account and private workspace/);
  assert.match(html, /shared team workspaces/);
  assert.match(html, /Run it on your infrastructure/);
  assert.match(html, /Self-hosting guide/);
  assert.match(html, /Mac and iPhone pairing use your server/);
  assert.match(html, /iPhone app is not yet available for general download/);
  assert.ok(html.includes(`href="${APPLE_SILICON_DOWNLOAD}"`));
  assert.ok(html.includes(`href="${INTEL_DOWNLOAD}"`));
  assert.match(html, /href="#\/manage">Open workspaces/);
  assert.doesNotMatch(html, /Owner recovery key/);
  const selfHosted = landingHTML(true, false);
  assert.match(selfHosted, /This relay/);
  assert.match(selfHosted, /No Slopticus-hosted account is required/);
  assert.doesNotMatch(selfHosted, /Hosted by Slopticus/);
  assert.ok(selfHosted.includes(`href="${APPLE_SILICON_DOWNLOAD}"`));
});

test("an owner-console response is discarded after navigation to the public page", async () => {
  let currentHash = "#/manage";
  let complete!: (value: string) => void;
  const response = resultForCurrentHash(
    currentHash,
    () => currentHash,
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  currentHash = "#/";
  complete("private owner data");
  assert.equal(await response, undefined);
  assert.equal(
    await resultForCurrentHash(
      "#/manage",
      () => "#/manage",
      async () => Promise.resolve("current owner data"),
    ),
    "current owner data",
  );
});

test("public routes separate the landing, owner console, and Mac approval", () => {
  assert.deepEqual(viewForHash(""), { kind: "landing" });
  assert.deepEqual(viewForHash("#/"), { kind: "landing" });
  assert.deepEqual(viewForHash("#/manage"), { kind: "computers" });
  assert.deepEqual(viewForHash("#/self-host"), { kind: "self-host" });
  assert.deepEqual(viewForHash("#/computers"), { kind: "computers" });
  assert.deepEqual(viewForHash("#/connect-computer/ABCDEF123456"), {
    kind: "pair-computer",
    code: "ABCDEF123456",
  });
  assert.equal(loginContextForHash("#/manage"), "console");
  assert.equal(
    loginContextForHash("#/connect-computer/ABCDEF123456"),
    "computer-approval",
  );
});

test("self-host guide provides a complete independent relay path", () => {
  const html = selfHostHTML();
  assert.ok(html.includes(`git clone ${SELF_HOST_SOURCE}`));
  assert.ok(html.includes(`git checkout ${SELF_HOST_REF}`));
  assert.match(html, /SLOPTICUS_ORIGIN: https:\/\/relay\.example\.com/);
  assert.match(html, /SLOPTICUS_PUBLIC_SIGNUP: "1"/);
  assert.match(html, /SLOPTICUS_SECURE_PAIRING: "1"/);
  assert.match(html, /docker compose up -d/);
  assert.match(html, /healthz/);
  assert.match(html, /Mac nor iPhone needs a Slopticus-hosted account/);
  assert.match(
    html,
    /Anyone who can reach a server with public signup enabled/,
  );
});

test("account sign-in explains signup, recovery, and legacy migration", () => {
  const consoleLogin = loginHTML("console");
  assert.match(consoleLogin, /Create an account/);
  assert.match(consoleLogin, /Recover an account/);
  assert.match(consoleLogin, /Existing owner recovery key/);
  assert.ok(consoleLogin.includes(ONE_USE_CODE_DISCLOSURE));
  assert.ok(signInAnotherDeviceInstruction().includes(ONE_USE_CODE_DISCLOSURE));
  assert.ok(
    readFileSync(new URL("../README.md", import.meta.url), "utf8").includes(
      `**${ONE_USE_CODE_DISCLOSURE}**`,
    ),
  );

  const approvalLogin = loginHTML("computer-approval");
  assert.match(approvalLogin, /Approve this Mac/);
  assert.match(approvalLogin, /review the connection request from your Mac/);
  const closedLogin = loginHTML("console", false);
  assert.doesNotMatch(closedLogin, /id="signup"/);
  assert.match(closedLogin, /not open yet/);
  assert.match(loginHTML("console", false, true), /id="signup"/);
  assert.match(landingHTML(false), /temporarily closed/);
});

async function fixture(): Promise<{
  store: Store;
  base: string;
  cookie: string;
  close: () => Promise<void>;
}> {
  const store = new Store(":memory:");
  const server: Server = createApp(store, {
    ownerToken: "o".repeat(40),
    origin: "https://slopticus.test",
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "o".repeat(40) }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  return {
    store,
    base,
    cookie,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
    },
  };
}

async function createCode(base: string, cookie: string): Promise<string> {
  const response = await fetch(`${base}/api/access-codes`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = (await response.json()) as { code: string; expires: number };
  assert.match(data.code, /^[A-F0-9]{4}(-[A-F0-9]{4}){5}$/);
  assert.ok(data.expires > Date.now() && data.expires <= Date.now() + 600000);
  return data.code;
}

function redeem(
  base: string,
  code: string,
  origin?: string,
): Promise<Response> {
  return fetch(`${base}/api/login/code`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ code }),
  });
}

test("a signed-in owner can create a one-use code without exposing the owner key", async () => {
  const { store, base, cookie, close } = await fixture();
  try {
    const wrongKey = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "w".repeat(40) }),
    });
    assert.equal(wrongKey.status, 401);
    assert.deepEqual(await wrongKey.json(), {
      error: "Incorrect owner recovery key",
    });
    assert.match(cookie, /^slopticus=/);
    assert.equal(
      (
        await fetch(`${base}/api/computers`, {
          headers: { cookie: cookie.replace(/^slopticus=/, "weaver=") },
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/api/access-codes`, { method: "POST" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/api/access-codes`, {
          method: "POST",
          headers: { cookie, origin: "https://foreign.test" },
        })
      ).status,
      403,
    );
    const code = await createCode(base, cookie);
    const row = store.db.prepare("SELECT * FROM access_codes").get()!;
    assert.equal(row.code_hash, hash(code.replaceAll("-", "")));
    assert.ok(!JSON.stringify(row).includes(code));
    assert.equal(
      (await redeem(base, code, "https://foreign.test")).status,
      403,
    );
    const response = await redeem(
      base,
      code.toLowerCase().replaceAll("-", " "),
    );
    assert.equal(response.status, 200);
    const newCookie = response.headers.get("set-cookie")!;
    assert.match(newCookie, /HttpOnly/);
    assert.match(newCookie, /Secure/);
    assert.match(newCookie, /SameSite=Strict/);
    assert.equal(
      (
        await fetch(`${base}/api/computers`, {
          headers: { cookie: newCookie.split(";")[0] },
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/api/computers`, { headers: { cookie } })).status,
      200,
    );
    assert.equal((await redeem(base, code)).status, 401);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM access_codes").get()!.n,
      0,
    );
  } finally {
    await close();
  }
});

test("codes expire, are replaced or revoked, and become invalid when their source signs out", async () => {
  const { store, base, cookie, close } = await fixture();
  try {
    const expired = await createCode(base, cookie);
    store.db.prepare("UPDATE access_codes SET expires=?").run(Date.now() - 1);
    assert.equal((await redeem(base, expired)).status, 401);
    const replaced = await createCode(base, cookie);
    const current = await createCode(base, cookie);
    assert.equal((await redeem(base, replaced)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/access-codes`, { method: "DELETE" })).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/api/access-codes`, {
          method: "DELETE",
          headers: { cookie, origin: "https://foreign.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/access-codes`, {
          method: "DELETE",
          headers: { cookie },
        })
      ).status,
      200,
    );
    assert.equal((await redeem(base, current)).status, 401);
    const sourceExpired = await createCode(base, cookie);
    store.db.prepare("UPDATE logins SET expires=?").run(Date.now() - 1);
    assert.equal((await redeem(base, sourceExpired)).status, 401);
    store.db.prepare("UPDATE logins SET expires=?").run(Date.now() + 100000);
    const logoutCode = await createCode(base, cookie);
    await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
    assert.equal((await redeem(base, logoutCode)).status, 401);
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM access_codes").get()!.n,
      0,
    );
  } finally {
    await close();
  }
});

test("simultaneous redemptions create exactly one session and invalid codes are throttled", async () => {
  const { store, base, cookie, close } = await fixture();
  try {
    const code = await createCode(base, cookie);
    const results = await Promise.all([redeem(base, code), redeem(base, code)]);
    assert.deepEqual(
      results.map((response) => response.status).sort(),
      [200, 401],
    );
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM logins").get()!.n,
      2,
    );
    for (let i = 0; i < 9; i++)
      assert.equal((await redeem(base, "bad")).status, 401);
    assert.equal((await redeem(base, "bad")).status, 429);
  } finally {
    await close();
  }
});
