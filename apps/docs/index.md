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
      text: The 27 packages
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
      --kit=none gets twelve packages and nine config files; --kit=auth gets
      nineteen and sixteen. A feature you do not use is not in your node_modules.
    link: /getting-started/starter-kits
  - title: Typed all the way through
    details: >-
      Controllers are Elysia instances, so the request context stays inferred
      inside handlers. The container resolves by token, which is what keeps it.
    link: /architecture/packages
  - title: Tested against real servers
    details: >-
      SQLite, Postgres and MySQL on every push, on Linux, macOS and Windows —
      because a grammar can be plausible and still be rejected.
    link: /contributing/working-on-elvel
---

## Alpha, and what that means

`1.0.0-alpha.9` is published with provenance, released by CI over OIDC with no
token stored anywhere. The shape is settled; the surface still moves, and a
release can rename something.

What is **not** in these pages yet is most of it. Twelve of the twenty-seven
packages are documented here; the other fifteen — mail, storage,
scheduler, notifications, console, view, testing, broadcasting, concurrency,
image, process, http-client, hashing, translation and collections — have working
code, tests against real servers, and no page. They arrive one at a time.

A page appears in the sidebar when it has something true to say. Fifty
placeholders would make this site look finished and be useless.
