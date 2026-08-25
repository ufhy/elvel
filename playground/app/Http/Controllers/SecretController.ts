import { cache } from '@elvel/cache'
import { NotFoundException } from '@elvel/core'
import { db } from '@elvel/database'
import { decrypt, encrypt, encrypter } from '@elvel/encryption'
import { dispatch } from '@elvel/queue'
import { Elysia, t } from 'elysia'
import { SyncSecret } from '../../Jobs/SyncSecret.ts'
import { Article } from '../../Models/Article.ts'

/**
 * Generated with `bun run playground make:controller SecretController`, then
 * extended.
 *
 * Three places encryption reaches: a value encrypted by hand, a model column
 * encrypted at rest, and a queued job whose payload the queue cannot read.
 * Asserted by `scripts/smoke.ts` and driven over the network.
 */
export default new Elysia({ name: 'secret' })
  /** Encrypt and decrypt a value, and show what the payload looks like. */
  .post(
    '/check/secret/roundtrip',
    async ({ body }) => {
      const payload = encrypt(body.value, body.context)

      return {
        payload,
        // Versioned, URL-safe, and shorter than base64 of a JSON envelope.
        version: payload.split('.')[0],
        containsPlaintext: payload.includes(String(body.value)),
        decrypted: decrypt(payload, body.context)
      }
    },
    {
      body: t.Object({
        value: t.Union([
          t.String(),
          t.Number(),
          t.Boolean(),
          t.Object({}, { additionalProperties: true })
        ]),
        context: t.Optional(t.String())
      })
    }
  )

  /**
   * The same payload read with the wrong context.
   *
   * It fails, which is the point: a value encrypted for one purpose cannot be
   * replayed as another.
   */
  .post(
    '/check/secret/context',
    async ({ body, status }) => {
      const payload = encrypt(body.value, body.context)

      try {
        return { read: decrypt<string>(payload, body.readAs) }
      } catch (error) {
        return status(422, { refused: true, message: (error as Error).message })
      }
    },
    {
      body: t.Object({
        value: t.String(),
        context: t.String(),
        readAs: t.Optional(t.String())
      })
    }
  )

  /**
   * Read a payload made earlier.
   *
   * How a rotation is checked from outside: encrypt with one key, move it to
   * `APP_PREVIOUS_KEYS`, generate a new one, and this still reads.
   */
  .post(
    '/check/secret/read',
    async ({ body, status }) => {
      try {
        return { read: decrypt(body.payload, body.context), keys: encrypter().keyCount }
      } catch (error) {
        return status(422, { refused: true, message: (error as Error).message })
      }
    },
    { body: t.Object({ payload: t.String(), context: t.Optional(t.String()) }) }
  )

  /** A model column that is a ciphertext in the database and text on the model. */
  .post(
    '/check/secret/articles/:id',
    async ({ params, body }) => {
      const article = await Article.find(Number(params.id))
      if (!article) throw new NotFoundException(`No article [${params.id}].`)

      article.editor_note = body.note
      await article.save()

      const fresh = await Article.find(article.id)

      // What the column actually holds, read past the model so no cast runs.
      const rows = await (await db().connection()).select<{ editor_note: string | null }>(
        'select editor_note from articles where id = ?',
        [article.id]
      )
      const raw = rows[0]?.editor_note ?? null

      return {
        note: fresh?.editor_note,
        storedLooksEncrypted: raw?.startsWith('v1.') === true,
        storedContainsNote: raw?.includes(body.note) === true,
        // Encrypt what you do not need to search by: a `where` on the plaintext
        // cannot match a ciphertext.
        foundByPlaintext: await Article.query().where('editor_note', body.note).count()
      }
    },
    { body: t.Object({ note: t.String() }) }
  )

  /** A queued job whose stored payload the queue itself cannot read. */
  .post(
    '/check/secret/jobs',
    async ({ body }) => {
      const label = body.label ?? 'probe'

      await cache().forget(`secret:${label}`)
      const id = await dispatch(new SyncSecret({ token: body.token, label }))

      /**
       * Read the row the queue wrote, straight out of the table.
       *
       * Not through `pop()`: reserving a job counts as an attempt, and looking at
       * a payload should not spend one of the job's tries.
       */
      const rows = await (await db().connection()).select<{ payload: string }>(
        'select payload from jobs where id = ?',
        [id]
      )
      const payload = rows[0] ? (JSON.parse(rows[0].payload) as Record<string, unknown>) : undefined

      return {
        queued: true,
        encrypted: payload?.encrypted === true,
        payloadContainsToken: JSON.stringify(payload?.data ?? {}).includes(body.token)
      }
    },
    { body: t.Object({ token: t.String(), label: t.Optional(t.String()) }) }
  )

  /** What the worker saw once it ran. */
  .get('/check/secret/jobs/:label', async ({ params }) => ({
    token: (await cache().get<string>(`secret:${params.label}`)) ?? null
  }))

  /** Rotation: a payload written with the old key is still readable. */
  .get('/check/secret/rotation', async () => {
    const current = encrypter()

    return {
      keys: current.keyCount,
      // With no previous keys configured there is one; setting APP_PREVIOUS_KEYS
      // makes older payloads readable without rewriting them.
      note:
        current.keyCount === 1
          ? 'One key. Set APP_PREVIOUS_KEYS to keep older payloads readable after a rotation.'
          : `${current.keyCount} keys: the extra ones can still read what they wrote.`
    }
  })
