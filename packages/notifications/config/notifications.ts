export default {
  /** Connection the stored notifications live on. Undefined means the default. */
  connection: undefined,

  /**
   * Table the database channel writes to.
   *
   * Run `artisan notifications:table` and `artisan migrate` before using that
   * channel; the mail and log channels need no table.
   */
  table: 'notifications'
}
