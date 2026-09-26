# Slopticus Relay

The open-source server for Slopticus: accounts, private and shared workspaces,
Mac enrollment, computer inventory, and encrypted Mac-to-phone traffic.
Run it on your own infrastructure with the Slopticus apps. Your relay account
belongs to your deployment; connecting a Mac does not require an account at
slopticus.com.

Agents and their conversations run on the Mac. The relay can see account,
workspace and connection metadata, but it does not terminate the pinned TLS
connection between paired endpoints or receive its plaintext conversations.
See [architecture and protocol](docs/architecture.md).

## Self-host

Use a server with Docker Compose, a domain pointing at it, ports 80 and 443
open, and persistent local storage. The source build needs no private registry
credentials. The Mac app can be downloaded from [slopticus.com](https://slopticus.com).
The iPhone app is not yet available for general download.

```sh
git clone https://github.com/miles-automation/slopticus-relay.git
cd slopticus-relay
git checkout v0.16.0
cp .env.example .env
```

Set `RELAY_HOSTNAME` in `.env` to your domain, for example
`relay.example.com`. Then run:

```sh
mkdir -p data
sudo chown 1000:1000 data
docker compose up -d --build
curl https://relay.example.com/healthz
curl https://relay.example.com/api/config
```

The health response should be successful; configuration should report
`"public_signup":true`. Caddy obtains the HTTPS certificate. DNS must resolve
and ports 80 and 443 must reach this server before certificate issuance works.

Open `https://relay.example.com/#/manage`, create an account with a password you
choose, and save the one-time recovery code. On the Mac, open **Connect Mac &
iPhone…**, enter the same HTTPS origin, and choose **Connect this Mac**. Approve
the matching code in your browser and select its workspace. Then pair the
iPhone from the Mac. Verify the invitation shows your relay address.

No owner access key is required. To sign in another browser, an
existing session can issue a one-use code. Select **Use a one-use code instead**
in the other browser and enter that temporary code.

Public signup permits anyone who can reach the server to create an account.
Restrict access at your network edge for a private deployment. Disabling
`SLOPTICUS_PUBLIC_SIGNUP` closes new account creation; existing accounts still
work. Do not disable signup before creating your first account.

## Operate and upgrade

Run one relay process with SQLite on local disk. Multiple replicas and shared
network filesystems are not supported. Back up `data` consistently with the
relay stopped, keep backups private, and test restoring to a separate directory.
The database contains accounts, credential hashes, workspace memberships and
computer registrations. Endpoint pairing identities stay on the clients.

Pin a reviewed Git tag or commit before building an update. Back up the
database first. Do not roll a multi-tenant database back to a pre-tenancy server.
See [deployment and upgrades](docs/deploy.md) for configuration and the
retirement of old single-owner credentials. Official Mac downloads and updates use slopticus.com; they
are separate from your relay connection.

## Develop

Node.js 22.13 or newer is required. SQLite uses Node's built-in API.

```sh
make install
make check
make test
make build
SLOPTICUS_PUBLIC_SIGNUP=1 npm start
```

The local server listens on `http://localhost:8787`. Plain HTTP is for local
development; use HTTPS for real clients. The relay builds independently of
the Mac and iPhone applications and has no agent SDK dependency.

## License and provenance

[Apache License 2.0](LICENSE). Original extracted code retains its prior
Unlicense rights; see [NOTICE](NOTICE) and [extraction record](docs/extraction.md).
Dependencies and fonts carry their own licenses. See [security reporting](SECURITY.md)
and [contributing](CONTRIBUTING.md).
