import { Factory } from '@elyvel/database'
import { User } from '../../app/Models/User.ts'

/**
 * Users for tests and seeders — rows to find, not accounts to sign in with.
 *
 * A row here has no `account` beside it, which is where better-auth keeps the
 * password and the provider, so nobody can sign in as one. That is deliberate:
 * hashing a password the way better-auth hashes it, from out here, is a copy of
 * its internals that would go quietly wrong the day it changes them.
 *
 * What this is for is everything else — a user to own an order, a list to
 * paginate, a recipient for a notification — and for `actingAs`, which needs a
 * user rather than a session:
 *
 * ```ts
 * const user = await new UserFactory().createOne()
 * await press(app).actingAs(user, (request) => request.get('/dashboard'))
 * ```
 *
 * To test signing in, register through the auth endpoints. The kit's own tests
 * show that.
 */
export class UserFactory extends Factory<User> {
  readonly model = User

  definition(index: number) {
    /**
     * Unique across runs, not merely within one.
     *
     * `email` is a unique index and the testing database is not thrown away
     * between runs — it is built once and kept, because rebuilding it every
     * time is slow. An address derived from the index alone therefore collides
     * with itself the second time `bun test` is run, which is a failure that
     * arrives a day late and looks like a broken factory.
     */
    const unique = `${index}-${crypto.randomUUID().slice(0, 8)}`

    return {
      // better-auth generates string ids; a test row needs one of its own.
      id: `factory-${unique}`,
      name: `Test Person ${index}`,
      email: `person-${unique}@example.com`,
      emailVerified: false,
      image: null
    }
  }

  /** `new UserFactory().verified().create()` — an account past the email step. */
  verified(): this {
    return this.state({ emailVerified: true })
  }
}
