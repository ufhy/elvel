# Environment variables

Every variable the template ships, what reads it, and what it does when you
leave it alone. [Configuration](/getting-started/configuration) covers the
mechanism — `Env`, the `config/` directory, dot notation. This is the list.

Two rules run through all of it. A variable is only read by the config file that
names it, so a variable no `config/*.ts` mentions does nothing — a template test
holds those two files together. And `Env` treats an empty value as absent, so
`DB_PASSWORD=` and a missing `DB_PASSWORD` behave the same way.

## Application

| Variable | Default | |
| --- | --- | --- |
| `APP_NAME` | `Elvel` | Used in mail subjects and the default `from` name |
| `APP_ENV` | `local` | `production` turns on the auth rate limit and turns off debug pages |
| `APP_DEBUG` | `true` | Stack traces in responses. **Never true in production** |
| `APP_URL` | `http://localhost:3000` | Absolute URLs, signed links, trusted origins |
| `APP_TIMEZONE` | `UTC` | |
| `APP_KEY` | *(empty)* | Signs cookies and encrypts. `elvel key:generate` writes it |
| `APP_PREVIOUS_KEYS` | *(empty)* | Comma-separated retired keys, still able to read what they wrote |
| `PORT` | `3000` | |
| `HOST` | *(empty)* | Empty binds every interface |

`APP_KEY` ships empty on purpose: a default in the framework's own repository
would be a shared secret. Boot fails loudly instead.

## Database

Read only once `@elvel/database` is registered in `bootstrap/providers.ts`.

| Variable | Default | |
| --- | --- | --- |
| `DB_CONNECTION` | `sqlite` | `sqlite`, `postgres` or `mysql` |
| `DB_URL` | *(empty)* | A full DSN, which wins over the host/port pieces |
| `DB_DATABASE` | `database/database.sqlite` | A path for sqlite; a name otherwise |
| `DB_HOST` | `127.0.0.1` | |
| `DB_PORT` | `5432` postgres, `3306` mysql | Each connection carries its own default |
| `DB_USERNAME` | `postgres` / `root` | Per connection, as above |
| `DB_PASSWORD` | *(empty)* | |
| `DB_POOL_MAX` | `10` | Connections per pool |
| `DB_CONNECT_TIMEOUT` | `30` | Seconds |
| `DB_FOREIGN_KEYS` | `true` | sqlite only, where they are off unless asked for |
| `DB_READ_HOST` / `DB_WRITE_HOST` | `127.0.0.1` | Split reads and writes |

## Session and CSRF

| Variable | Default | |
| --- | --- | --- |
| `SESSION_ENABLED` | `true` | Off leaves cookies and CSRF without a session |
| `SESSION_DRIVER` | `file` | `memory`, `file`, `database`, `redis` or `cache` |
| `SESSION_COOKIE` | `elvel_session` | |
| `SESSION_LIFETIME` | `7200` | Seconds |
| `SESSION_SAME_SITE` | `lax` | Or `strict` |
| `SESSION_SECURE` | *(unset)* | Unset means on in production |
| `SESSION_ENCRYPT` | `false` | Encrypt the cookie, not only sign it. Needs `@elvel/encryption` |
| `SESSION_TABLE` | `sessions` | The `database` driver's table |
| `SESSION_STORE` | *(empty)* | Cache store for the `redis`/`cache` drivers |
| `SESSION_CSRF` | `true` | |

## Cache, queue and Redis

| Variable | Default | |
| --- | --- | --- |
| `CACHE_STORE` | `file` | `array`, `file`, `database` or `redis` |
| `CACHE_PREFIX` | `elvel_cache_` | Keeps two applications on one Redis apart |
| `CACHE_MEMORY` | `0` | Seconds a value may be served from this process without rereading the store. `0` is off, and is right for counters |
| `CACHE_LIMITER` | `array` | Store the rate limiter counts in |
| `QUEUE_CONNECTION` | `sync` | `sync`, `database` or `redis` |
| `QUEUE_FAILED_DRIVER` | `null` | `database` to keep failed jobs |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Read by the redis cache store and queue only |

## Mail

| Variable | Default | |
| --- | --- | --- |
| `MAIL_MAILER` | `log` | `log`, `array`, `smtp`, `resend` or `failover` |
| `MAIL_FROM_ADDRESS` | `hello@example.com` | |
| `MAIL_FROM_NAME` | *(the app name)* | |
| `MAIL_ALWAYS_TO` | *(empty)* | Redirect every message here — for a staging box |
| `MAIL_HOST` | `127.0.0.1` | |
| `MAIL_PORT` | `1025` | Mailpit's default |
| `MAIL_USERNAME` / `MAIL_PASSWORD` | *(empty)* | |
| `MAIL_ALLOW_SELF_SIGNED` | `false` | For a local SMTP box with its own certificate |
| `RESEND_KEY` | *(empty)* | The `resend` mailer |

## Storage

| Variable | Default | |
| --- | --- | --- |
| `FILESYSTEM_DISK` | `local` | |
| `S3_BUCKET` | *(empty)* | |
| `S3_KEY` / `S3_SECRET` | *(empty)* | |
| `S3_REGION` | `us-east-1` | |
| `S3_ENDPOINT` | *(empty)* | Set it for R2, MinIO or Spaces |
| `S3_PREFIX` | *(empty)* | Share one bucket between applications |

## Auth

| Variable | Default | |
| --- | --- | --- |
| `AUTH_SECRET` | *(empty)* | Signs better-auth's tokens. **Never reuse `APP_KEY`** |
| `AUTH_MOUNT` | `true` | Off leaves the Gate without the endpoints |

Empty is worse than wrong here — better-auth signs with an empty string and says
nothing — so `elvel auth:secret` generates one rather than a default being
shipped.

## HTTP, CORS and security headers

| Variable | Default | |
| --- | --- | --- |
| `TRUSTED_PROXIES` | *(empty)* | Comma-separated. Empty trusts none |
| `HTTP_CHECK_PORT` | `true` | Refuse to start on a port somebody else holds |
| `CORS_ORIGINS` | `*` | Comma-separated. Name them before turning credentials on |
| `CORS_CREDENTIALS` | `false` | |
| `SECURITY_HEADERS` | `true` | |
| `SECURITY_CSP_REPORT_ONLY` | `false` | Report violations without enforcing |

`TRUSTED_PROXIES` decides whether `X-Forwarded-*` is believed, which the auth
rate limit depends on — see
[the address it counts](/security/authentication#the-address-it-counts-and-why-it-is-not-x-forwarded-for).
**Name both loopback forms if that is where your proxy sits:** `127.0.0.1` does
not cover `::1`.

## Logging

| Variable | Default | |
| --- | --- | --- |
| `LOG_CHANNEL` | `stack` | |
| `LOG_LEVEL` | `debug` | `info` on the production channel |
| `LOG_REQUESTS` | `false` | One line per request |

## Your own

`config/services.ts` is where third-party credentials go, so they are read once
at boot and reachable by name rather than through `process.env` at the call site:

```ts
// config/services.ts
export default {
  stripe: {
    key: env('STRIPE_KEY', ''),
    secret: env('STRIPE_SECRET', ''),
    webhookSecret: env('STRIPE_WEBHOOK_SECRET', '')
  }
}
```

```ts
config('services.stripe.key')
```
