---
layout: home

hero:
  name: Elvel
  text: Laravel's shape, on Bun
  tagline: >-
    Twenty-seven packages, an Elysia core, and no facades — because TypeScript
    erases the types that facades depend on.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started/installation
    - theme: alt
      text: The 29 packages
      link: /architecture/packages
    - theme: alt
      text: GitHub
      link: https://github.com/ufhy/elvel

features:
  - title: One command, no ejecting
    details: >-
      bun create elvel writes an application that is yours — controllers you can
      read, pages that are .tsx files, and a welcome screen you will replace.
    link: /getting-started/installation
  - title: A kit that installs only what it uses
    details: >-
      --kit=none gets thirteen packages and ten config files; --kit=jsx gets
      twenty and seventeen. A feature you do not use is not in your node_modules.
    link: /getting-started/starter-kits
  - title: Typed all the way through
    details: >-
      Controllers are Elysia instances, so the request context stays inferred
      inside handlers. The container resolves by token, which is what keeps it.
    link: /architecture/packages
  - title: Tested against real servers
    details: >-
      SQLite, Postgres and MySQL on every push — because a grammar can be
      plausible and still be rejected — and the whole suite on macOS and Windows
      besides.
    link: /contributing/working-on-elvel
---

## Alpha, and what that means

`1.0.0-alpha.13` is published with provenance, released by CI over OIDC with no
token stored anywhere. The shape is settled; the surface still moves, and a
release can rename something.

All twenty-nine packages have a page now — the eight that were missing one
arrived over the alphas, which is why this paragraph used to say otherwise. A page
still appears only when it has something true to say: fifty placeholders would
make this site look finished and be useless.

Three things are worth knowing before you depend on this, and none of them is a
missing feature:

- **The packages ship TypeScript source**, so your `tsc` compiles their internals.
  That makes the types exact and it makes our problems yours — `@elvel/mail` once
  imported an untyped subpath and applications failed their own typecheck while
  ours passed. Building each package to a single file would end that class of bug;
  measured, it also made boot 35–40% *slower*, so it is not done.
- **Each alpha has fixed bugs in paths nothing had executed** — a sign-out button
  that was a 419, a scaffolded application that failed its own typecheck, a diff
  that skipped the index it existed to add. That pattern has not stopped, which is
  the honest reason the version still says alpha.
- **Nothing here has run in production.** The suite covers SQLite, Postgres and
  MySQL against real servers, both caches, the queue drivers, and a smoke run that
  drives a real application over a socket. None of that is a year of somebody
  else's traffic.
