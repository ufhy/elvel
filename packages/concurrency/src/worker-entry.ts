/**
 * What a worker runs.
 *
 * Receives one task, answers with one message, and exits. Deliberately not a
 * pool of long-lived workers keeping state: a task that leaves something behind
 * would poison the next one, and the whole reason to reach for a worker is that
 * the work is big enough for the startup cost not to matter.
 *
 * Only a `{ module, export, args }` descriptor arrives here — never a function's
 * source. `WorkerDriver` refuses that in the parent, so there is no `eval` and no
 * `new Function` in this file, and nothing a caller passes can become code.
 */

declare const self: Worker

type Incoming = { base: string; module: string; export: string; args: unknown[] }

self.onmessage = async (event: MessageEvent<Incoming>) => {
  try {
    const value = await invoke(event.data)

    // `structuredClone` decides what can come back, and a value it cannot copy
    // fails here rather than as an opaque error in the parent.
    self.postMessage({ ok: true, value })
  } catch (error) {
    self.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : 'Error'
    })
  }
}

async function invoke(task: Incoming): Promise<unknown> {
  const specifier = task.module.startsWith('/')
    ? task.module
    : new URL(task.module, `file://${task.base}/`).pathname

  const module = (await import(specifier)) as Record<string, unknown>
  const fn = module[task.export]

  if (typeof fn !== 'function') {
    throw new Error(
      `[${task.module}] has no callable export [${task.export}]. ` +
        `Exports found: ${Object.keys(module).join(', ') || '(none)'}.`
    )
  }

  return (fn as (...args: unknown[]) => unknown)(...task.args)
}
