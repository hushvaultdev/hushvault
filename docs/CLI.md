# HushVault CLI

Reference for the command-line client in `apps/cli` (binary names `hushvault` and `hv`). Derived from
`apps/cli/src`. HushVault is pre-release; the CLI is version `0.0.1`.

## Install (build from source)

The CLI is built from this repository. No published npm package is assumed here.

```bash
pnpm install
pnpm --filter hushvault build      # tsup -> apps/cli/dist/index.js
node apps/cli/dist/index.js --help # run it directly
# optional: pnpm --filter hushvault dev   (runs src/index.ts via tsx)
```

Requirements: Node.js >= 20. Credentials are stored with the native `keytar` module, which uses the OS keychain
(macOS Keychain, Windows Credential Vault, or libsecret on Linux). The CLI still starts if `keytar` cannot be
loaded; only `login` (and keychain-based auth) is affected, see [Authentication](#authentication).

The examples below call `hushvault`; substitute `node apps/cli/dist/index.js` (or your own alias) as needed.

## Quick start

```bash
hushvault login                       # prompts for email + password, stores a token in the OS keychain
cd my-project
hushvault init                        # links this directory; creates project/environment if missing
hushvault set DATABASE_URL "postgres://..."
hushvault run -- npm run dev          # runs with secrets injected as environment variables
```

## Commands

### `hushvault login`

Authenticate and store the token.

| Option | Description |
|--------|-------------|
| `--api-url <url>` | API URL (see [API URL](#api-url)) |
| `--email <email>` | Email; prompted if omitted. The password is always prompted and is not echoed. |

Calls `POST /api/auth/login`, stores the JWT in the OS keychain (service `hushvault`, account = your email),
and records `currentUser` and `apiUrl` in the global config file. There is no `logout` command.

### `hushvault init`

Link the current directory to a project and write `.hushvault.json`.

| Option | Description |
|--------|-------------|
| `--project <project>` | Existing project id, slug or name. Default: the project named after the current directory, created if missing. |
| `--env <env>` | Default environment id, slug or name. Default `development`; created if it does not exist. |
| `--api-url <url>` | API URL |

Creating projects and environments needs the `admin` role; with a lower role `init` only works against
existing projects/environments. An unknown `--project` fails and lists the available slugs.

### `hushvault set <name> [value]`

Create or update a secret in an environment (creates it if the name does not exist there, otherwise updates
its value).

| Option | Description |
|--------|-------------|
| `-e, --env <env>` | Environment id, slug or name (default: `defaultEnv` from `.hushvault.json`) |

- `name` must match `^[A-Za-z_][A-Za-z0-9_]*$` (checked client-side).
- **Value from stdin**: omit `value`, or pass `-`. If stdin is a terminal you are prompted (hidden input);
  if stdin is piped, it is read to the end and exactly one trailing newline is stripped:

  ```bash
  printf '%s' "$VALUE" | hushvault set API_KEY -e production
  hushvault set TLS_CERT - < cert.pem
  ```

  Prefer stdin over an argument: command-line arguments end up in shell history and the process list.
- Requires role `member` or higher. Values over 64KB are rejected by the API.
- Prints `Created NAME in <env>` or `Updated NAME in <env>`; the value is never printed.

### `hushvault get <name>`

Print a secret's resolved value (branch inheritance and computed `${NAME}` secrets applied, as in
`GET /api/environments/:id/resolved?values=true`).

| Option | Description |
|--------|-------------|
| `-e, --env <env>` | Environment id, slug or name |
| `--raw` | Print only the value, with no label and no trailing newline |

Without `--raw` the output is `NAME: value`. Exits 1 if the secret does not exist in the resolved set.

### `hushvault run [options] <command> [args...]`

Run a command with the environment's resolved secrets as environment variables.

| Option | Description |
|--------|-------------|
| `-e, --env <env>` | Environment id, slug or name |
| `--no-inherit` | Do not pass the current environment; the child gets only `PATH`, `SystemRoot`, `HOME`, `USERPROFILE` (when set) plus the secrets |

```bash
hushvault run -- pnpm dev
hushvault run -e production -- node server.js --port 3000
```

Options for `run` itself go before the command; everything after the command name is passed to it unchanged.
By default the child inherits your environment and secrets override variables with the same name. A progress
line (`Injecting N secrets from <env>`) goes to stderr. SIGINT and SIGTERM are forwarded to the child.
Computed secrets are evaluated by the API, so the child sees final values.

### `hushvault share [value]`

Create a temporary share link for a value (omit `value` or pass `-` to read stdin, as in `set`).

| Option | Default | Description |
|--------|---------|-------------|
| `--views <n>` | `1` | Max views, integer 1-100 |
| `--hours <n>` | `24` | Expiry in hours, positive; the CLI accepts up to 8760 but the API may reject expiries beyond its own maximum (7 days in current code) |

The value is encrypted on your machine with a fresh one-time AES-256-GCM key (WebCrypto) before upload. The
CLI prints `<url>#<key>`; the key is only in the URL fragment and is never sent to the server, so share the
whole link. Requires role `member` or higher. `share` does not need a `.hushvault.json`; it uses the API URL
from one if found. The API builds the `<url>` host itself, and whether a web page for opening links is
available depends on your deployment.

## Project config: `.hushvault.json`

Written by `init` in the current directory and found by walking up parent directories (like git). It contains
no secrets and is meant to be committed.

```json
{
  "apiUrl": "https://api.example.com",
  "projectId": "prj_...",
  "projectName": "my-project",
  "defaultEnv": "development",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `projectId` | yes | Project id used for all commands |
| `defaultEnv` | yes | Environment (slug) used when `-e` is not given |
| `apiUrl` | yes | API base URL for this project |
| `projectName` | no | Informational |
| `createdAt` | no | Informational |

## Environment resolution

`-e/--env`, `--env` and `defaultEnv` accept an environment **id**, **slug** or **name**. Matching tries the
id first, then the slug, then the name (slug and name case-insensitively), among the environments of the
project in `.hushvault.json`. No match fails with the list of valid slugs. `init`'s `--project` works the same
way for projects (id, then slug, then name).

## Authentication

Token lookup order:

1. `HUSHVAULT_TOKEN` environment variable. Either an API key (`hv_live_...`, from `POST /api/auth/api-keys`) or a
   JWT. Use this in CI.
2. The OS keychain entry for the user recorded by `hushvault login`.

If neither exists: `Not logged in. Run: hushvault login (or set HUSHVAULT_TOKEN)`.

**There is no plaintext fallback.** Tokens are never written to files. If the keychain or `keytar` is
unavailable (for example `libsecret` is not installed on Linux, or a headless CI box), `login` fails with an
error saying so and suggesting `HUSHVAULT_TOKEN`; other commands then report that you are not logged in unless
`HUSHVAULT_TOKEN` is set.

```bash
export HUSHVAULT_TOKEN=<api-key-from-your-dashboard-or-api>   # placeholder
hushvault run -e staging -- ./deploy.sh
```

JWTs expire after 7 days; API keys can have an optional expiry.

## API URL

Resolved in this order:

1. `--api-url` (on `login` and `init`)
2. `apiUrl` in `.hushvault.json` (used by `set`, `get`, `run`, `share`; not consulted by `login` or `init`)
3. `HUSHVAULT_API_URL`
4. `apiUrl` in the global config (saved by `login`)
5. Default `https://api.hushvault.com`

If you self-host, pass `--api-url` to `login` and `init` (or set `HUSHVAULT_API_URL`); the URL is then saved for
later runs.

**HTTPS rule:** the URL must use `https`. Plain `http` is accepted only for `localhost`, `127.0.0.1` and
`[::1]` (for `wrangler dev`, typically `http://localhost:8787`). Anything else fails with
`API URL must use https (http is only allowed for localhost)`.

## Environment variables and files

| Name | Purpose |
|------|---------|
| `HUSHVAULT_TOKEN` | API key or JWT; takes precedence over the keychain |
| `HUSHVAULT_API_URL` | API URL (see order above) |
| `HUSHVAULT_CONFIG_DIR` | Directory for the global config (default `~/.config/hushvault`) |

Global config file: `$HUSHVAULT_CONFIG_DIR/config.json`, a small JSON object with `currentUser` (your email)
and `apiUrl`. It holds no token.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Any CLI error (not logged in, no `.hushvault.json`, API error, bad input, failure to start the command) |
| child's code | `run` exits with the command's own exit code; if the child is killed by a signal, `128 + signal number` |

Errors are printed to stderr as `✗ <message>` and never include secret values. API errors are mapped to
short hints: 401 (`Authentication failed...`), 403 (needs a higher role: member+ for secrets, admin+ for
projects/environments), 409 (conflict), 400 (invalid input), 422 (computed-secret or environment-chain
error, with the API error code).

## Security notes

- Values are fetched over HTTPS; the API decrypts them server-side (see [ENCRYPTION.md](ENCRYPTION.md)) and
  returns plaintext to authorised callers. The CLI does not decrypt secrets itself.
- `run` hands secrets to the child process through its environment, so any process that can read that
  environment can see them.
- Do not pass secret values as command-line arguments when you can use stdin.
