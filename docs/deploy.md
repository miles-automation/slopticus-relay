# Deployment

The root Compose file builds the relay from this repository and puts Caddy in
front of it. Only Caddy publishes host ports. The relay runs as UID 1000 and
stores SQLite under `/app/data`. Keep that directory writable by UID 1000.

| Variable                   | Purpose                                                         | Default                            |
| -------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| `SLOPTICUS_ORIGIN`         | Exact external origin used for browser origin validation        | `http://localhost:8787`            |
| `SLOPTICUS_PUBLIC_SIGNUP`  | `1` permits new accounts when no legacy owner key is configured | Closed                             |
| `SLOPTICUS_SECURE_PAIRING` | `1` enables the opaque encrypted WebSocket transport            | Enabled in Docker                  |
| `SLOPTICUS_DB`             | SQLite path                                                     | `data/slopticus.sqlite`            |
| `HOST`                     | Listen interface                                                | Loopback; all interfaces in Docker |
| `PORT`                     | Listen port                                                     | `8787`                             |
| `SLOPTICUS_RELEASES`       | Optional directory of signed Mac releases and appcasts          | `releases` next to the database    |
| `SLOPTICUS_OWNER_TOKEN`    | Existing single-owner installation migration only               | Unset                              |

For an existing database, retain its legacy owner key for the first upgrade.
Sign in through **Existing single-owner server?**, create an account and claim
the legacy workspace. Existing computer credentials continue working. Save the
new recovery code and verify the existing Macs still report. Then remove the
legacy key and enable public signup if desired. A configured legacy key keeps
public signup closed even if the flag is set. Never roll back to a pre-tenancy
server after allowing multiple accounts.

The source build is currently the supported public installation path. The
previous `slopticus-relay:0.15.0` image was built from the private application
repository. It predates this extraction and must not be described as a build of
this public source. Future public images must identify their source revision,
pass anonymous pull verification, and use a new immutable tag.

For an upgrade, stop the relay, take a complete private copy of its data
directory, and retain the currently running image. Start the new version and
verify health, account access and computer reporting. Test restoration with
the prior image and backup in an isolated environment; application compatibility
does not imply that an older server understands a newer database.
