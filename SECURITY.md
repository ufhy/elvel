# Security

Elvel is at `1.0.0-alpha`. It is published so it can be tried, and it should not
be holding anybody's production data yet. That said, a report is welcome now
rather than later, and this is how to make one.

## Reporting a vulnerability

**Do not open an issue.** An issue is public from the moment it is filed, which
tells everybody about the hole at the same time as the people who could fix it.

Use GitHub's private reporting instead:

**https://github.com/ufhy/elvel/security/advisories/new**

It goes to the maintainers, nowhere else, and it carries a private fork to
develop the fix in.

What helps, in rough order of how much:

- The version — `bun pm ls | grep @elvel`, or the tag you installed
- Which package: the twenty-seven ship separately and a hole in `@elvel/view`
  is a different problem from one in `@elvel/auth`
- Something that reproduces it. A failing test, or `bunx create-elvel` plus the
  handful of lines that show it, beats a description
- What an attacker gets. "Renders unescaped" and "renders unescaped, so here is
  a cookie steal" are triaged differently

You will get an acknowledgement within a few days. If a report is right, you
will be credited in the advisory unless you would rather not be.

## What is in scope

The twenty-seven `@elvel/*` packages, `create-elvel`, and the application
`create-elvel` scaffolds. The scaffold matters as much as the framework: it is
what most people will actually run, and a default that is unsafe is a hole in
every application that accepted the default.

Particularly wanted:

- Escaping. `@elvel/view` renders JSX to a string, and anything that gets past
  `safe` is serious
- The session, the cookie, the encrypter, CSRF, and the signed-URL machinery
- The query builder, wherever a value reaches SQL without becoming a parameter
- Path handling in the router, the file store and the uploaded-file API
- Anything in the auth kit that lets one person hold another's session

## What is not

- A dependency's advisory with no route through Elvel to reach it — report those
  upstream; `bun audit` runs in CI and we watch it
- Denial of service from an absurd input, unless a request an ordinary client
  could send does it
- Missing hardening with no exploit behind it. Say it anyway, as an issue; it is
  worth fixing, it is just not an advisory

## Supported versions

| Version   | Supported |
| --------- | --------- |
| `1.0.0-alpha.x` | The most recent alpha only |

There is no back-porting during alpha. A fix lands in the next release, and the
release notes name it.
