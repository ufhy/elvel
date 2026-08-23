# Security headers

Every response carries them, from an empty config:

| header | value | what it costs an attacker |
| --- | --- | --- |
| `Content-Security-Policy` | `'self'` for everything, `'none'` for objects and framing | an injected script has nowhere to load from and no way to run inline |
| `X-Content-Type-Options` | `nosniff` | an uploaded file cannot be re-interpreted as a script |
| `X-Frame-Options` | `DENY` | your page cannot be framed and clicked through |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | a URL with a token in it stops travelling to other sites |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | features you never asked for cannot be asked for |
| `Cross-Origin-Opener-Policy` | `same-origin` | a page you link to cannot reach back through `window.opener` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | one plain-HTTP request cannot be intercepted |

Change any of it in `config/security.ts`, and `false` turns one off:

```ts
export default {
  frameOptions: 'SAMEORIGIN',
  referrerPolicy: false,
  csp: { directives: { 'img-src': ["'self'", 'https://cdn.example.com'] } }
}
```

Only the directives you name are replaced; the rest keep their defaults.
`enabled: false` sends none of it, for an application behind something that
already does.

## HSTS waits for production

A browser ignores it over plain HTTP, so sending it in development buys nothing —
except on `localhost`, where it is remembered **per host** and outlives the project
that sent it. `preload: true` submits the domain to a list browsers ship and is
close to permanent; turn it on when the domain is certain.

## An inline script needs the request's nonce

`script-src` allows no inline script, because allowing inline scripts is allowing
the injected one. What a page genuinely needs that early — deciding a theme before
the first paint, so a reader who chose dark does not get a white flash — carries
the nonce instead:

```tsx
import { cspNonce } from '@elvel/http'

<script nonce={cspNonce()}>{theme}</script>
```

A fresh 16 random bytes per response, named in that response's policy. An injected
script cannot guess it, and a leaked one is worth nothing on the next request.
`cspNonce()` reads the request scope rather than a prop, for the reason `errors()`
does: a script three components deep still has to carry it.

With the policy off it returns an empty string, so the attribute is inert rather
than wrong — a page written this way works either way.

Inline **styles** are allowed. A view is allowed to carry its own, for the reason
Laravel's `welcome.blade.php` does: a stylesheet request before the first paint is
a flash of unstyled text.

## The dev server is part of the policy

While Vite is running, its origin is added to `script-src`, `style-src` and
`font-src`, and its socket — `ws:` as well as `http:` — to `connect-src`. Read from
the hot file per response, so it appears when `elvel dev` starts Vite and vanishes
when it stops.

Without it the policy that is correct in production blocks every module in
development, which is how a policy ends up disabled locally and first tested by the
deploy.

## Naming what your application actually loads

A policy is only worth having if what the page loads is written down. The jsx kit
is the example, because it loads a typeface from another origin:

```ts
csp: {
  directives: {
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.bunny.net'],
    'font-src': ["'self'", 'data:', 'https://fonts.bunny.net']
  }
}
```

Measured without it, in a browser: `Loading the stylesheet
'https://fonts.bunny.net/css?family=instrument-sans' violates the following
Content Security Policy directive: "style-src 'self'"`. The page rendered in a
fallback font and nothing on it said why — which is the failure mode to expect, and
why the next section exists.

## Introducing a policy to an application that already exists

```ts
csp: { reportOnly: true }
```

The browser reports what the policy *would* have blocked and blocks nothing, under
`Content-Security-Policy-Report-Only`. Turning a strict policy on blind gives you a
page that renders without its JavaScript, which is worse than no policy at all.

## Which responses carry them

All three paths a response can leave by.

A **handler's**, through `mapResponse`. The **exception handler's**, through
`request.lifecycle` — which matters because a client-routed application answers
most of its addresses there, and a page with no policy is exactly the page an
injected script wants. And a **static file's**, which took a different fix.

The static plugin's routes skip the surrounding lifecycle, measured in both
`alwaysStatic` modes: a header set globally never reaches a served file. So
`@elvel/view` answers every static file it can resolve itself — it already did that
for compressible ones — and reads the headers from the container, since it does not
depend on `@elvel/http`. What still falls through to the static plugin is a range
request and a path that is not a file.

That change brought conditional requests with it. `@elysiajs/static` sets an `ETag`
and then ignores `If-None-Match`: measured on a built application, a conditional
request for an 81 kB script came back 200 with all 81,048 bytes. An image now
answers 304 with no body.

A path with no extension is never stat'd — every address a client router owns
arrives here, and none of them is a file.
