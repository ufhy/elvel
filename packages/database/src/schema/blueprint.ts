export type ColumnType =
  | 'bigInteger'
  | 'integer'
  | 'mediumInteger'
  | 'smallInteger'
  | 'tinyInteger'
  | 'boolean'
  | 'string'
  | 'char'
  | 'text'
  | 'mediumText'
  | 'longText'
  | 'decimal'
  | 'float'
  | 'double'
  | 'date'
  | 'dateTime'
  | 'time'
  | 'timestamp'
  | 'json'
  | 'jsonb'
  | 'uuid'
  | 'binary'
  | 'enum'
  | 'vector'
  | 'tinyText'
  | 'ulid'
  | 'year'
  | 'ipAddress'
  | 'macAddress'
  | 'dateTimeTz'
  | 'timeTz'
  | 'timestampTz'

export type ColumnAttributes = {
  name: string
  type: ColumnType
  length?: number
  total?: number
  places?: number
  allowed?: string[]
  autoIncrement?: boolean
  unsigned?: boolean
  nullable?: boolean
  default?: unknown
  useCurrent?: boolean
  useCurrentOnUpdate?: boolean
  comment?: string
  after?: string
  first?: boolean
  collation?: string
  /** Set by `change()`: alter this column rather than add it. */
  change?: boolean
}

export type ForeignKeyAction =
  | 'cascade'
  | 'restrict'
  | 'set null'
  | 'no action'
  | 'set default'
  | undefined

export type Command =
  | { name: 'create' }
  | { name: 'add' }
  | { name: 'primary'; columns: string[]; index?: string }
  | { name: 'unique'; columns: string[]; index: string }
  | { name: 'index'; columns: string[]; index: string }
  | { name: 'fullText'; columns: string[]; index: string }
  | { name: 'dropFullText'; index: string }
  | { name: 'renameIndex'; from: string; to: string }
  | {
      name: 'foreign'
      columns: string[]
      index: string
      on: string
      references: string[]
      onDelete?: ForeignKeyAction
      onUpdate?: ForeignKeyAction
    }
  | { name: 'dropColumn'; columns: string[] }
  | { name: 'dropIndex'; index: string }
  | { name: 'dropUnique'; index: string }
  | { name: 'dropPrimary'; index?: string }
  | { name: 'dropForeign'; index: string }
  | { name: 'renameColumn'; from: string; to: string }
  | { name: 'rename'; to: string }
  | { name: 'drop' }
  | { name: 'dropIfExists' }

/**
 * A single column, returned so modifiers can be chained:
 * `table.string('email').nullable().unique()`.
 */
export class ColumnDefinition {
  constructor(
    readonly attributes: ColumnAttributes,
    private readonly blueprint: Blueprint
  ) {}

  /**
   * Modify this column instead of adding it — Laravel's `->change()`.
   *
   * The definition is read as a **replacement**, not a patch: everything the
   * column should still be has to be restated. `string('email').nullable()`
   * followed by `string('email').change()` makes it NOT NULL again, because that
   * is what the new definition says. Laravel behaves the same way, and the
   * alternative — merging with whatever is already there — means a migration
   * whose result depends on the database it is run against.
   */
  change(): this {
    this.attributes.change = true

    return this
  }

  nullable(value = true): this {
    this.attributes.nullable = value
    return this
  }

  default(value: unknown): this {
    this.attributes.default = value
    return this
  }

  unsigned(): this {
    this.attributes.unsigned = true
    return this
  }

  autoIncrement(): this {
    this.attributes.autoIncrement = true
    this.attributes.unsigned = true
    return this
  }

  useCurrent(): this {
    this.attributes.useCurrent = true
    return this
  }

  useCurrentOnUpdate(): this {
    this.attributes.useCurrentOnUpdate = true
    return this
  }

  comment(text: string): this {
    this.attributes.comment = text
    return this
  }

  after(column: string): this {
    this.attributes.after = column
    return this
  }

  first(): this {
    this.attributes.first = true
    return this
  }

  collation(name: string): this {
    this.attributes.collation = name
    return this
  }

  primary(): this {
    this.blueprint.primary([this.attributes.name])
    return this
  }

  unique(name?: string): this {
    this.blueprint.unique([this.attributes.name], name)
    return this
  }

  index(name?: string): this {
    this.blueprint.index([this.attributes.name], name)
    return this
  }

  /**
   * Add the foreign key implied by the column name: `user_id` references `id`
   * on `users`. Laravel's `constrained()`.
   */
  constrained(table?: string, column = 'id'): ForeignKeyDefinition {
    const inferred = table ?? `${this.attributes.name.replace(/_id$/, '')}s`

    return this.blueprint.foreign([this.attributes.name]).references([column]).on(inferred)
  }
}

/** Chainable `on delete` / `on update` behaviour. */
export class ForeignKeyDefinition {
  constructor(private readonly command: Extract<Command, { name: 'foreign' }>) {}

  references(columns: string[]): this {
    this.command.references = columns
    return this
  }

  on(table: string): this {
    this.command.on = table
    return this
  }

  onDelete(action: ForeignKeyAction): this {
    this.command.onDelete = action
    return this
  }

  onUpdate(action: ForeignKeyAction): this {
    this.command.onUpdate = action
    return this
  }

  cascadeOnDelete(): this {
    return this.onDelete('cascade')
  }

  restrictOnDelete(): this {
    return this.onDelete('restrict')
  }

  nullOnDelete(): this {
    return this.onDelete('set null')
  }

  cascadeOnUpdate(): this {
    return this.onUpdate('cascade')
  }
}

/**
 * Describes a table change. The grammar turns it into SQL, so a blueprint knows
 * nothing about any particular dialect.
 */
export class Blueprint {
  readonly columns: ColumnDefinition[] = []
  readonly commands: Command[] = []
  temporary = false

  constructor(readonly table: string) {}

  /** True when this blueprint creates the table rather than altering it. */
  get creating(): boolean {
    return this.commands.some((command) => command.name === 'create')
  }

  create(): this {
    this.commands.unshift({ name: 'create' })
    return this
  }

  // ---------------------------------------------------------------- integers

  /** `id()` — the conventional auto-incrementing primary key. */
  id(name = 'id'): ColumnDefinition {
    return this.bigIncrements(name)
  }

  bigIncrements(name: string): ColumnDefinition {
    return this.addColumn('bigInteger', name).autoIncrement()
  }

  increments(name: string): ColumnDefinition {
    return this.addColumn('integer', name).autoIncrement()
  }

  bigInteger(name: string): ColumnDefinition {
    return this.addColumn('bigInteger', name)
  }

  integer(name: string): ColumnDefinition {
    return this.addColumn('integer', name)
  }

  mediumInteger(name: string): ColumnDefinition {
    return this.addColumn('mediumInteger', name)
  }

  smallInteger(name: string): ColumnDefinition {
    return this.addColumn('smallInteger', name)
  }

  tinyInteger(name: string): ColumnDefinition {
    return this.addColumn('tinyInteger', name)
  }

  unsignedBigInteger(name: string): ColumnDefinition {
    return this.bigInteger(name).unsigned()
  }

  unsignedInteger(name: string): ColumnDefinition {
    return this.integer(name).unsigned()
  }

  boolean(name: string): ColumnDefinition {
    return this.addColumn('boolean', name)
  }

  // ----------------------------------------------------------------- strings

  string(name: string, length = 255): ColumnDefinition {
    return this.addColumn('string', name, { length })
  }

  char(name: string, length = 255): ColumnDefinition {
    return this.addColumn('char', name, { length })
  }

  text(name: string): ColumnDefinition {
    return this.addColumn('text', name)
  }

  mediumText(name: string): ColumnDefinition {
    return this.addColumn('mediumText', name)
  }

  longText(name: string): ColumnDefinition {
    return this.addColumn('longText', name)
  }

  enum(name: string, allowed: string[]): ColumnDefinition {
    return this.addColumn('enum', name, { allowed })
  }

  /**
   * A pgvector column — `table.vector('embedding', 1536)`.
   *
   * The dimension is required and fixed, because pgvector's indexes are built
   * for one: a column that accepts any length cannot be indexed, and an
   * unindexed similarity search reads the whole table.
   */
  vector(name: string, dimensions: number): ColumnDefinition {
    return this.addColumn('vector', name, { length: dimensions })
  }

  uuid(name = 'uuid'): ColumnDefinition {
    return this.addColumn('uuid', name)
  }

  binary(name: string): ColumnDefinition {
    return this.addColumn('binary', name)
  }

  json(name: string): ColumnDefinition {
    return this.addColumn('json', name)
  }

  jsonb(name: string): ColumnDefinition {
    return this.addColumn('jsonb', name)
  }

  // ------------------------------------------------------------------ numbers

  decimal(name: string, total = 8, places = 2): ColumnDefinition {
    return this.addColumn('decimal', name, { total, places })
  }

  float(name: string, total = 8, places = 2): ColumnDefinition {
    return this.addColumn('float', name, { total, places })
  }

  double(name: string): ColumnDefinition {
    return this.addColumn('double', name)
  }

  // -------------------------------------------------------------------- dates

  date(name: string): ColumnDefinition {
    return this.addColumn('date', name)
  }

  dateTime(name: string): ColumnDefinition {
    return this.addColumn('dateTime', name)
  }

  time(name: string): ColumnDefinition {
    return this.addColumn('time', name)
  }

  timestamp(name: string): ColumnDefinition {
    return this.addColumn('timestamp', name)
  }

  /** `created_at` and `updated_at`, both nullable, as Laravel makes them. */
  timestamps(): void {
    this.timestamp('created_at').nullable()
    this.timestamp('updated_at').nullable()
  }

  softDeletes(name = 'deleted_at'): ColumnDefinition {
    return this.timestamp(name).nullable()
  }

  rememberToken(): ColumnDefinition {
    return this.string('remember_token', 100).nullable()
  }

  /** `*_type` + `*_id` for a polymorphic relation. */
  // ------------------------------------------------------- the newer columns

  /** `char(26)`, which is exactly what a ULID is. */
  ulid(name = 'ulid'): ColumnDefinition {
    return this.addColumn('ulid', name)
  }

  /**
   * `ipAddress` and `macAddress` name the intent, and the type follows.
   *
   * Postgres has `inet` and `macaddr` and will reject a malformed value; MySQL
   * and SQLite have neither and store a string. Naming the intent is what lets an
   * application get the stricter column on the database that has one without
   * writing the migration twice.
   */
  ipAddress(name = 'ip_address'): ColumnDefinition {
    return this.addColumn('ipAddress', name)
  }

  macAddress(name = 'mac_address'): ColumnDefinition {
    return this.addColumn('macAddress', name)
  }

  year(name: string): ColumnDefinition {
    return this.addColumn('year', name)
  }

  tinyText(name: string): ColumnDefinition {
    return this.addColumn('tinyText', name)
  }

  /**
   * The time-zone-aware trio.
   *
   * Only Postgres actually keeps a zone: `timestamp with time zone` stores an
   * instant, while MySQL's `timestamp` and SQLite's `datetime` store what they
   * were given. The method is still worth having — it says which of the two an
   * application meant, and on Postgres it is the difference between a correct
   * instant and a wrong one across a daylight-saving change.
   */
  dateTimeTz(name: string): ColumnDefinition {
    return this.addColumn('dateTimeTz', name)
  }

  timeTz(name: string): ColumnDefinition {
    return this.addColumn('timeTz', name)
  }

  timestampTz(name: string): ColumnDefinition {
    return this.addColumn('timestampTz', name)
  }

  // ---------------------------------------------------------- the shorthands

  integerIncrements(name: string): ColumnDefinition {
    return this.addColumn('integer', name).autoIncrement()
  }

  mediumIncrements(name: string): ColumnDefinition {
    return this.addColumn('mediumInteger', name).autoIncrement()
  }

  smallIncrements(name: string): ColumnDefinition {
    return this.addColumn('smallInteger', name).autoIncrement()
  }

  tinyIncrements(name: string): ColumnDefinition {
    return this.addColumn('tinyInteger', name).autoIncrement()
  }

  unsignedMediumInteger(name: string): ColumnDefinition {
    return this.mediumInteger(name).unsigned()
  }

  unsignedSmallInteger(name: string): ColumnDefinition {
    return this.smallInteger(name).unsigned()
  }

  unsignedTinyInteger(name: string): ColumnDefinition {
    return this.tinyInteger(name).unsigned()
  }

  /** A uuid or a ulid that will hold somebody else's key. */
  foreignUuid(name: string): ColumnDefinition {
    return this.addColumn('uuid', name)
  }

  foreignUlid(name: string): ColumnDefinition {
    return this.addColumn('ulid', name)
  }

  // ------------------------------------------------------------- timestamps

  nullableTimestamps(): void {
    this.timestamp('created_at').nullable()
    this.timestamp('updated_at').nullable()
  }

  timestampsTz(): void {
    this.timestampTz('created_at').nullable()
    this.timestampTz('updated_at').nullable()
  }

  nullableTimestampsTz(): void {
    this.timestampsTz()
  }

  /** `created_at`/`updated_at` as datetimes rather than timestamps. */
  datetimes(): void {
    this.dateTime('created_at').nullable()
    this.dateTime('updated_at').nullable()
  }

  softDeletesTz(name = 'deleted_at'): ColumnDefinition {
    return this.timestampTz(name).nullable()
  }

  softDeletesDatetime(name = 'deleted_at'): ColumnDefinition {
    return this.dateTime(name).nullable()
  }

  // ----------------------------------------------------------- morph columns

  /** `morphs` with an integer key, which is what `morphs` already is. */
  numericMorphs(name: string): void {
    this.morphs(name)
  }

  nullableNumericMorphs(name: string): void {
    this.nullableMorphs(name)
  }

  /**
   * A polymorphic key that is a uuid or a ulid rather than an integer.
   *
   * Which one a table needs is decided by the *related* tables' keys, not by this
   * one — so a project using uuids everywhere would otherwise have to write the
   * two columns and their index out by hand every time.
   */
  uuidMorphs(name: string): void {
    this.string(`${name}_type`)
    this.uuid(`${name}_id`)
    this.index([`${name}_type`, `${name}_id`])
  }

  nullableUuidMorphs(name: string): void {
    this.string(`${name}_type`).nullable()
    this.uuid(`${name}_id`).nullable()
    this.index([`${name}_type`, `${name}_id`])
  }

  ulidMorphs(name: string): void {
    this.string(`${name}_type`)
    this.ulid(`${name}_id`)
    this.index([`${name}_type`, `${name}_id`])
  }

  nullableUlidMorphs(name: string): void {
    this.string(`${name}_type`).nullable()
    this.ulid(`${name}_id`).nullable()
    this.index([`${name}_type`, `${name}_id`])
  }

  morphs(name: string): void {
    this.string(`${name}_type`)
    this.unsignedBigInteger(`${name}_id`)
    this.index([`${name}_type`, `${name}_id`])
  }

  nullableMorphs(name: string): void {
    this.string(`${name}_type`).nullable()
    this.unsignedBigInteger(`${name}_id`).nullable()
    this.index([`${name}_type`, `${name}_id`])
  }

  /** An unsigned big integer meant to hold another table's key. */
  foreignId(name: string): ColumnDefinition {
    return this.unsignedBigInteger(name)
  }

  // ------------------------------------------------------------------ indexes

  primary(columns: string[], index?: string): this {
    this.commands.push({ name: 'primary', columns, index })
    return this
  }

  unique(columns: string[], index?: string): this {
    this.commands.push({
      name: 'unique',
      columns,
      index: index ?? this.indexName('unique', columns)
    })
    return this
  }

  index(columns: string[], index?: string): this {
    this.commands.push({
      name: 'index',
      columns,
      index: index ?? this.indexName('index', columns)
    })
    return this
  }

  foreign(columns: string[], index?: string): ForeignKeyDefinition {
    const command: Extract<Command, { name: 'foreign' }> = {
      name: 'foreign',
      columns,
      index: index ?? this.indexName('foreign', columns),
      on: '',
      references: ['id']
    }

    this.commands.push(command)

    return new ForeignKeyDefinition(command)
  }

  /** `users_email_unique` — Laravel's naming, which drop* commands rely on. */
  indexName(type: string, columns: string[]): string {
    return `${this.table}_${columns.join('_')}_${type}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  }

  // -------------------------------------------------------------------- drops

  /**
   * A full-text index — `fullText(['title', 'body'])`.
   *
   * The SQL is nothing like itself across dialects: MySQL has `fulltext`,
   * Postgres wants a GIN index over `to_tsvector`, and SQLite has no such index
   * at all — its full-text search is a separate virtual table. Its grammar throws
   * and names that, rather than emitting an index no search would use.
   */
  fullText(columns: string[], index?: string): this {
    this.commands.push({
      name: 'fullText',
      columns,
      index: index ?? this.indexName('fulltext', columns)
    })

    return this
  }

  dropFullText(index: string | string[]): this {
    const name = Array.isArray(index) ? this.indexName('fulltext', index) : index

    this.commands.push({ name: 'dropFullText', index: name })

    return this
  }

  /** `renameIndex('old', 'new')`. SQLite cannot, and says so. */
  renameIndex(from: string, to: string): this {
    this.commands.push({ name: 'renameIndex', from, to })

    return this
  }

  /** The three `drop` shorthands that pair with the columns above. */
  dropMorphs(name: string): this {
    return this.dropIndex(this.indexName('index', [`${name}_type`, `${name}_id`])).dropColumn(
      `${name}_type`,
      `${name}_id`
    )
  }

  dropRememberToken(): this {
    return this.dropColumn('remember_token')
  }

  dropTimestampsTz(): this {
    return this.dropColumn('created_at', 'updated_at')
  }

  dropSoftDeletesTz(name = 'deleted_at'): this {
    return this.dropColumn(name)
  }

  dropColumn(...columns: string[]): this {
    this.commands.push({ name: 'dropColumn', columns: columns.flat() })
    return this
  }

  dropIndex(index: string | string[]): this {
    this.commands.push({
      name: 'dropIndex',
      index: Array.isArray(index) ? this.indexName('index', index) : index
    })
    return this
  }

  dropUnique(index: string | string[]): this {
    this.commands.push({
      name: 'dropUnique',
      index: Array.isArray(index) ? this.indexName('unique', index) : index
    })
    return this
  }

  dropForeign(index: string | string[]): this {
    this.commands.push({
      name: 'dropForeign',
      index: Array.isArray(index) ? this.indexName('foreign', index) : index
    })
    return this
  }

  dropPrimary(index?: string): this {
    this.commands.push({ name: 'dropPrimary', index })
    return this
  }

  dropTimestamps(): this {
    return this.dropColumn('created_at', 'updated_at')
  }

  dropSoftDeletes(name = 'deleted_at'): this {
    return this.dropColumn(name)
  }

  renameColumn(from: string, to: string): this {
    this.commands.push({ name: 'renameColumn', from, to })
    return this
  }

  rename(to: string): this {
    this.commands.push({ name: 'rename', to })
    return this
  }

  drop(): this {
    this.commands.push({ name: 'drop' })
    return this
  }

  dropIfExists(): this {
    this.commands.push({ name: 'dropIfExists' })
    return this
  }

  private addColumn(
    type: ColumnType,
    name: string,
    extra: Partial<ColumnAttributes> = {}
  ): ColumnDefinition {
    const column = new ColumnDefinition({ name, type, ...extra }, this)
    this.columns.push(column)

    return column
  }
}
