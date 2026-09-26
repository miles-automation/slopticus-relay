import express from "express";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export const architectures = ["arm64", "x64"] as const;
export type Architecture = (typeof architectures)[number];

const manifestSchema = z.object({
  version: z.string().min(1),
  published: z.string().min(1),
  files: z.record(
    z.enum(architectures),
    z.object({
      file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.dmg$/),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size: z.number().int().nonnegative(),
    }),
  ),
  appcasts: z
    .record(
      z.enum(architectures),
      z.object({
        file: z.string().regex(/^appcast-[A-Za-z0-9._-]+-(arm64|x64)\.xml$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().positive(),
      }),
    )
    .optional(),
});
export type Manifest = z.infer<typeof manifestSchema>;
type ReleaseFile = NonNullable<Manifest["files"][Architecture]>;

export async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    return manifestSchema.parse(
      JSON.parse(await readFile(join(dir, "latest.json"), "utf8")),
    );
  } catch {
    return null;
  }
}

async function publishedPath(
  dir: string,
  entry: Pick<ReleaseFile, "file" | "size">,
): Promise<string | null> {
  try {
    const root = await realpath(resolve(dir));
    const path = await realpath(join(root, entry.file));
    if (path !== join(root, entry.file)) return null;
    const info = await stat(path);
    return info.isFile() && info.size === entry.size ? path : null;
  } catch {
    return null;
  }
}

export function releaseRoutes(dir: string): express.Router {
  const router = express.Router();
  router.get("/releases/latest.json", async (_req, res) => {
    const manifest = await readManifest(dir);
    if (!manifest) {
      res.status(404).json({ error: "No release published" });
      return;
    }
    res.json(manifest);
  });
  router.get("/download/mac/:arch", async (req, res) => {
    const arch = String(req.params.arch);
    const manifest = await readManifest(dir);
    const entry =
      manifest && (architectures as readonly string[]).includes(arch)
        ? manifest.files[arch as Architecture]
        : undefined;
    if (!entry) {
      res.status(404).json({ error: "No release for this architecture" });
      return;
    }
    res.redirect(302, `/releases/${entry.file}`);
  });
  router.get("/releases/:file", async (req, res) => {
    const name = String(req.params.file);
    const manifest = await readManifest(dir);
    const feedArch = architectures.find(
      (arch) => name === `appcast-${arch}.xml`,
    );
    const appcast = feedArch ? manifest?.appcasts?.[feedArch] : undefined;
    if (appcast) {
      const path = await publishedPath(dir, appcast);
      if (!path) {
        res.status(404).json({ error: "No such appcast" });
        return;
      }
      res.set({
        "Content-Type": "application/xml",
        "Cache-Control": "no-store",
      });
      res.sendFile(path, { dotfiles: "deny", lastModified: false });
      return;
    }
    const entry = manifest
      ? Object.values(manifest.files).find((file) => file.file === name)
      : undefined;
    const path = entry ? await publishedPath(dir, entry) : null;
    if (!entry || !path) {
      res.status(404).json({ error: "No such release file" });
      return;
    }
    res.set({
      "Content-Type": "application/x-apple-diskimage",
      "Content-Disposition": `attachment; filename="${entry.file}"`,
      "Cache-Control": "public, max-age=3600",
    });
    res.sendFile(path, { dotfiles: "deny", lastModified: false });
  });
  return router;
}
