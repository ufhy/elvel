import { env } from '@elysian/core'

export default {
  /** Connection used when none is named. */
  default: env('DB_CONNECTION', 'sqlite'),

  /**
   * Bun's native SQL client backs every driver here, so there is no third-party
   * database package to install.
   */
  connections: {
    sqlite: {
      driver: 'sqlite',
      database: env('DB_DATABASE', 'database/database.sqlite'),
      foreignKeys: env('DB_FOREIGN_KEYS', true)
    },

    postgres: {
      driver: 'postgres',
      url: env('DB_URL', ''),
      host: env('DB_HOST', '127.0.0.1'),
      port: Number(env('DB_PORT', 5432)),
      username: env('DB_USERNAME', 'postgres'),
      password: env('DB_PASSWORD', ''),
      database: env('DB_DATABASE', 'elysian'),
      max: Number(env('DB_POOL_MAX', 10))
    },

    mysql: {
      driver: 'mysql',
      host: env('DB_HOST', '127.0.0.1'),
      port: Number(env('DB_PORT', 3306)),
      username: env('DB_USERNAME', 'root'),
      password: env('DB_PASSWORD', ''),
      database: env('DB_DATABASE', 'elysian'),
      max: Number(env('DB_POOL_MAX', 10))
    }
  },

  /** Table that records which migrations have run. */
  migrations: 'migrations',

  /** Where the migrator looks. Defaults to `database/migrations`. */
  migrationPaths: []
}
