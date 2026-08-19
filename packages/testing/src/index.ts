/**
 * Testing — pressing the application without a socket.
 *
 * ```ts
 * import { test } from '@elvel/testing'
 *
 * const response = await test(app).getJson('/posts')
 *
 * response.assertOk().assertJsonFluent((json) => {
 *   json.has('data', 3, (data) => data.each((post) => post.hasAll('id', 'title')))
 *     .etc()
 * })
 * ```
 *
 * Nothing here knows about a test runner. Assertions throw `AssertionError`,
 * which every runner reports as a failure, and which `scripts/smoke.ts` can use
 * under plain `bun`.
 */
export {
  AssertionError,
  assert,
  contains,
  dataGet,
  dataHas,
  equals,
  fail,
  show
} from './assert.ts'
export { PendingCommand, type Runnable } from './console.ts'
export { AssertableJson, matchesStructure } from './json.ts'
export { type Method, type Pressable, TestRequest, test } from './request.ts'
export { type ResponseCookie, TestResponse } from './response.ts'

import { PendingCommand, type Runnable } from './console.ts'

/**
 * An elvel command under test.
 *
 * `outputPrototype` is `Output.prototype`, passed by the caller because this
 * package must not depend on `@elvel/console`:
 *
 * ```ts
 * import { Output } from '@elvel/console'
 *
 * await elvel(kernel, ['make:model', 'Post'], Output.prototype)
 *   .expectsConfirmation('Overwrite', true)
 *   .run()
 * ```
 *
 * Omit it and the command runs, but a prompt will reach for a stdin that is not
 * there — so omit it only for commands that do not ask anything.
 */
export function elvel(
  kernel: Runnable,
  argv: string[],
  outputPrototype?: Record<string, unknown>
): PendingCommand {
  return new PendingCommand(kernel, argv, outputPrototype as never)
}
