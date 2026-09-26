import { ComputerPairing } from "./computer-pairing.js";
import { InventoryStore, reportSchema } from "./inventory.js";
import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Store, hash, token } from "./store.js";
import {
  LEGACY_WORKSPACE_ID,
  LegacyAlreadyClaimedError,
  TenancyStore,
} from "./tenancy.js";
import { releaseRoutes } from "./releases.js";
import { VERSION, PROTOCOL } from "./protocol.js";

const text = z.string().trim().min(1).max(4000);
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/);
const passwordSchema = z.string().min(12).max(128);
type Principal = { accountId: string } | { accountId: null };
export function createApp(
  store: Store,
  options: {
    ownerToken: string;
    origin: string;
    publicSignup?: boolean;
    publicDir?: string;
    releasesDir?: string;
  },
) {
  if (options.ownerToken && options.ownerToken.length < 32)
    throw new Error("SLOPTICUS_OWNER_TOKEN must be at least 32 characters");
  const publicSignupEnabled =
    options.publicSignup === true && !options.ownerToken;
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use("/api/computer/report", express.json({ limit: "256kb" }));
  app.use(express.json({ limit: "16kb" }));
  // /healthz is the fleet contract the platform rollout probes; /health stays for existing callers.
  app.get(["/health", "/healthz"], (_req, res) =>
    res.json({ ok: true, version: VERSION, protocol: PROTOCOL }),
  );
  app.use(["/api/agent", "/api/inbox", "/api/sessions"], (_req, res) => {
    res.status(426).json({ error: "Slopticus agent messaging was retired" });
  });
  app.use("/api", (req, res, next) => {
    if (req.headers.origin && req.headers.origin !== options.origin) {
      res.status(403).json({ error: "Origin rejected" });
      return;
    }
    next();
  });
  app.get("/api/config", (_req, res) =>
    res.json({ public_signup: publicSignupEnabled }),
  );
  const cookieToken = (req: express.Request) =>
    req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("slopticus="))
      ?.slice("slopticus=".length) ?? "";
  const tenancy = new TenancyStore(store.db);
  const principalFor = (req: express.Request): Principal | undefined => {
    const tokenHash = hash(cookieToken(req));
    const account = store.db
      .prepare(
        "SELECT expires,account_id FROM account_logins WHERE token_hash=?",
      )
      .get(tokenHash);
    if (account && Number(account.expires) > Date.now())
      return { accountId: String(account.account_id) };
    const legacy = store.db
      .prepare("SELECT expires FROM logins WHERE token_hash=?")
      .get(tokenHash);
    if (
      legacy &&
      Number(legacy.expires) > Date.now() &&
      !tenancy.isLegacyClaimed()
    )
      return { accountId: null };
    return undefined;
  };
  const signedIn: express.RequestHandler = (req, res, next) => {
    const principal = principalFor(req);
    if (!principal) {
      res.status(401).json({ error: "Sign in to Slopticus" });
      return;
    }
    res.locals.principal = principal;
    next();
  };
  const selectedWorkspace = (
    req: express.Request,
    res: express.Response,
    manage: boolean,
  ): string | undefined => {
    const principal = res.locals.principal as Principal;
    if (principal.accountId === null) return LEGACY_WORKSPACE_ID;
    const requested =
      req.method === "GET" ? req.query.workspace_id : req.body?.workspace_id;
    const workspaces = tenancy.workspaces(principal.accountId);
    const id =
      typeof requested === "string"
        ? requested
        : workspaces.length === 1
          ? workspaces[0]!.id
          : undefined;
    const workspace = id
      ? workspaces.find((item) => item.id === id)
      : undefined;
    if (!workspace || (manage && workspace.role === "member")) {
      res.status(403).json({ error: "Choose a workspace you can access" });
      return undefined;
    }
    return workspace.id;
  };
  const inventory = new InventoryStore(store.db);
  const pairing = new ComputerPairing(store.db, inventory);
  let pairingStarts = 0,
    pairingReset = Date.now() + 60_000;
  app.post("/api/computer-pairing", (req, res) => {
    const { name } = z
      .object({ name: text.max(80) })
      .strict()
      .parse(req.body);
    if (Date.now() >= pairingReset) {
      pairingStarts = 0;
      pairingReset = Date.now() + 60_000;
    }
    if (++pairingStarts > 10) {
      res.status(429).json({
        error: "Too many connection requests. Try again in a minute.",
      });
      return;
    }
    try {
      res.status(201).json(pairing.begin(name));
    } catch (error) {
      res.status(429).json({ error: (error as Error).message });
    }
  });
  app.post("/api/computer-pairing/claim", (req, res) => {
    const { device_code } = z
      .object({ device_code: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.body);
    const result = pairing.claim(device_code);
    if (!result) {
      res.status(410).json({
        error:
          "Connection request expired or was declined. Start again in Slopticus for Mac.",
      });
      return;
    }
    res.json(result);
  });
  app.get("/api/computer-pairing/:code", signedIn, (req, res) => {
    const code = z
      .string()
      .regex(/^[A-F0-9]{12}$/)
      .parse(req.params.code);
    const result = pairing.preview(code);
    if (!result) {
      res.status(410).json({
        error:
          "Connection request expired or was declined. Start again in Slopticus for Mac.",
      });
      return;
    }
    res.json(result);
  });
  app.post("/api/computer-pairing/:code/decision", signedIn, (req, res) => {
    const code = z
      .string()
      .regex(/^[A-F0-9]{12}$/)
      .parse(req.params.code);
    const { approve } = z
      .object({
        approve: z.boolean(),
        workspace_id: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.body);
    const workspaceId = selectedWorkspace(req, res, true);
    if (!workspaceId) return;
    if (!pairing.decide(code, approve, Date.now(), workspaceId)) {
      res.status(410).json({ error: "This request is no longer available." });
      return;
    }
    res.json({ ok: true });
  });
  app.get("/api/computers", signedIn, (req, res) => {
    const workspaceId = selectedWorkspace(req, res, false);
    if (workspaceId) res.json(inventory.list(Date.now(), workspaceId));
  });
  app.post("/api/computers", signedIn, (req, res) => {
    const workspaceId = selectedWorkspace(req, res, true);
    if (!workspaceId) return;
    const { name } = z
      .object({
        name: text.max(80),
        workspace_id: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(inventory.pair(name, undefined, workspaceId));
  });
  app.post("/api/computers/:id/revoke", signedIn, (req, res) => {
    const workspaceId = selectedWorkspace(req, res, true);
    if (!workspaceId) return;
    if (
      !inventory.revoke(z.string().uuid().parse(req.params.id), workspaceId)
    ) {
      res.status(404).json({ error: "Computer not found in workspace" });
      return;
    }
    res.json({ ok: true });
  });
  app.use("/api/computer", (req, res, next) => {
    const id = inventory.authenticate(
      req.headers.authorization?.replace(/^Bearer /, "") ?? "",
    );
    if (!id) {
      res.status(401).json({ error: "Invalid or revoked computer key" });
      return;
    }
    res.locals.computerId = id;
    next();
  });
  app.get("/api/computer/identity", (_req, res) =>
    res.json(
      inventory
        .list()
        .find((computer) => computer.id === res.locals.computerId),
    ),
  );
  app.post("/api/computer/disconnect", (_req, res) => {
    inventory.revoke(res.locals.computerId as string);
    res.json({ ok: true });
  });
  app.post("/api/computer/report", (req, res) => {
    const data = reportSchema.parse(req.body);
    try {
      inventory.report(res.locals.computerId as string, data);
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
  });
  const attempts = new Map<string, { failures: number; resetAt: number }>();
  let registrations = 0,
    registrationReset = Date.now() + 60000,
    passwordWork = 0;
  const attemptKey = (req: express.Request): string =>
    `${req.path}:${typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : req.ip}`;
  const attempt = (
    req: express.Request,
  ): { failures: number; resetAt: number } => {
    const key = attemptKey(req);
    const existing = attempts.get(key);
    if (existing && existing.resetAt > Date.now()) return existing;
    if (attempts.size >= 1000) {
      for (const [expiredKey, state] of attempts)
        if (state.resetAt <= Date.now()) attempts.delete(expiredKey);
    }
    if (attempts.size >= 1000)
      return { failures: 10, resetAt: Date.now() + 60000 };
    const fresh = { failures: 0, resetAt: Date.now() + 60000 };
    attempts.set(key, fresh);
    return fresh;
  };
  const loginLimit: express.RequestHandler = (req, res, next) => {
    if (attempt(req).failures >= 10) {
      res
        .status(429)
        .json({ error: "Too many attempts. Try again in a minute." });
      return;
    }
    next();
  };
  const passwordOperation = async <T>(work: () => Promise<T>): Promise<T> => {
    if (passwordWork >= 4) throw new Error("Too many password operations");
    passwordWork++;
    try {
      return await work();
    } finally {
      passwordWork--;
    }
  };
  const openLogin = (
    res: express.Response,
    accountId: string | null,
    result: Record<string, unknown> = { ok: true },
  ): void => {
    const key = token();
    store.db.prepare("DELETE FROM logins WHERE expires<=?").run(Date.now());
    store.db
      .prepare("DELETE FROM account_logins WHERE expires<=?")
      .run(Date.now());
    store.db
      .prepare(
        accountId === null
          ? "INSERT INTO logins(token_hash,expires) VALUES(?,?)"
          : "INSERT INTO account_logins(token_hash,expires,account_id) VALUES(?,?,?)",
      )
      .run(
        ...(accountId === null
          ? [hash(key), Date.now() + 30 * 86400000]
          : [hash(key), Date.now() + 30 * 86400000, accountId]),
      );
    res.cookie("slopticus", key, {
      httpOnly: true,
      secure: options.origin.startsWith("https:"),
      sameSite: "strict",
      maxAge: 30 * 86400000,
      path: "/",
    });
    res.json(result);
  };
  app.post("/api/login", loginLimit, (req, res) => {
    const candidate = typeof req.body?.token === "string" ? req.body.token : "";
    if (
      tenancy.isLegacyClaimed() ||
      !options.ownerToken ||
      !timingSafeEqual(
        Buffer.from(hash(candidate)),
        Buffer.from(hash(options.ownerToken)),
      )
    ) {
      attempt(req).failures++;
      res.status(401).json({ error: "Incorrect owner recovery key" });
      return;
    }
    openLogin(res, null);
  });
  app.post("/api/signup", loginLimit, async (req, res) => {
    const migratingLegacy = principalFor(req)?.accountId === null;
    if (!publicSignupEnabled && !migratingLegacy) {
      res.status(403).json({ error: "Account creation is not open yet" });
      return;
    }
    const { username, display_name, password } = z
      .object({
        username: usernameSchema,
        display_name: text.max(80),
        password: passwordSchema,
      })
      .strict()
      .parse(req.body);
    if (Date.now() >= registrationReset) {
      registrations = 0;
      registrationReset = Date.now() + 60000;
    }
    if (++registrations > 10 || passwordWork >= 4) {
      res.status(429).json({ error: "Too many signups. Try again later." });
      return;
    }
    if (
      store.db.prepare("SELECT id FROM accounts WHERE username=?").get(username)
    ) {
      res.status(409).json({ error: "Username is unavailable" });
      return;
    }
    try {
      const created = await passwordOperation(() =>
        tenancy.createAccount(
          username,
          display_name,
          password,
          migratingLegacy,
        ),
      );
      openLogin(res, created.account_id, {
        recovery_code: created.recovery_code,
        workspace_id: created.workspace_id,
      });
    } catch (error) {
      if (error instanceof LegacyAlreadyClaimedError) {
        res.status(409).json({
          error:
            "Existing computers were already claimed. Sign in to your account.",
        });
        return;
      }
      if (
        String(error).includes("UNIQUE constraint failed: accounts.username")
      ) {
        res.status(409).json({ error: "Username is unavailable" });
        return;
      }
      throw error;
    }
  });
  app.post("/api/login/account", loginLimit, async (req, res) => {
    const { username, password } = z
      .object({
        username: usernameSchema,
        password: z.string().max(128),
      })
      .strict()
      .parse(req.body);
    if (passwordWork >= 4) {
      res.status(429).json({ error: "Too many sign-ins. Try again shortly." });
      return;
    }
    const accountId = await passwordOperation(() =>
      tenancy.authenticate(username, password),
    );
    if (!accountId) {
      attempt(req).failures++;
      res.status(401).json({ error: "Incorrect username or password" });
      return;
    }
    openLogin(res, accountId);
  });
  app.post("/api/recover", loginLimit, async (req, res) => {
    const { username, recovery_code, password } = z
      .object({
        username: usernameSchema,
        recovery_code: z.string().min(32).max(128),
        password: passwordSchema,
      })
      .strict()
      .parse(req.body);
    if (passwordWork >= 4) {
      res.status(429).json({ error: "Too many sign-ins. Try again shortly." });
      return;
    }
    const recovered = await passwordOperation(() =>
      tenancy.recover(username, recovery_code, password),
    );
    if (!recovered) {
      attempt(req).failures++;
      res.status(401).json({ error: "Incorrect recovery code" });
      return;
    }
    const key = token();
    store.db
      .prepare(
        "INSERT INTO account_logins(token_hash,expires,account_id) VALUES(?,?,?)",
      )
      .run(hash(key), Date.now() + 30 * 86400000, recovered.account_id);
    res.cookie("slopticus", key, {
      httpOnly: true,
      secure: options.origin.startsWith("https:"),
      sameSite: "strict",
      maxAge: 30 * 86400000,
      path: "/",
    });
    res.json({ recovery_code: recovered.recovery_code });
  });
  app.get("/api/me", signedIn, (_req, res) => {
    const principal = res.locals.principal as Principal;
    res.json(
      principal.accountId === null
        ? {
            kind: "legacy",
            workspaces: [
              {
                id: LEGACY_WORKSPACE_ID,
                name: "Existing computers",
                kind: "private",
                organization_id: "00000000-0000-4000-8000-000000000001",
                organization_name: "Existing Slopticus",
                role: "owner",
                organization_role: "owner",
              },
            ],
          }
        : {
            kind: "account",
            account: tenancy.account(principal.accountId),
            workspaces: tenancy.workspaces(principal.accountId),
            legacy_available:
              Boolean(options.ownerToken) && !tenancy.isLegacyClaimed(),
          },
    );
  });
  app.post("/api/legacy/claim", signedIn, (req, res) => {
    const principal = res.locals.principal as Principal;
    if (principal.accountId === null) {
      res.status(403).json({ error: "Create your account first" });
      return;
    }
    const { recovery_key } = z
      .object({ recovery_key: z.string() })
      .strict()
      .parse(req.body);
    if (
      !options.ownerToken ||
      !timingSafeEqual(
        Buffer.from(hash(recovery_key)),
        Buffer.from(hash(options.ownerToken)),
      )
    ) {
      res.status(401).json({ error: "Incorrect owner recovery key" });
      return;
    }
    if (!tenancy.claimLegacy(principal.accountId)) {
      res
        .status(409)
        .json({ error: "Existing computers were already claimed" });
      return;
    }
    res.json({ workspace_id: LEGACY_WORKSPACE_ID });
  });
  app.post("/api/organizations", signedIn, (req, res) => {
    const principal = res.locals.principal as Principal;
    if (principal.accountId === null) {
      res.status(403).json({ error: "Create your account first" });
      return;
    }
    const { name } = z
      .object({ name: text.max(80) })
      .strict()
      .parse(req.body);
    res.status(201).json(tenancy.createOrganization(principal.accountId, name));
  });
  app.post("/api/organizations/:id/workspaces", signedIn, (req, res) => {
    const principal = res.locals.principal as Principal;
    if (principal.accountId === null) {
      res.status(403).json({ error: "Create your account first" });
      return;
    }
    const { name } = z
      .object({ name: text.max(80) })
      .strict()
      .parse(req.body);
    const workspace = tenancy.createWorkspace(
      principal.accountId,
      z.string().uuid().parse(req.params.id),
      name,
    );
    if (!workspace) {
      res.status(403).json({ error: "Organization administrator required" });
      return;
    }
    res.status(201).json(workspace);
  });
  app.get("/api/organizations/:id/members", signedIn, (req, res) => {
    const principal = res.locals.principal as Principal;
    const members =
      principal.accountId === null
        ? undefined
        : tenancy.organizationMembers(
            principal.accountId,
            z.string().uuid().parse(req.params.id),
          );
    if (!members) {
      res.status(403).json({ error: "Organization owner required" });
      return;
    }
    res.json(members);
  });
  app.post(
    "/api/organizations/:id/members/:accountId/remove",
    signedIn,
    (req, res) => {
      const principal = res.locals.principal as Principal;
      if (
        principal.accountId === null ||
        !tenancy.removeOrganizationMember(
          principal.accountId,
          z.string().uuid().parse(req.params.id),
          z.string().uuid().parse(req.params.accountId),
        )
      ) {
        res.status(403).json({ error: "Organization owner required" });
        return;
      }
      res.json({ ok: true });
    },
  );
  app.post("/api/workspaces/:id/invitations", signedIn, (req, res) => {
    const principal = res.locals.principal as Principal;
    if (principal.accountId === null) {
      res.status(403).json({ error: "Create your account first" });
      return;
    }
    const { role } = z
      .object({ role: z.enum(["member", "admin", "organization_admin"]) })
      .strict()
      .parse(req.body);
    const code = tenancy.invite(
      principal.accountId,
      z.string().uuid().parse(req.params.id),
      role,
    );
    if (!code) {
      res
        .status(403)
        .json({ error: "Shared workspace administrator required" });
      return;
    }
    res.status(201).json({ code, expires: Date.now() + 7 * 86400000 });
  });
  app.get("/api/workspaces/:id/members", signedIn, (req, res) => {
    const principal = res.locals.principal as Principal;
    if (principal.accountId === null) {
      res.status(403).json({ error: "Create your account first" });
      return;
    }
    const members = tenancy.members(
      principal.accountId,
      z.string().uuid().parse(req.params.id),
    );
    if (!members) {
      res.status(403).json({ error: "Workspace administrator required" });
      return;
    }
    res.json(members);
  });
  app.post(
    "/api/workspaces/:id/members/:accountId/remove",
    signedIn,
    (req, res) => {
      const principal = res.locals.principal as Principal;
      if (
        principal.accountId === null ||
        !tenancy.removeMember(
          principal.accountId,
          z.string().uuid().parse(req.params.id),
          z.string().uuid().parse(req.params.accountId),
        )
      ) {
        res.status(403).json({ error: "Cannot remove this workspace member" });
        return;
      }
      res.json({ ok: true });
    },
  );
  app.post("/api/invitations/accept", signedIn, (req, res) => {
    const principal = res.locals.principal as Principal;
    if (principal.accountId === null) {
      res.status(403).json({ error: "Create your account first" });
      return;
    }
    const { code } = z
      .object({ code: z.string().min(20).max(128) })
      .strict()
      .parse(req.body);
    const workspace = tenancy.acceptInvitation(principal.accountId, code);
    if (!workspace) {
      res.status(410).json({ error: "Invitation expired or already used" });
      return;
    }
    res.json(workspace);
  });
  app.post("/api/access-codes", signedIn, (req, res) => {
    const principal = res.locals.principal as Principal;
    const table =
      principal.accountId === null ? "access_codes" : "account_access_codes";
    const code = randomBytes(12).toString("hex").toUpperCase();
    const expires = Date.now() + 10 * 60000;
    store.db.prepare(`DELETE FROM ${table} WHERE expires<=?`).run(Date.now());
    store.db
      .prepare(
        `INSERT INTO ${table}(code_hash,login_hash,expires) VALUES(?,?,?) ON CONFLICT(login_hash) DO UPDATE SET code_hash=excluded.code_hash,expires=excluded.expires`,
      )
      .run(hash(code), hash(cookieToken(req)), expires);
    res.json({ code: code.match(/.{4}/g)!.join("-"), expires });
  });
  app.delete("/api/access-codes", signedIn, (req, res) => {
    const principal = res.locals.principal as Principal;
    const table =
      principal.accountId === null ? "access_codes" : "account_access_codes";
    store.db
      .prepare(`DELETE FROM ${table} WHERE login_hash=?`)
      .run(hash(cookieToken(req)));
    res.json({ ok: true });
  });
  app.post("/api/login/code", loginLimit, (req, res) => {
    const candidate =
      typeof req.body?.code === "string"
        ? req.body.code.replace(/[\s-]/g, "").toUpperCase()
        : "";
    const accountCode = /^[A-F0-9]{24}$/.test(candidate)
      ? store.db
          .prepare(
            "DELETE FROM account_access_codes WHERE code_hash=? AND expires>? AND login_hash IN (SELECT token_hash FROM account_logins WHERE expires>?) RETURNING login_hash",
          )
          .get(hash(candidate), Date.now(), Date.now())
      : undefined;
    const legacyCode =
      !accountCode && /^[A-F0-9]{24}$/.test(candidate)
        ? store.db
            .prepare(
              "DELETE FROM access_codes WHERE code_hash=? AND expires>? AND login_hash IN (SELECT token_hash FROM logins WHERE expires>?) RETURNING login_hash",
            )
            .get(hash(candidate), Date.now(), Date.now())
        : undefined;
    if (!accountCode && !legacyCode) {
      attempt(req).failures++;
      res.status(401).json({
        error:
          "This code is invalid, expired, or already used. Create a new code on your signed-in device.",
      });
      return;
    }
    const source = accountCode
      ? store.db
          .prepare("SELECT account_id FROM account_logins WHERE token_hash=?")
          .get(accountCode.login_hash!)
      : store.db
          .prepare("SELECT token_hash FROM logins WHERE token_hash=?")
          .get(legacyCode!.login_hash!);
    if (!source || (legacyCode && tenancy.isLegacyClaimed())) {
      res.status(401).json({ error: "Source sign-in expired" });
      return;
    }
    openLogin(res, accountCode ? String(source.account_id) : null);
  });
  app.post("/api/logout", signedIn, (req, res) => {
    const principal = res.locals.principal as Principal;
    const table = principal.accountId === null ? "logins" : "account_logins";
    store.db
      .prepare(`DELETE FROM ${table} WHERE token_hash=?`)
      .run(hash(cookieToken(req)));
    res.clearCookie("slopticus", { path: "/" });
    res.json({ ok: true });
  });
  if (options.releasesDir) app.use(releaseRoutes(options.releasesDir));
  if (options.publicDir) app.use(express.static(options.publicDir));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const invalid =
        error instanceof z.ZodError || error instanceof SyntaxError;
      res.status(invalid ? 400 : 500).json({
        error: invalid ? "Invalid request" : "Unexpected server error",
      });
    },
  );
  return app;
}
