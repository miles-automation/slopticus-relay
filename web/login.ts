export type LoginContext = "console" | "computer-approval";
export const ONE_USE_CODE_DISCLOSURE = "Use a one-use code instead";

export function signInAnotherDeviceInstruction(): string {
  return `Create a code here, then open Slopticus in the other browser and choose <strong>${ONE_USE_CODE_DISCLOSURE}</strong>.`;
}

export function loginHTML(
  context: LoginContext,
  signupEnabled = true,
  migration = false,
): string {
  const approval = context === "computer-approval";
  const signIn = `<form id="account-login"><label for="username">Username</label><input id="username" autocomplete="username" required><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required><button>Sign in</button><p id="status" role="status"></p></form>`;
  const signup = `<form id="signup"><label for="signup-name">Your name</label><input id="signup-name" autocomplete="name" required><label for="signup-username">Username</label><input id="signup-username" autocomplete="username" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" required><label for="signup-password">Password (12 or more characters)</label><input id="signup-password" type="password" minlength="12" autocomplete="new-password" required><button>Create account</button><p id="signup-status" role="status"></p></form>`;
  const canCreate = signupEnabled || migration;
  const primary = migration ? signup : approval || !canCreate ? signIn : signup;
  const secondary = canCreate
    ? `<details class="access-help"><summary>${migration || !approval ? "Already have an account? Sign in" : "Create an account"}</summary>${migration || !approval ? signIn : signup}</details>`
    : "";
  const introduction = migration
    ? "Create your account to claim the existing computers. Save the recovery code shown afterward."
    : approval
      ? "Sign in to review the connection request from your Mac."
      : signupEnabled
        ? "Create an account to connect your Mac. Your private workspace is ready immediately, and you can make shared spaces for a team."
        : "Sign in to manage your computers. New account creation is not open yet.";
  return `<main class="login"><div class="brand"><span class="mark"></span>Slopticus</div><div class="carrier"></div><h1>${approval ? "Approve this Mac" : "Your computers,<br>one relay away."}</h1><p>${introduction}</p>${primary}${secondary}<details class="access-help"><summary>${ONE_USE_CODE_DISCLOSURE}</summary><p>Already signed in on another browser? Create a code there under <strong>Sign-in help</strong>.</p><form id="code-login"><label for="access-code">One-use sign-in code</label><input id="access-code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="40" required><button>Sign in with code</button><p id="code-status" role="status"></p></form></details><details class="access-help"><summary>Recover an account</summary><p>Use the recovery code shown when your account was created. A new code replaces it after recovery.</p><form id="recover"><label for="recover-username">Username</label><input id="recover-username" autocomplete="username" required><label for="recover-code">Recovery code</label><input id="recover-code" required><label for="recover-password">New password</label><input id="recover-password" type="password" minlength="12" autocomplete="new-password" required><button>Reset password</button><p id="recover-status" role="status"></p></form></details><details class="access-help"><summary>Existing single-owner server?</summary><p>Sign in once with its owner recovery key, then create an account to move its computers into your private workspace.</p><form id="legacy-login"><label for="key">Existing owner recovery key</label><input id="key" type="password" required><button>Continue migration</button><p id="legacy-status" role="status"></p></form></details><small>Your coding account and conversations stay on your computer.</small></main>`;
}
