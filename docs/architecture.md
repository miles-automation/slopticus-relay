# Architecture and protocol

The relay stores accounts, organizations, scoped workspaces and computer
registrations in SQLite. Users approve a Mac through a device-code flow on
their selected relay. The Mac receives a workspace-bound reporting credential;
the server stores its hash. Accounts outside that workspace cannot view or
approve its computers. A workspace administrator may revoke a computer.

Phone transport uses a WebSocket route at
`/api/secure-relay/<computer UUID>/{mac,phone}`. The Mac side authenticates with
the registered computer credential. Each slot accepts one Mac and one phone.
Binary WebSocket payloads carry an endpoint TLS stream. The relay neither
possesses endpoint private keys nor terminates that inner TLS session. Paired
endpoints verify pinned certificates. Relaying bytes is not evidence that a
phone received or acted on an application message.

The server enforces payload, burst, idle, lifetime and keepalive limits.
Client tunnels reconnect before the relay's slot lifetime. Computer credential
revocation closes its slot. Workspace membership and relay access do not
authorize a new endpoint or give it conversation decryption keys; endpoint
pairing and phone revocation remain client responsibilities.

The relay sees connection timing, IP addresses, account names, workspace
membership, computer names and reported inventory metadata. Prompts, transcripts,
agent credentials and workflow execution stay on clients. An operator may
disrupt or observe traffic metadata even though endpoint encryption protects
conversation contents.

Accounts use salted scrypt password hashes. Recovery and invitation credentials
are stored as hashes. Browser sessions use expiring HttpOnly, SameSite cookies;
HTTPS deployments use Secure cookies. API calls reject mismatched browser origins.

Contracts are in [accounts OpenAPI](accounts-openapi.json) and
[inventory OpenAPI](inventory-openapi.json). `/healthz` returns the relay
release version and protocol version. Protocol 1 remains compatible with the
Slopticus 0.15.0 clients. Server and client release versions need not match;
compatibility changes require contract tests and release notes.

Optional file-backed Mac downloads and Sparkle appcasts are retained for the
hosted service's initial cutover. Self-hosted relays need no signing credentials
and do not publish official Mac updates. The landing page links to official
downloads; the clients use their selected relay for account and pairing traffic.
