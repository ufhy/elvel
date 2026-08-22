/**
 * The language server for this workspace, run by the workspace's own TypeScript.
 *
 * The official `typescript-lsp` plugin shells out to `typescript-language-server`,
 * which drives `tsserver` from whichever `typescript` it can find — on this machine
 * a global 5.9. This repository pins `typescript@^7.0.2`, whose compiler is a native
 * binary with no `tsserver.js` at all, so that server cannot start here and would
 * report a different compiler's diagnostics if it could.
 *
 * TypeScript 7 ships its own language server inside that binary. `--lsp` needs a
 * transport chosen explicitly: with neither flag it exits with `only stdio is
 * supported`, which reads like a reassurance and is actually the error. `-stdio` is
 * the flag that answers.
 *
 * A launcher exists because `.lsp.json` cannot name the binary: it lives under a
 * platform-specific package (`@typescript/typescript-<platform>-<arch>`) whose path
 * also carries the exact version, so any literal path would be wrong on a
 * teammate's machine and stale after the next bump. Resolving it here is the same
 * walk `typescript/lib/getExePath.js` does — that file is outside the package's
 * `exports`, so it cannot simply be imported.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The workspace root: the plugin lives at `<root>/.claude/skills/typescript-lsp`. */
const root = join(import.meta.dir, '..', '..', '..')

/**
 * Resolution starts from the workspace, not from this file.
 *
 * `import.meta.resolve` would look beside the plugin directory, which has no
 * `node_modules` of its own. Anchoring the require at the root's `package.json` is
 * what makes the answer the version the workspace actually compiles with.
 */
const require = createRequire(join(root, 'package.json'))
const pkg = dirname(require.resolve('typescript/package.json'))

const platform = `typescript-${process.platform}-${process.arch}`
const suffix = process.platform === 'win32' ? '.exe' : ''
const exe = join(pkg, '..', '@typescript', platform, 'lib', `tsc${suffix}`)

/**
 * The three streams are inherited rather than piped.
 *
 * Claude Code speaks LSP over this process's stdin and stdout, so anything that
 * copied bytes through here would only add a place for them to be buffered or
 * reordered. Inheriting hands the client's pipes straight to the compiler.
 */
const child = Bun.spawn([exe, '--lsp', '-stdio'], {
  cwd: root,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit'
})

process.exit(await child.exited)
