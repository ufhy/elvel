import { controller } from '@elysian/core'
import { Rule, ValidationError, validator } from '@elysian/validation'
import { t } from 'elysia'

/**
 * Exercise surface for the two-phase validation story, asserted by
 * `scripts/smoke.ts`.
 *
 * Phase one is the Elysia `body` schema below: TypeBox checks shape and type
 * synchronously before the handler runs, and it is also what produces the
 * OpenAPI document. Phase two is `validator()`, which handles everything TypeBox
 * cannot express — cross-field rules, and anything that must read the database.
 */
export default controller('check', '/check')
  .post(
    '/register',
    async ({ body, status }) => {
      const check = validator(body as Record<string, unknown>, {
        // Phase one already proved these are strings; phase two states the rules.
        name: 'required|string|min:2',
        email: 'required|email',
        password: 'required|min:8|confirmed',
        role: 'required|in:admin,member',
        // Only required when the role says so — TypeBox cannot express this.
        team: 'required_if:role,admin'
      })

      try {
        return { validated: await check.validate() }
      } catch (error) {
        if (error instanceof ValidationError) {
          return status(422, { message: 'Validation failed.', errors: error.errors.messages() })
        }

        throw error
      }
    },
    {
      // Phase one: shape and types, checked before the handler is entered.
      body: t.Object({
        name: t.String(),
        email: t.String(),
        password: t.String(),
        password_confirmation: t.Optional(t.String()),
        role: t.String(),
        team: t.Optional(t.String())
      })
    }
  )

  /** An excluded attribute never reaches `validated()`. */
  .post(
    '/payment',
    async ({ body }) => {
      const check = validator(body as Record<string, unknown>, {
        kind: 'required|in:card,cash',
        card_number: 'exclude_if:kind,cash|required|digits:16'
      })

      return { passed: await check.passes(), validated: check.validated() }
    },
    { body: t.Object({ kind: t.String(), card_number: t.Optional(t.String()) }) }
  )

  /** `unique` reaching the real database through the presence verifier. */
  .get('/unique', async () => {
    const check = validator(
      { table_name: 'migrations' },
      { table_name: [Rule.unique('migrations', 'migration')] }
    )

    return { passes: await check.passes() }
  })
