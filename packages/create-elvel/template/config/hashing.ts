/**
 * How values are hashed.
 *
 * Passwords for sign-in are better-auth's business and do not read this. What
 * does is everything else you choose to store as a hash — an API token, an
 * invite code, a one-time secret.
 */
export default {
  /** `bcrypt` or `argon2id`. */
  driver: process.env.HASH_DRIVER ?? 'bcrypt',

  bcrypt: {
    /** Each step doubles the time. 12 is roughly 250ms on current hardware. */
    cost: Number(process.env.BCRYPT_COST ?? 12),

    /**
     * Longest accepted input, in bytes.
     *
     * bcrypt ignores everything past 72 in most implementations, so a longer
     * value is refused rather than silently truncated. Set to 0 to allow it, or
     * use argon2id, which has no such ceiling.
     */
    limit: 72
  },

  argon: {
    /** Kibibytes. This is the parameter that resists a GPU. */
    memory: Number(process.env.ARGON_MEMORY ?? 65536),
    time: Number(process.env.ARGON_TIME ?? 4)
  }
}
