export default {
  /** Connection the stored notifications live on. Undefined means the default. */
  connection: undefined,

  /**
   * Table the database channel writes to.
   *
   * Run `elvel notifications:table` and `elvel migrate` before using that
   * channel; the mail and log channels need no table.
   */
  table: 'notifications'
}
