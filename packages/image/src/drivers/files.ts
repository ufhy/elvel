import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Run a CLI backend through two temporary files.
 *
 * Pipes would be better and are not available: `@elysian/process` decodes a
 * command's output as UTF-8 text, which turns a PNG into replacement
 * characters, and `sips` has no stdin mode at all. Files cost two writes and a
 * read per image, and they are correct.
 *
 * The directory is per call and removed in a `finally`, so a failing command
 * leaves nothing in `/tmp`.
 */
export async function throughFiles<T>(
  bytes: Uint8Array,
  inputExtension: string,
  outputExtension: string,
  run: (input: string, output: string) => Promise<T>
): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), 'elysian-image-'))
  const input = join(directory, `in.${inputExtension}`)
  const output = join(directory, `out.${outputExtension}`)

  try {
    await writeFile(input, bytes)
    await run(input, output)

    return new Uint8Array(await readFile(output))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
