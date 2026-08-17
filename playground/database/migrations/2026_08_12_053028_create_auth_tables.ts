import { Migration, type MigrationContext } from '@elvel/database'

/**
 * Auth tables, generated from better-auth's schema by `artisan auth:schema`.
 *
 * The column names are better-auth's own (`emailVerified`, `userId`): every
 * plugin declares its fields that way, so renaming them here would break the
 * first plugin added. Application tables keep their own convention.
 *
 * Regenerate after adding a better-auth plugin; generated for sqlite.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    await schema.create('user', (table) => {
      table.string('id').primary()
      table.string('name')
      table.string('email').unique()
      table.boolean('emailVerified')
      table.text('image').nullable()
      table.timestamp('createdAt')
      table.timestamp('updatedAt')
    })

    await schema.create('session', (table) => {
      table.string('id').primary()
      table.timestamp('expiresAt')
      table.text('token').unique()
      table.timestamp('createdAt')
      table.timestamp('updatedAt')
      table.text('ipAddress').nullable()
      table.text('userAgent').nullable()
      table.string('userId').index()
      table.foreign(['userId']).references(['id']).on('user').onDelete('cascade')
    })

    await schema.create('account', (table) => {
      table.string('id').primary()
      table.text('accountId')
      table.text('providerId')
      table.string('userId').index()
      table.text('accessToken').nullable()
      table.text('refreshToken').nullable()
      table.text('idToken').nullable()
      table.timestamp('accessTokenExpiresAt').nullable()
      table.timestamp('refreshTokenExpiresAt').nullable()
      table.text('scope').nullable()
      table.text('password').nullable()
      table.timestamp('createdAt')
      table.timestamp('updatedAt')
      table.foreign(['userId']).references(['id']).on('user').onDelete('cascade')
    })

    await schema.create('verification', (table) => {
      table.string('id').primary()
      table.text('identifier').index()
      table.text('value')
      table.timestamp('expiresAt')
      table.timestamp('createdAt')
      table.timestamp('updatedAt')
    })
  }

  async down({ schema }: MigrationContext): Promise<void> {
    await schema.dropIfExists('verification')
    await schema.dropIfExists('account')
    await schema.dropIfExists('session')
    await schema.dropIfExists('user')
  }
}
