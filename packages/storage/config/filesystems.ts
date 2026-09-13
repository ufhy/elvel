import { env, storage_path } from '@elvel/core'

export default {
  /** Disk used when none is named. */
  default: env('FILESYSTEM_DISK', 'local'),

  disks: {
    /** Private by default: nothing here is reachable without a route. */
    local: {
      driver: 'local',
      root: storage_path('app/private'),
      visibility: 'private'
    },

    /**
     * Served directly once `elvel storage:link` has run.
     *
     * `url` is configured rather than guessed — the framework has no way to know
     * what serves the directory.
     */
    public: {
      driver: 'local',
      root: storage_path('app/public'),
      url: `${env('APP_URL', 'http://localhost:3000')}/storage`,
      visibility: 'public'
    },

    /** In memory, for tests and for a quick look at the contract. */
    memory: { driver: 'memory', url: `${env('APP_URL', 'http://localhost:3000')}/memory` },

    /**
     * Any S3-compatible bucket — AWS, R2, MinIO, Spaces.
     *
     * Bun signs the requests itself, so there is no SDK here and `temporaryUrl`
     * needs no network.
     */
    s3: {
      driver: 's3',
      bucket: env('S3_BUCKET', ''),
      accessKeyId: env('S3_KEY', ''),
      secretAccessKey: env('S3_SECRET', ''),
      region: env('S3_REGION', 'us-east-1'),
      endpoint: env('S3_ENDPOINT', '') || undefined,
      prefix: env('S3_PREFIX', '') || undefined
    },

    /**
     * A local disk in front of a remote one.
     *
     * Reads come from the cache once it has them, so serving user uploads from
     * S3 pays the round trip once instead of on every read. A write goes to the
     * origin and drops the cached copy: a stale file served from local disk is
     * worse than the latency it saved.
     *
     * Off by default — the disk it caches has to be configured first.
     */
    cached: {
      driver: 'read-through',
      origin: env('CACHED_DISK_ORIGIN', 's3'),
      cache: env('CACHED_DISK_CACHE', 'local'),
      /** Seconds. 0 keeps a copy until a write or the size bound removes it. */
      ttl: Number(env('CACHED_DISK_TTL', 0)),
      /** Bytes the cache may hold. 0 is unbounded. */
      maxBytes: Number(env('CACHED_DISK_MAX_BYTES', 0))
    }
  },

  /** What `elvel storage:link` links. */
  links: {
    [`${storage_path('..')}/public/storage`]: storage_path('app/public')
  }
}
