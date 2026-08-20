# Reporting a vulnerability

**Do not open an issue.** An issue is public from the moment it is filed, which
tells everybody about the hole at the same time as the people who could fix it.

Use GitHub's private reporting instead:

**[github.com/ufhy/elvel/security/advisories/new](https://github.com/ufhy/elvel/security/advisories/new)**

It reaches the maintainers and nobody else, and it carries a private fork to
develop the fix in. If you cannot use it, email `the maintainers`.

[`SECURITY.md`](https://github.com/ufhy/elvel/blob/main/SECURITY.md) has the full
version: what is in scope, what helps a report, and which versions are supported.

## What runs on every push

- **CodeQL** with the `security-and-quality` suite. Its first run raised eighteen
  alerts; nine were real and are fixed, nine were the analyser being right about
  the shape and wrong about the context, each dismissed with that reason recorded
  on the alert.
- **`bun audit`**, as its own job. Dependabot supports Bun for version updates
  and explicitly *not* for security updates, so nothing would ever open a pull
  request to say a dependency became vulnerable — this asks the registry
  directly. High and critical fail the run.
- **Secret scanning with push protection**, so a key cannot be committed by
  accident.

Every action in the release workflow is pinned to a commit rather than a tag,
because that workflow holds permission to publish twenty-seven packages to npm.

## Two things the first CodeQL run found

Worth knowing if you are on an alpha before `1.0.0-alpha.9`.

**Session identifiers and CSRF tokens were drawn unevenly.** `Str.random` mapped
a random byte onto a 62-character alphabet with `byte % 62`, and 256 does not
divide by 62 — bytes 248–255 folded back onto `a`–`h`, making those eight letters
a quarter more likely than the other fifty-four. Fixed by rejecting the bytes
that would wrap.

**`Arr.set` could write to `Object.prototype`.** A key of `__proto__.isAdmin` did
not create a property of that name; it walked into the prototype and wrote there,
after which every object in the process answered `isAdmin`. `Arr.set` and
`Arr.forget` now refuse a `__proto__`, `constructor` or `prototype` segment.
Nothing inside the framework passed request data as a key, so nothing shipped was
exploitable — but `@elvel/support` is a published package, and somebody would.
