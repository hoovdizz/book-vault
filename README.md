# Book Vault

Book Vault is an original, self-hosted household book catalog, circulation system, and private reading tracker. It runs as one container with a React PWA, a Node API, and an embedded SQLite database. No separate database container or public account service is required.

Book Vault models a title at three distinct levels:

- A **work** is the conceptual book.
- An **edition** is a publication with its own ISBN, publisher, binding, language, date, page count, provider records, and cover.
- A **copy** is a physical, ebook, or audiobook item owned by a person or by the household. Every copy can have its own owner, location, condition, purchase details, custom barcode, history, and loan state.

Reading state and sessions belong to an individual person and a work or edition. They never belong to a shared physical copy. Loans always identify a particular copy.

## Highlights

- Household roles: system administrator, household administrator, adult, child, and read-only viewer
- Private per-person reading notes, status, history, ratings, favorites, goals, and preferred formats
- ISBN-10/ISBN-13, title, author, camera, USB, and Bluetooth scanner entry
- Continuous batch scanning with editable review results and intentional duplicate-copy actions
- Google Books and Open Library behind a configurable, cached provider interface
- Optional Hardcover enrichment for covers and series data
- Hierarchical buildings, rooms, bookcases, shelves, and bins with printable QR labels
- Cover, detailed, and compact catalog views with server pagination, saved filters, custom collections, tags, and custom fields
- Edition-aware duplicate review, series positions including decimals and omnibus roles, and missing-volume indicators
- Historical loans, member or external borrowers, holds, due dates, renewals, overdue/lost/damaged states, and batch check-in
- CSV import dry runs and mappings for Goodreads, LibraryThing, Libib, CLZ Books, BookBuddy, and generic CSV
- CSV/JSON/reading/loan exports, downloadable backups, restore preview, and SQLite integrity checks
- Installable PWA with a cached application shell and a deliberate offline screen; authenticated data is not placed in the public service-worker cache
- Light/dark themes, visible keyboard focus, reduced-motion support, labels, responsive layouts, and large touch targets

Book Vault does not copy the code, branding, wording, or layouts of another catalog product.

## Persistent container data

All durable data lives under `/config`:

```text
/config/book-vault.sqlite
/config/backups/
/config/covers/
/config/uploads/
/config/imports/
/config/logs/
```

The database uses SQLite WAL mode. Book Vault creates a consistent SQLite snapshot before its first destructive schema migration and records every applied schema version. Existing users, safely reusable hashed sessions, households/families, books, reading state, locations, conditions, loan records, covers, wishlist entries, backlog entries, collections, series, editions, and formats are migrated without silently deleting the legacy rows.

Raw-token sessions from the earliest schema are intentionally invalidated instead of retaining exposed bearer credentials. Users simply sign in again.

Do not store the only backup inside an unmounted container filesystem. Map the complete `/config` directory to persistent storage.

## Container settings

| Setting | Default | Purpose |
| --- | --- | --- |
| Container port | `8130` | Web interface and API |
| `/config` | required | Persistent application data |
| `PUID` | `99` | Runtime UID (`nobody` on Unraid) |
| `PGID` | `100` | Runtime GID (`users` on Unraid) |
| `TZ` | `America/New_York` | Container timezone |
| `DATABASE_PATH` | `/config/book-vault.sqlite` | SQLite path inside the container |
| `ADMIN_NAME` | `bookvaultadmin` | First administrator display name |
| `ADMIN_EMAIL` | `admin@bookvault.local` in the template | First administrator login |
| `ADMIN_PASSWORD` | no default | Required unique 12–128 character first-run password |
| `SESSION_DAYS` | `30` | Server-side session lifetime |
| `GOOGLE_BOOKS_API_KEY` | empty | Optional server-side API key |
| `HARDCOVER_API_TOKEN` | empty | Optional server-side Hardcover token |
| `BOOK_LOOKUP_TIMEOUT_MS` | `6000` | Per-provider timeout, bounded to 2–10 seconds |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-Proto` only behind a controlled proxy |

The administrator variables are used only when the database has no users. Changing them later does not reset an existing account. Book Vault deliberately has no production default password and public registration is disabled.

## Install on Unraid

### Install the template

Unraid’s **Add Container** advanced view does not contain a remote-template URL field. Install the XML from the Unraid terminal:

```sh
mkdir -p /boot/config/plugins/dockerMan/templates-user
curl --fail --location \
  https://raw.githubusercontent.com/hoovdizz/book-vault/development/unraid/book-vault.xml \
  --output /boot/config/plugins/dockerMan/templates-user/my-book-vault.xml
```

Then:

1. Open **Docker → Add Container**.
2. Select **BookVault** from the **Template** dropdown. Refresh the page if it was already open.
3. Confirm repository `ghcr.io/hoovdizz/book-vault:development`.
4. Confirm host path `/mnt/user/appdata/book-vault` maps to container path `/config`.
5. Confirm host port `8130` maps to container port `8130`.
6. Enter a unique value in **Admin password**. The field is intentionally blank.
7. Select **Apply**, then open `http://UNRAID-IP:8130`.

The template source is [`unraid/book-vault.xml`](unraid/book-vault.xml). [`unraid-defaults.yaml`](unraid-defaults.yaml) is a human-readable reference; Unraid does not import YAML container templates.

### Add the container manually

In **Docker → Add Container**, use:

| Field | Value |
| --- | --- |
| Name | `BookVault` |
| Repository | `ghcr.io/hoovdizz/book-vault:development` |
| Network type | `Bridge` |
| WebUI | `http://[IP]:[PORT:8130]` |

Use **Add another Path, Port, Variable, Label or Device** for:

| Type | Target | Host/default value |
| --- | --- | --- |
| Port | `8130` | `8130` |
| Path | `/config` | `/mnt/user/appdata/book-vault` |
| Variable | `PUID` | `99` |
| Variable | `PGID` | `100` |
| Variable | `TZ` | `America/New_York` |
| Variable | `ADMIN_NAME` | `bookvaultadmin` |
| Variable | `ADMIN_EMAIL` | your administrator email |
| Variable | `ADMIN_PASSWORD` | a unique password of at least 12 characters |

Optional variables are listed in the container-settings table above.

### Terminal installation

```sh
docker pull ghcr.io/hoovdizz/book-vault:development
docker run -d \
  --name book-vault \
  --restart unless-stopped \
  -p 8130:8130 \
  -v /mnt/user/appdata/book-vault:/config \
  -e TZ=America/New_York \
  -e PUID=99 \
  -e PGID=100 \
  -e ADMIN_NAME=bookvaultadmin \
  -e ADMIN_EMAIL='admin@example.com' \
  -e ADMIN_PASSWORD='replace-with-a-unique-long-password' \
  ghcr.io/hoovdizz/book-vault:development
```

Do not add a Docker `--user` override. The entrypoint starts briefly as root only to repair ownership of the dedicated `/config` mount, then runs Book Vault as `PUID:PGID`. On Unraid, the defaults appear on the host as `nobody:users`.

Verify:

```sh
docker port book-vault
docker exec book-vault wget -qO- http://127.0.0.1:8130/api/health
stat -c '%U:%G (%u:%g)' /mnt/user/appdata/book-vault
```

Expected results include:

```text
8130/tcp -> 0.0.0.0:8130
{"status":"ok"}
nobody:users (99:100)
```

The Node 22 `ExperimentalWarning` for built-in SQLite is informational. A successful startup also logs:

```text
BookVault listening on http://0.0.0.0:8130
```

### Upgrade an existing Unraid container

Pull the image and refresh the locally stored template:

```sh
docker pull ghcr.io/hoovdizz/book-vault:development
curl --fail --location \
  https://raw.githubusercontent.com/hoovdizz/book-vault/development/unraid/book-vault.xml \
  --output /boot/config/plugins/dockerMan/templates-user/my-book-vault.xml
```

Refreshing the XML does not overwrite an already-created container’s settings. Open the existing container’s **Edit** page to change its repository, variables, or port.

If an older container still shows `3000/tcp`, remove that port entry and add TCP container port `8130` with host port `8130`. Remove any `PORT=3000` variable or change it to `8130`, then select **Apply**.

If startup reports `unable to open database file`, verify the mapping is exactly:

```text
/mnt/user/appdata/book-vault -> /config
```

Recreating the current container repairs `/config` ownership before dropping to UID `99`, GID `100`.

### GHCR “unauthorized”

Anonymous Unraid pulls require the GHCR package to be public. Package owners can change visibility in the [Book Vault package settings](https://github.com/users/hoovdizz/packages/container/book-vault/settings).

For a deliberately private package, log in without putting a token in the XML or shell history:

```sh
export GHCR_USER='your-github-username'
read -rsp 'GitHub package token: ' GHCR_TOKEN
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
unset GHCR_TOKEN
docker pull ghcr.io/hoovdizz/book-vault:development
```

## Pull main or development

Source branches:

```sh
git clone --branch main https://github.com/hoovdizz/book-vault.git
git clone --branch development https://github.com/hoovdizz/book-vault.git book-vault-development
```

Container images:

```sh
# Main branch
docker pull ghcr.io/hoovdizz/book-vault:latest

# Development branch
docker pull ghcr.io/hoovdizz/book-vault:development
```

The publish workflow maps `main` to `latest` and `development` to `development`.

## First-use workflow

1. Sign in with the administrator credentials entered during installation.
2. Open **Settings** and create the household location hierarchy and defaults.
3. Add adults, child profiles, viewers, or household administrators directly, or create a controlled one-time invitation.
4. Open **Collection → Add book** for a single lookup, or **Batch scan** for continuous camera/USB/Bluetooth entry.
5. Open **Administration** to configure provider order, define custom fields, import existing data, and create the first backup.

Camera access is requested only when a scanner opens. Live camera scanning normally requires HTTPS; the photo-based scanner remains available when the browser cannot grant a live stream. The installed PWA has the same catalog and scanner workflows as the desktop view.

Location labels are created under **Settings → Hierarchical locations**. Select a batch destination from the hierarchy or scan its Book Vault QR label before scanning the books going there.

## Metadata and covers

Administrators choose the lookup order under **Administration → Metadata providers**. Google Books and Open Library can fill each other’s gaps; manual entry always remains available. Provider errors never block a manual save.

Important edition fields retain provider provenance, lookup dates, source record IDs, original ISBNs, refresh dates, and manual-override markers. Provider refreshes skip manually overridden fields. Selected external covers are validated and cached below `/config/covers`; manual uploads are limited to 5 MB and validated from their actual JPEG, PNG, GIF, or WebP bytes.

The quality dashboard reports missing covers, ISBNs, authors, suspicious dates, duplicate editions, unknown series positions, and incomplete records. Metadata-refresh and cover-backfill jobs are limited, tracked, and visible in the administrator area.

Outbound provider requests contain only the lookup query. Telemetry is disabled.

## Backups, restore, import, and export

Household administrators can:

- create and download a consistent backup archive containing SQLite and cached covers;
- schedule `daily@HH:MM` backups and configure retention;
- inspect last-success status and run `PRAGMA integrity_check`;
- preview a restore, review counts and cover files, type an explicit confirmation, and stage it for the next restart;
- export catalog CSV, household JSON, personal reading JSON, and loan-history CSV;
- dry-run CSV imports, edit column mappings, review errors/duplicates, and preserve unknown columns in the import report.

A restore always creates a pre-restore safety backup first. Never interrupt a container while it is applying a staged restore.

## Security model

- Passwords use salted asynchronous scrypt hashes.
- Session bearer values are random, stored only as hashes, expire server-side, and use `HttpOnly; SameSite=Strict` cookies.
- Public registration and telemetry are disabled.
- Every protected action resolves the user and household on the server; client-side role values are not trusted.
- Child and viewer permissions are enforced server-side.
- Personal private notes are omitted from other members’ responses and household exports.
- Private gifts are hidden from their intended recipient.
- Administrator changes, backup/restore actions, account changes, loans, metadata jobs, and other sensitive actions are audited without passwords, tokens, hashes, or private notes.
- Request bodies, imports, uploads, log details, provider rates, and login attempts are bounded.
- CSP, origin checks, security headers, cover-host validation, and household-scoped queries are enabled.
- Legacy `/api/books`, `/api/family`, and `/api/settings` routes are disabled in production; the normalized APIs are the default.

For remote access, place Book Vault behind a trusted HTTPS reverse proxy. Set `TRUST_PROXY=true` only when direct client access to the application port is blocked and the proxy controls `X-Forwarded-Proto`.

## Performance benchmark

The schema includes indexes for 25,000 works, 35,000 editions, 50,000 copies, provider identifiers, ISBNs, locations, reading histories, active loans, edition counts, and list entries. Catalog responses use server pagination and never send the complete household library to every view.

Run the repeatable target-size benchmark:

```sh
npm run benchmark
```

It creates a temporary database, seeds 25,000 works, 35,000 editions, and 50,000 copies, measures warm catalog search and duplicate lookup, prints JSON, and removes its temporary database. Set `BENCHMARK_DATABASE_PATH` to retain a new benchmark database; the script refuses to overwrite an existing file.

Reference validation on a Windows development machine produced a warm-search p95 below 500 ms at the target size. Storage, CPU, filesystem, and concurrent provider work affect results.

## Local development

Node.js 22 or later is required.

```sh
npm ci
npm test
npm run lint
npm run build
```

Run a production-style local server:

```powershell
$env:ADMIN_EMAIL = "admin@example.com"
$env:ADMIN_PASSWORD = "replace-with-a-unique-long-password"
npm start
```

Or use Docker Compose after setting `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the environment or an uncommitted `.env`:

```sh
docker compose up -d --build
```

## Health check

`GET /api/health` returns:

```json
{"status":"ok"}
```
