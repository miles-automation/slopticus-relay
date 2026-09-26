# Deployment

The root Compose file builds the relay from this repository and puts Caddy in
front of it. Only Caddy publishes host ports. The relay runs as UID 1000 and
stores SQLite under `/app/data`. Keep that directory writable by UID 1000.

| Variable                   | Purpose                                                  | Default                            |
| -------------------------- | -------------------------------------------------------- | ---------------------------------- |
| `SLOPTICUS_ORIGIN`         | Exact external origin used for browser origin validation | `http://localhost:8787`            |
| `SLOPTICUS_PUBLIC_SIGNUP`  | `1` permits new accounts                                 | Closed                             |
| `SLOPTICUS_SECURE_PAIRING` | `1` enables the opaque encrypted WebSocket transport     | Enabled in Docker                  |
| `SLOPTICUS_DB`             | SQLite path                                              | `data/slopticus.sqlite`            |
| `HOST`                     | Listen interface                                         | Loopback; all interfaces in Docker |
| `PORT`                     | Listen port                                              | `8787`                             |
| `SLOPTICUS_RELEASES`       | Optional directory of signed Mac releases and appcasts   | `releases` next to the database    |

Owner-key authentication and migration were retired in 0.15.1. Back up the
database before upgrading. Startup removes old owner cookies, sign-in codes,
unscoped pending approvals and unclaimed legacy computer registrations.
Create an account and reconnect affected Macs. Existing account-owned data
is retained. Set `SLOPTICUS_PUBLIC_SIGNUP=1` to permit registration; no owner
key is needed. Never roll back to an owner-key or pre-tenancy server.

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
