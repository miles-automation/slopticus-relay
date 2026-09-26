import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";

async function listen(releasesDir: string) {
  const store = new Store(":memory:");
  const server = createApp(store, {
    publicSignup: true,
    origin: "http://localhost",
    releasesDir,
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

test("published Mac releases are downloadable by architecture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopticus-releases-"));
  const releases = join(dir, "releases");
  mkdirSync(releases);
  writeFileSync(join(dir, "slopticus.sqlite"), "secret");
  writeFileSync(join(releases, "Slopticus-0.3.0-arm64.dmg"), "dmg-bytes");
  writeFileSync(join(releases, ".hidden"), "nope");
  writeFileSync(join(releases, "unlisted.dmg"), "unlisted");
  writeFileSync(join(releases, "Slopticus-0.3.0-x64.dmg"), "wrong size");
  symlinkSync(
    join(dir, "slopticus.sqlite"),
    join(releases, "Slopticus-0.2.0-arm64.dmg"),
  );
  writeFileSync(
    join(releases, "latest.json"),
    JSON.stringify({
      version: "0.3.0",
      published: "2026-09-16T00:00:00Z",
      files: {
        arm64: {
          file: "Slopticus-0.3.0-arm64.dmg",
          sha256: "b".repeat(64),
          size: 9,
        },
        x64: {
          file: "Slopticus-0.3.0-x64.dmg",
          sha256: "c".repeat(64),
          size: 9,
        },
      },
    }),
  );
  const { base, close } = await listen(releases);
  try {
    const latest = await fetch(`${base}/releases/latest.json`);
    assert.equal(latest.status, 200);
    assert.equal(
      ((await latest.json()) as { version: string }).version,
      "0.3.0",
    );
    const arm = await fetch(`${base}/download/mac/arm64`, {
      redirect: "manual",
    });
    assert.equal(arm.status, 302);
    assert.equal(
      arm.headers.get("location"),
      "/releases/Slopticus-0.3.0-arm64.dmg",
    );
    const dmg = await fetch(`${base}/releases/Slopticus-0.3.0-arm64.dmg`);
    assert.equal(dmg.status, 200);
    assert.equal(
      dmg.headers.get("content-type"),
      "application/x-apple-diskimage",
    );
    assert.match(dmg.headers.get("content-disposition") ?? "", /attachment/);
    assert.equal(await dmg.text(), "dmg-bytes");
    assert.equal((await fetch(`${base}/download/mac/ppc`)).status, 404);
    assert.equal((await fetch(`${base}/download/mac/../x64`)).status, 404);
    assert.equal((await fetch(`${base}/releases/.hidden`)).status, 404);
    assert.equal((await fetch(`${base}/releases/unlisted.dmg`)).status, 404);
    assert.equal(
      (await fetch(`${base}/releases/Slopticus-0.3.0-x64.dmg`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/releases/Slopticus-0.2.0-arm64.dmg`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/releases/..%2Fslopticus.sqlite`)).status,
      404,
    );
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unpublished server reports no release instead of failing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopticus-releases-"));
  const { base, close } = await listen(join(dir, "missing"));
  try {
    const latest = await fetch(`${base}/releases/latest.json`);
    assert.equal(latest.status, 404);
    assert.equal((await fetch(`${base}/download/mac/arm64`)).status, 404);
    assert.equal((await fetch(`${base}/releases/anything.dmg`)).status, 404);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Sparkle feeds are explicitly published per architecture and are never cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopticus-appcast-"));
  const feed = '<?xml version="1.0"?><rss><channel>signed feed</channel></rss>';
  const name = "appcast-0.3.1-arm64.xml";
  const entry = {
    file: name,
    sha256: "a".repeat(64),
    size: Buffer.byteLength(feed),
  };
  const manifest = {
    version: "0.3.1",
    published: "2026-09-17T00:00:00Z",
    files: {},
    appcasts: { arm64: entry },
  };
  const publish = (): void =>
    writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, name), feed);
  publish();
  const { base, close } = await listen(dir);
  try {
    const response = await fetch(`${base}/releases/appcast-arm64.xml`);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /application\/xml/,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), feed);
    assert.equal((await fetch(`${base}/releases/appcast-x64.xml`)).status, 404);
    assert.equal((await fetch(`${base}/releases/${name}`)).status, 404);

    entry.size += 1;
    publish();
    assert.equal(
      (await fetch(`${base}/releases/appcast-arm64.xml`)).status,
      404,
    );
    entry.size -= 1;
    entry.file = "../private.xml";
    publish();
    assert.equal(
      (await fetch(`${base}/releases/appcast-arm64.xml`)).status,
      404,
    );

    entry.file = "appcast-0.3.1-x64.xml";
    symlinkSync(join(dir, name), join(dir, entry.file));
    publish();
    assert.equal(
      (await fetch(`${base}/releases/appcast-arm64.xml`)).status,
      404,
    );
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});
