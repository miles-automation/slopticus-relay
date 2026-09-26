import {
  computersHTML,
  wireComputers,
  pairingHTML,
  wirePairing,
} from "./computers.js";
import type { ComputerView } from "../src/inventory.js";
import type { WorkspaceView } from "../src/tenancy.js";
import { escape } from "./html.js";
import { landingHTML } from "./landing.js";
import { selfHostHTML } from "./self-host.js";
import { loginHTML, signInAnotherDeviceInstruction } from "./login.js";
import {
  loginContextForHash,
  resultForCurrentHash,
  viewForHash,
} from "./routes.js";
import "@fontsource/rajdhani/latin-600.css";
import "@fontsource/rajdhani/latin-700.css";
import "@fontsource/space-grotesk/latin-400.css";
import "@fontsource/space-grotesk/latin-500.css";
import "./base.css";
import "./phone.css";
const app = document.querySelector<HTMLDivElement>("#app")!;
type Identity = {
  kind: "account";
  account: { username: string; display_name: string };
  workspaces: WorkspaceView[];
};
let computers: ComputerView[] | undefined,
  identity: Identity | undefined,
  workspaceId = "",
  signedIn = false,
  signupEnabled = false,
  painted = "",
  handledHash = "";
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
function error(message: string) {
  const el = document.querySelector("#status");
  if (el) el.textContent = message;
}
function login() {
  signedIn = false;
  painted = "";
  app.innerHTML = loginHTML(loginContextForHash(location.hash), signupEnabled);
  const submit = (selector: string, action: () => Promise<void>): void => {
    document.querySelector<HTMLFormElement>(selector)!.onsubmit = (
      event,
    ): void => {
      event.preventDefault();
      void action();
    };
  };
  const value = (id: string): string =>
    document.querySelector<HTMLInputElement>(id)!.value;
  const recoveryScreen = (code: string): void => {
    app.innerHTML = `<main class="login"><div class="brand">Slopticus</div><h1>Save your recovery code</h1><p>This code restores your account if you lose the password. It is shown only now. Store it in your password manager.</p><input id="new-recovery-code" readonly spellcheck="false"><button id="recovery-saved">I saved the code</button></main>`;
    document.querySelector<HTMLInputElement>("#new-recovery-code")!.value =
      code;
    document.querySelector<HTMLButtonElement>("#recovery-saved")!.onclick =
      (): void => {
        void refresh();
      };
  };
  submit("#account-login", async () => {
    try {
      await api("login/account", {
        username: value("#username"),
        password: value("#password"),
      });
      await refresh();
    } catch (e) {
      error((e as Error).message);
    }
  });
  if (document.querySelector("#signup"))
    submit("#signup", async () => {
      try {
        const created: { recovery_code: string } = await api("signup", {
          username: value("#signup-username"),
          display_name: value("#signup-name"),
          password: value("#signup-password"),
        });
        recoveryScreen(created.recovery_code);
      } catch (e) {
        document.querySelector("#signup-status")!.textContent = (
          e as Error
        ).message;
      }
    });
  submit("#recover", async () => {
    try {
      const recovered: { recovery_code: string } = await api("recover", {
        username: value("#recover-username"),
        recovery_code: value("#recover-code"),
        password: value("#recover-password"),
      });
      recoveryScreen(recovered.recovery_code);
    } catch (e) {
      document.querySelector("#recover-status")!.textContent = (
        e as Error
      ).message;
    }
  });
  document
    .querySelector("#code-login")!
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const button =
        document.querySelector<HTMLButtonElement>("#code-login button")!;
      button.disabled = true;
      try {
        await api("login/code", {
          code: document.querySelector<HTMLInputElement>("#access-code")!.value,
        });
        await refresh();
      } catch (e) {
        document.querySelector("#code-status")!.textContent = (
          e as Error
        ).message;
      } finally {
        button.disabled = false;
      }
    });
}
function headerHTML() {
  const choices =
    identity?.workspaces
      .map(
        (workspace) =>
          `<option value="${workspace.id}"${workspace.id === workspaceId ? " selected" : ""}>${escape(workspace.organization_name)} · ${escape(workspace.name)}</option>`,
      )
      .join("") ?? "";
  return `<header><a class="brand" href="#/"><span class="mark"></span>Slopticus</a><div class="header-actions"><label for="workspace-select">Workspace</label><select id="workspace-select">${choices}</select><button id="workspace-actions" class="quiet">Workspaces</button><button id="access-help" class="quiet">Sign-in help</button><button id="logout" class="quiet">Sign out</button></div></header>`;
}
function wireShell() {
  document.querySelector<HTMLSelectElement>("#workspace-select")!.onchange = (
    event,
  ): void => {
    workspaceId = (event.target as HTMLSelectElement).value;
    void refresh();
  };
  document.querySelector<HTMLButtonElement>("#workspace-actions")!.onclick =
    workspaceActions;
  document.querySelector<HTMLButtonElement>("#access-help")!.onclick =
    accessHelp;
  document.querySelector<HTMLButtonElement>("#logout")!.onclick = async () => {
    try {
      await api("logout", {});
      login();
    } catch (e) {
      error((e as Error).message);
    }
  };
}
function workspaceActions(): void {
  const dialog = document.querySelector<HTMLDialogElement>("#setup")!;
  const active = identity?.workspaces.find(
    (workspace) => workspace.id === workspaceId,
  );
  const ownUsername =
    identity?.kind === "account" ? identity.account.username : undefined;
  const teamAdmin =
    active?.kind === "shared" && active.organization_role !== "member";
  const workspaceAdmin = active?.kind === "shared" && active.role !== "member";
  dialog.innerHTML = `<button class="quiet close">Close ×</button><h2>Workspaces</h2><p>Your private workspace is yours alone. A team workspace is visible to its invited members and the organization owner, who can recover administration if someone leaves. Sharing shows computer inventory; a phone still needs its own pairing on the Mac.</p><form id="create-org"><label for="org-name">New organization</label><input id="org-name" maxlength="80" required><button>Create organization and shared workspace</button></form>${teamAdmin ? '<form id="create-workspace"><label for="workspace-name">Another workspace in this organization</label><input id="workspace-name" maxlength="80" required><button>Create workspace</button></form>' : ""}${workspaceAdmin ? `<form id="invite"><label for="invite-role">Invite to this workspace</label><select id="invite-role"><option value="member">Member: view computers</option><option value="admin">Workspace admin: approve and disconnect computers</option>${active?.organization_role === "owner" ? '<option value="organization_admin">Organization admin: create workspaces too</option>' : ""}</select><button>Create one-use invitation</button></form><input id="invite-result" readonly hidden spellcheck="false"><div id="workspace-members"></div>` : ""}${active?.organization_role === "owner" && active.kind === "shared" ? '<div id="organization-members"></div>' : ""}<form id="join"><label for="join-code">Join a shared workspace</label><input id="join-code" required spellcheck="false"><button>Join with invitation code</button></form><p id="workspace-status" role="status"></p>`;
  const status = dialog.querySelector<HTMLElement>("#workspace-status")!;
  const close = (): void => {
    dialog.close();
    dialog.innerHTML = "";
    void refresh();
  };
  dialog.querySelector<HTMLButtonElement>(".close")!.onclick = close;
  dialog.oncancel = (event): void => {
    event.preventDefault();
    close();
  };
  const bind = (selector: string, action: () => Promise<void>): void => {
    const form = dialog.querySelector<HTMLFormElement>(selector);
    if (!form) return;
    form.onsubmit = (event): void => {
      event.preventDefault();
      void action().catch((error: Error) => {
        status.textContent = error.message;
      });
    };
  };
  const value = (selector: string): string =>
    dialog.querySelector<HTMLInputElement>(selector)!.value;
  bind("#create-org", async () => {
    const created: WorkspaceView = await api("organizations", {
      name: value("#org-name"),
    });
    workspaceId = created.id;
    close();
  });
  bind("#create-workspace", async () => {
    const created: WorkspaceView = await api(
      `organizations/${active!.organization_id}/workspaces`,
      { name: value("#workspace-name") },
    );
    workspaceId = created.id;
    close();
  });
  bind("#invite", async () => {
    const role = dialog.querySelector<HTMLSelectElement>("#invite-role")!.value;
    const result: { code: string } = await api(
      `workspaces/${workspaceId}/invitations`,
      { role },
    );
    const field = dialog.querySelector<HTMLInputElement>("#invite-result")!;
    field.hidden = false;
    field.value = result.code;
    field.select();
    status.textContent =
      "Copy this one-use code and send it to the person you want in this workspace. It expires in seven days.";
  });
  if (workspaceAdmin) {
    void api(`workspaces/${workspaceId}/members`)
      .then(
        (
          members: {
            id: string;
            username: string;
            role: string;
          }[],
        ) => {
          const list = dialog.querySelector<HTMLElement>("#workspace-members");
          if (!list) return;
          list.innerHTML = `<h3>People in this workspace</h3>${members.map((member) => `<div>${escape(member.username)} · ${escape(member.role)}${member.role !== "owner" && member.username !== ownUsername ? ` <button class="quiet remove-member" data-id="${member.id}">Remove</button>` : ""}</div>`).join("")}<p>Removing someone stops dashboard access. If their phone was paired to a Mac, revoke that phone in the Mac app separately.</p>`;
          list
            .querySelectorAll<HTMLButtonElement>(".remove-member")
            .forEach((button) => {
              button.onclick = (): void => {
                if (!confirm("Remove this person from the workspace?")) return;
                void api(
                  `workspaces/${workspaceId}/members/${button.dataset.id}/remove`,
                  {},
                )
                  .then(() => {
                    button.closest("div")?.remove();
                  })
                  .catch((error: Error) => {
                    status.textContent = error.message;
                  });
              };
            });
        },
      )
      .catch((error: Error) => {
        status.textContent = error.message;
      });
  }
  if (active?.organization_role === "owner" && active.kind === "shared") {
    void api(`organizations/${active.organization_id}/members`)
      .then((members: { id: string; username: string; role: string }[]) => {
        const list = dialog.querySelector<HTMLElement>("#organization-members");
        if (!list) return;
        list.innerHTML = `<h3>People in this organization</h3>${members.map((member) => `<div>${escape(member.username)} · ${escape(member.role)}${member.role === "owner" ? "" : ` <button class="quiet remove-organization-member" data-id="${member.id}">Remove from organization</button>`}</div>`).join("")}<p>Removal ends access to every workspace in this organization. Any phone paired to a Mac must be revoked on that Mac separately.</p>`;
        list
          .querySelectorAll<HTMLButtonElement>(".remove-organization-member")
          .forEach((button) => {
            button.onclick = (): void => {
              if (
                !confirm(
                  "Remove this person from every workspace in the organization?",
                )
              )
                return;
              void api(
                `organizations/${active.organization_id}/members/${button.dataset.id}/remove`,
                {},
              )
                .then(() => button.closest("div")?.remove())
                .catch((error: Error) => {
                  status.textContent = error.message;
                });
            };
          });
      })
      .catch((error: Error) => {
        status.textContent = error.message;
      });
  }
  bind("#join", async () => {
    const joined: WorkspaceView = await api("invitations/accept", {
      code: value("#join-code").trim(),
    });
    workspaceId = joined.id;
    close();
  });
  dialog.showModal();
}
function render() {
  const view = viewForHash(location.hash);
  if (view.kind === "landing") {
    if (!document.querySelector(".landing-hero")) {
      app.innerHTML = landingHTML(
        signupEnabled,
        location.hostname === "slopticus.com",
      );
      if (location.hash === "#/" || !location.hash) window.scrollTo(0, 0);
      else document.getElementById(location.hash.slice(1))?.scrollIntoView();
    }
    return;
  }
  if (view.kind === "self-host") {
    if (!document.querySelector(".self-host-guide")) {
      app.innerHTML = selfHostHTML();
      window.scrollTo(0, 0);
    }
    return;
  }
  if (!computers || !identity) return;
  if (view.kind === "pair-computer") {
    if (
      handledHash !== location.hash ||
      !document.querySelector("#approve-computer")
    ) {
      handledHash = location.hash;
      painted = "";
      app.innerHTML = pairingHTML(
        view.code,
        identity.workspaces.filter((workspace) => workspace.role !== "member"),
      );
      void wirePairing(view.code, api);
    }
    return;
  }
  const arrived = handledHash !== location.hash;
  handledHash = location.hash;
  const active = identity.workspaces.find(
    (workspace) => workspace.id === workspaceId,
  );
  const html = `${headerHTML()}${computersHTML(computers, active?.role !== "member")}<dialog id="setup"></dialog>`;
  if (html === painted && !arrived) return;
  if (document.querySelector<HTMLDialogElement>("#setup")?.open) return;
  const offset = window.scrollY;
  app.innerHTML = html;
  painted = html;
  wireShell();
  wireComputers(api, refresh, workspaceId);
  window.scrollTo(0, offset);
}
function accessHelp(): void {
  const dialog = document.querySelector<HTMLDialogElement>("#setup")!;
  dialog.innerHTML = `<button class="quiet close">Close ×</button><h2>Sign in another device</h2><p>${signInAnotherDeviceInstruction()}</p><p>The code works once, expires in 10 minutes, and grants the same access as this sign-in. Use it only on a device you trust.</p><button id="make-code">Create sign-in code</button><div id="code-result" hidden><label for="generated-code">One-use sign-in code</label><input id="generated-code" class="generated-code" readonly spellcheck="false"><p id="code-expiry"></p><div class="access-actions"><button id="copy-code" class="secondary">Copy code</button><button id="revoke-code" class="quiet">Revoke code</button></div></div><p id="access-status" role="status"></p>`;
  const status = dialog.querySelector<HTMLParagraphElement>("#access-status")!;
  const field = dialog.querySelector<HTMLInputElement>("#generated-code")!;
  const result = dialog.querySelector<HTMLDivElement>("#code-result")!;
  const create = dialog.querySelector<HTMLButtonElement>("#make-code")!;
  const close = (): void => {
    dialog.close();
    dialog.innerHTML = "";
    render();
  };
  dialog.querySelector<HTMLButtonElement>(".close")!.onclick = close;
  dialog.oncancel = (event): void => {
    event.preventDefault();
    close();
  };
  create.onclick = async (): Promise<void> => {
    create.disabled = true;
    status.textContent = "";
    try {
      const data: { code: string; expires: number } = await api(
        "access-codes",
        {},
      );
      field.value = data.code;
      result.hidden = false;
      dialog.querySelector("#code-expiry")!.textContent =
        `Expires at ${new Date(data.expires).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Creating a new code replaces this one.`;
      create.textContent = "Create a new code";
    } catch (error) {
      status.textContent = (error as Error).message;
    } finally {
      create.disabled = false;
    }
  };
  dialog.querySelector<HTMLButtonElement>("#copy-code")!.onclick =
    async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(field.value);
        status.textContent =
          "Copied. Enter it on the other device within 10 minutes.";
      } catch {
        field.focus();
        field.select();
        status.textContent = "Select and copy the code manually.";
      }
    };
  dialog.querySelector<HTMLButtonElement>("#revoke-code")!.onclick =
    async (): Promise<void> => {
      try {
        const response = await fetch("/api/access-codes", { method: "DELETE" });
        if (!response.ok)
          throw new Error("Could not revoke the code. Try again.");
        field.value = "";
        result.hidden = true;
        status.textContent = "Code revoked.";
      } catch (error) {
        status.textContent = (error as Error).message;
      }
    };
  dialog.showModal();
}
async function refresh() {
  const requestedHash = location.hash;
  const publicView = viewForHash(requestedHash);
  if (publicView.kind === "landing" || publicView.kind === "self-host") {
    render();
    painted = "";
    handledHash = location.hash;
    return;
  }
  try {
    const response = await resultForCurrentHash(
      requestedHash,
      () => location.hash,
      () => fetch("/api/me"),
    );
    if (!response) return;
    if (response.status === 401) {
      login();
      return;
    }
    if (!response.ok) throw new Error("Unable to refresh");
    const me = (await response.json()) as Identity;
    identity = me;
    if (!me.workspaces.some((workspace) => workspace.id === workspaceId))
      workspaceId = me.workspaces[0]?.id ?? "";
    const inventory = await resultForCurrentHash(
      requestedHash,
      () => location.hash,
      () =>
        fetch(`/api/computers?workspace_id=${encodeURIComponent(workspaceId)}`),
    );
    if (!inventory) return;
    if (!inventory.ok) throw new Error("Unable to refresh inventory");
    computers = await inventory.json();
    signedIn = true;
    render();
  } catch {
    if (location.hash !== requestedHash) return;
    if (!signedIn) login();
    else {
      render();
      error("Cannot refresh inventory. Displayed observations may be stale.");
    }
  }
}
addEventListener("hashchange", () => {
  void refresh();
});
void navigator.serviceWorker
  ?.getRegistrations()
  .then((registrations) => registrations.forEach((r) => void r.unregister()))
  .catch(() => {});
void fetch("/api/config")
  .then(async (response) => {
    if (response.ok)
      signupEnabled = Boolean((await response.json()).public_signup);
  })
  .catch(() => {})
  .finally(() => void refresh());
setInterval(() => {
  if (
    signedIn &&
    !document.hidden &&
    viewForHash(location.hash).kind === "computers"
  )
    void refresh();
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
