# BookVault

BookVault is a self-hosted personal book-library interface packaged as one lightweight container. The web app, API, authentication, and embedded SQLite database all run together; no separate database container is required.

The Collection and Series screens use books stored in SQLite per user. Dashboard, backlog, and wishlist still contain prototype sample data while those workflows are migrated.

## Container settings

| Setting | Default | Purpose |
| --- | --- | --- |
| Container port | `8130` | Web interface and API |
| `/config` | required | Persistent SQLite database location |
| `TZ` | `America/New_York` | Container timezone |
| `PUID` | `99` | Runtime user and `/config` owner (`nobody` on Unraid) |
| `PGID` | `100` | Runtime group and `/config` group (`users` on Unraid) |
| `GOOGLE_BOOKS_API_KEY` | optional | Server-side Google Books API key; Open Library remains available as fallback |
| `BOOK_LOOKUP_TIMEOUT_MS` | `6000` | Per-provider lookup timeout, bounded to 2–10 seconds |
| `ADMIN_NAME` | `bookvaultadmin` | Initial admin name, used only with a new database |
| `ADMIN_EMAIL` | `admin@bookvault.local` in the Unraid template | Initial admin login, used only with a new database |
| `ADMIN_PASSWORD` | `bookvaultpassword` in the Unraid template | Initial 12–128 character admin password |
| `SESSION_DAYS` | `30` | Login session lifetime |
| `DATABASE_PATH` | `/config/book-vault.sqlite` | Embedded database file |

The database uses SQLite WAL mode, similar to the embedded-database approach used by Sonarr and Radarr. Back up the complete `/config` directory, including any `-wal` and `-shm` files.

## Install on Unraid

### Install the Unraid template

Unraid's **Add Container** advanced view does not have a field for a remote template URL. Install the XML file from the Unraid terminal instead:

```sh
mkdir -p /boot/config/plugins/dockerMan/templates-user
curl --fail --location \
  https://raw.githubusercontent.com/hoovdizz/book-vault/development/unraid/book-vault.xml \
  --output /boot/config/plugins/dockerMan/templates-user/my-book-vault.xml
```

Then:

1. Open the **Docker** tab and select **Add Container**.
2. Open the **Template** dropdown at the top and select **BookVault**. Refresh the page if it does not appear immediately.
3. Use repository `ghcr.io/hoovdizz/book-vault:development`.
4. Map `/config` to `/mnt/user/appdata/book-vault`.
5. Map container port `8130` to an available host port, normally `8130`.
6. The template supplies `admin@bookvault.local` and `bookvaultpassword` for the initial login. Change the password before first launch, especially if the server is reachable by untrusted devices.
7. Select **Apply**, then open `http://UNRAID-IP:8130`.

To remove the locally installed template later:

```sh
rm /boot/config/plugins/dockerMan/templates-user/my-book-vault.xml
```

### Add the container manually

If you prefer not to install the XML template, select **Docker → Add Container** and enter:

| Unraid field | Value |
| --- | --- |
| Name | `BookVault` |
| Repository | `ghcr.io/hoovdizz/book-vault:development` |
| Network Type | `Bridge` |
| WebUI | `http://[IP]:[PORT:8130]` |

Use **Add another Path, Port, Variable, Label or Device** to add:

| Type | Name | Container target | Host/default value |
| --- | --- | --- | --- |
| Port | Web UI | `8130` | `8130` |
| Path | Appdata | `/config` | `/mnt/user/appdata/book-vault` |
| Variable | Timezone | `TZ` | `America/New_York` |
| Variable | User ID | `PUID` | `99` (`nobody` on Unraid) |
| Variable | Group ID | `PGID` | `100` (`users` on Unraid) |
| Variable | Google Books API key | `GOOGLE_BOOKS_API_KEY` | Optional API key, stored as a masked value |
| Variable | Book lookup timeout | `BOOK_LOOKUP_TIMEOUT_MS` | `6000` |
| Variable | Admin name | `ADMIN_NAME` | `bookvaultadmin` |
| Variable | Admin email | `ADMIN_EMAIL` | `admin@bookvault.local` |
| Variable | Admin password | `ADMIN_PASSWORD` | `bookvaultpassword` (change before first launch) |

The admin environment variables create the first account only when the database is empty. Changing them later does not change an existing account.

### Add books

Open **Collection → Add Book** or **Wishlist → Add to Wishlist** and search with a title, ISBN-10, or ISBN-13. Both buttons use the same Google Books/Open Library search, metadata, and cover-selection flow; the Wishlist button automatically saves the book with a wishlist status. Select a result, choose a cover, then optionally record its collection, series, series position, and format before saving. Use **Move to Collection** on a wishlist title after purchasing it; the change is persisted in SQLite.

An API key is not required, but Google may apply lower anonymous quotas. Add a restricted Google Books API key to `GOOGLE_BOOKS_API_KEY` in the Unraid template if Google searches regularly fall back to Open Library. The container requires outbound HTTPS access to:

- `www.googleapis.com`
- `openlibrary.org`
- `books.google.com`
- `books.googleusercontent.com`
- `covers.openlibrary.org`

Book metadata and cover links come from the [Google Books API](https://developers.google.com/books/docs/v1/using) and the [Open Library Search and Covers APIs](https://openlibrary.org/developers/api).

Authenticated book endpoints:

- `GET /api/book-search?q=...&type=auto|title|isbn` searches the metadata providers.
- `GET /api/books?q=...` lists the signed-in user's books and optionally searches title, author, ISBN, collection, or series.
- `POST /api/books` validates and stores a book for the signed-in user.
- `PATCH /api/books/:id/status` moves one of the signed-in user's books between the collection, wishlist, and backlog.

The requested human-readable defaults are in [`unraid-defaults.yaml`](unraid-defaults.yaml). Unraid does not read that YAML file; it imports [`unraid/book-vault.xml`](unraid/book-vault.xml). Unraid also saves a separate local copy for every created container and rewrites that copy when the container is edited.

### Upgrade an existing development container

Pull the newest image and refresh the locally saved template:

```sh
docker pull ghcr.io/hoovdizz/book-vault:development
rm -f /boot/config/plugins/dockerMan/templates-user/my-book-vault.xml
curl --fail --location \
  https://raw.githubusercontent.com/hoovdizz/book-vault/development/unraid/book-vault.xml \
  --output /boot/config/plugins/dockerMan/templates-user/my-book-vault.xml
```

Updating a template does not change an already-created container. Unraid keeps the existing container configuration when **Edit** is selected, even after the source template is replaced. If the Docker page still shows TCP port `3000`, fix the existing container:

1. Select the BookVault icon and choose **Edit**.
2. Find the existing Web UI port entry.
3. Change both **Container Port** and **Host Port** from `3000` to `8130`. If Unraid does not allow the container-port field to be edited, remove that port entry and add a new **Port** entry with container port `8130`, host port `8130`, and TCP protocol.
4. In advanced view, remove any `PORT=3000` variable and add or change `PORT` to `8130`.
5. Confirm the WebUI field is `http://[IP]:[PORT:8130]`.
6. Select **Apply** so Unraid recreates the container. The `/config` appdata mapping preserves the database.

Verify the published port from the terminal:

```sh
docker port book-vault
```

The result should include:

```text
8130/tcp -> 0.0.0.0:8130
```

Do not add a `--user` override: the entrypoint starts briefly as root to repair ownership of the dedicated `/config` mount and then drops to `PUID:PGID` before BookVault starts. The Unraid defaults are `99:100`, which appear on the host as `nobody:users`.

Verify the host ownership after recreating the container:

```sh
stat -c '%U:%G (%u:%g)' /mnt/user/appdata/book-vault
```

The expected result is:

```text
nobody:users (99:100)
```

The following log output is normal and confirms the application started:

```text
(node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time
BookVault listening on http://0.0.0.0:8130
```

### Database permission error

Versions before the ownership-fix entrypoint can stop with:

```text
Error: unable to open database file
```

Update the image and recreate the container using the steps above. The new entrypoint automatically makes the `/config` appdata directory writable without running the application itself as root. If the error remains, confirm that the mapping is exactly:

```text
/mnt/user/appdata/book-vault  ->  /config
```

and that `/mnt/user/appdata/book-vault` is on writable storage rather than a read-only remote share.

### GHCR package access

The image must be public for an anonymous Unraid pull. If Docker reports `unauthorized`, the package owner must perform this one-time GitHub setting:

1. Open [BookVault package settings](https://github.com/users/hoovdizz/packages/container/book-vault/settings).
2. Find **Danger Zone → Change package visibility**.
3. Select **Public** and confirm `book-vault`.
4. On Unraid, clear any stale registry session and pull again:

   ```sh
   docker logout ghcr.io 2>/dev/null || true
   docker pull ghcr.io/hoovdizz/book-vault:development
   ```

If the package must remain private, create a GitHub classic personal access token with `read:packages`, then authenticate from the Unraid terminal:

```sh
export GHCR_USER='your-github-username'
read -rsp 'GitHub package token: ' GHCR_TOKEN
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
unset GHCR_TOKEN
docker pull ghcr.io/hoovdizz/book-vault:development
```

Do not put a GitHub token directly in the command line, XML template, or container variables.

### Run from the Unraid terminal

Development is currently the published install target:

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
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD='replace-with-a-long-password' \
  ghcr.io/hoovdizz/book-vault:development
```

Use `:latest` only after the container changes have been merged into `main` and the `latest` image has been published.

## Pull main or development

Git branches:

```sh
git clone --branch main https://github.com/hoovdizz/book-vault.git
git clone --branch development https://github.com/hoovdizz/book-vault.git book-vault-development
```

Container images:

```sh
docker pull ghcr.io/hoovdizz/book-vault:latest
docker pull ghcr.io/hoovdizz/book-vault:development
```

The GitHub Actions workflow publishes `main` as `latest` and `development` as `development` after each push.

## Add users

Sign in as an administrator, open **Profile**, and use the **Users** form. New accounts may be regular users or administrators. Passwords are salted and hashed asynchronously with scrypt. Sessions use hashed server-side tokens and `HttpOnly`, `SameSite=Strict` cookies that expire after `SESSION_DAYS`.

## Local development

Requirements: Node.js 22 or newer (the server uses Node's built-in SQLite module).

```sh
npm ci
npm run dev
```

Vite serves the front end during UI development. For a production-style local run:

```sh
npm run build
npm start
```

By default this creates `data/book-vault.sqlite` and listens on `http://localhost:8130`. A new database requires `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables.

PowerShell example:

```powershell
$env:ADMIN_EMAIL = "admin@example.com"
$env:ADMIN_PASSWORD = "replace-with-a-long-password"
npm start
```

Docker Compose defaults are in [`docker-compose.yml`](docker-compose.yml):

```sh
docker compose up -d --build
```

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the shell or a local `.env` file before running Compose. Files ending in `.local` are ignored by Git; never commit credentials.

## Security

Login attempts are rate-limited, request and credential sizes are bounded, security headers and a Content Security Policy are enabled, and the service runs as a non-root container user. The publish workflow pins third-party actions to commit SHAs, audits dependencies, blocks images with fixable high/critical Trivy findings, and attaches SBOM/provenance attestations. Put BookVault behind an HTTPS reverse proxy before exposing it outside a trusted network.

Upgrading from the original authentication implementation invalidates existing login sessions; user accounts remain intact.

## Health check

`GET /api/health` returns `{"status":"ok"}` and is used by the container health check.
