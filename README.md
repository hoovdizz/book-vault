# BookVault

BookVault is a self-hosted personal book-library interface packaged as one lightweight container. The web app, API, authentication, and embedded SQLite database all run together; no separate database container is required.

> The current book screens retain the original prototype's sample catalog. User accounts and sessions are persisted in SQLite. Persisting and editing the catalog is the next application-data milestone.

## Container settings

| Setting | Default | Purpose |
| --- | --- | --- |
| Container port | `3000` | Web interface and API |
| `/config` | required | Persistent SQLite database location |
| `TZ` | `America/New_York` | Container timezone |
| `ADMIN_NAME` | `BookVault Admin` | Initial admin name, used only with a new database |
| `ADMIN_EMAIL` | required | Initial admin login, used only with a new database |
| `ADMIN_PASSWORD` | required | Initial 12–128 character admin password |
| `SESSION_DAYS` | `30` | Login session lifetime |
| `DATABASE_PATH` | `/config/book-vault.sqlite` | Embedded database file |

The database uses SQLite WAL mode, similar to the embedded-database approach used by Sonarr and Radarr. Back up the complete `/config` directory, including any `-wal` and `-shm` files.

## Install on Unraid

### Template installation

1. Open **Docker** in the Unraid web interface and select **Add Container**.
2. Switch to advanced view and use this template URL:

   `https://raw.githubusercontent.com/hoovdizz/book-vault/development/unraid/book-vault.xml`

   If your Unraid version does not accept a remote template URL, copy the fields from [`unraid/book-vault.xml`](unraid/book-vault.xml) into **Add Container**.
3. Set the repository to one of:

   - Stable/main: `ghcr.io/hoovdizz/book-vault:latest`
   - Development: `ghcr.io/hoovdizz/book-vault:development`

4. Map container path `/config` to `/mnt/user/appdata/book-vault`.
5. Map container port `3000` to an available host port, normally `3000`.
6. Set a unique `ADMIN_PASSWORD` of at least twelve characters and confirm the admin email. A new installation refuses to start without both settings.
7. Apply the template, then open `http://UNRAID-IP:3000`.

The admin environment variables create the first account only when the database is empty. Changing them later does not change an existing account.

The requested human-readable defaults are in [`unraid-defaults.yaml`](unraid-defaults.yaml). Unraid itself imports XML templates, so [`unraid/book-vault.xml`](unraid/book-vault.xml) is the installable equivalent.

### Unraid terminal

Pull and run the stable image:

```sh
docker pull ghcr.io/hoovdizz/book-vault:latest
docker run -d \
  --name book-vault \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /mnt/user/appdata/book-vault:/config \
  -e TZ=America/New_York \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD='replace-with-a-long-password' \
  ghcr.io/hoovdizz/book-vault:latest
```

To follow development instead, replace both occurrences of `:latest` with `:development`.

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

By default this creates `data/book-vault.sqlite` and listens on `http://localhost:3000`. A new database requires `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables.

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
