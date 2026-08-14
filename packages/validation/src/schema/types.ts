/** A plain JSON Schema fragment — what everything here serialises to. */
export type JsonSchemaObject = Record<string, unknown>

/**
 * A node in a schema being built — Laravel's `JsonSchema\Types\Type`.
 *
 * `required()` sits on the child rather than the parent, which looks backwards
 * for one field and is right for every other case: a field carries its own
 * rules, so it can be defined once and reused in several objects without each
 * one restating which of its properties are mandatory. The parent collects the
 * flags at serialisation time, because JSON Schema puts `required` on the object.
 */
export abstract class SchemaType {
  protected isRequired = false
  protected isNullable = false
  protected titleText?: string
  protected descriptionText?: string
  protected enumValues?: unknown[]
  protected defaultValue?: unknown
  protected hasDefault = false

  abstract get jsonType(): string | string[]

  /** Constraints belonging to the concrete type. */
  protected abstract constraints(): JsonSchemaObject

  required(required = true): this {
    this.isRequired = required

    return this
  }

  nullable(nullable = true): this {
    this.isNullable = nullable

    return this
  }

  title(title: string): this {
    this.titleText = title

    return this
  }

  description(description: string): this {
    this.descriptionText = description

    return this
  }

  enum(values: unknown[]): this {
    this.enumValues = [...values]

    return this
  }

  /**
   * A default.
   *
   * Tracked with a flag rather than by `!== undefined`, so `default(undefined)`
   * and never calling it stay distinguishable — and, more to the point, so a
   * legitimate `default(null)` is not dropped.
   */
  default(value: unknown): this {
    this.defaultValue = value
    this.hasDefault = true

    return this
  }

  /** Read by the parent object when collecting `required`. */
  get mandatory(): boolean {
    return this.isRequired
  }

  get nullableFlag(): boolean {
    return this.isNullable
  }

  /** The common half of the fragment: title, description, enum, default. */
  protected shared(): JsonSchemaObject {
    const shared: JsonSchemaObject = {}

    if (this.titleText !== undefined) shared.title = this.titleText
    if (this.descriptionText !== undefined) shared.description = this.descriptionText
    if (this.enumValues !== undefined) shared.enum = this.enumValues
    if (this.hasDefault) shared.default = this.defaultValue

    return shared
  }

  /** The JSON Schema fragment for this node. */
  toJsonSchema(): JsonSchemaObject {
    const type = this.isNullable
      ? Array.isArray(this.jsonType)
        ? [...this.jsonType, 'null']
        : [this.jsonType, 'null']
      : this.jsonType

    return { type, ...this.constraints(), ...this.shared() }
  }

  toString(): string {
    return JSON.stringify(this.toJsonSchema())
  }
}

export class StringSchema extends SchemaType {
  private minLength?: number
  private maxLength?: number
  private patternText?: string
  private formatName?: string

  get jsonType(): string {
    return 'string'
  }

  min(length: number): this {
    this.minLength = length

    return this
  }

  max(length: number): this {
    this.maxLength = length

    return this
  }

  pattern(pattern: string | RegExp): this {
    this.patternText = pattern instanceof RegExp ? pattern.source : pattern

    return this
  }

  /** `email`, `uri`, `date-time`, and the rest of the JSON Schema vocabulary. */
  format(format: string): this {
    this.formatName = format

    return this
  }

  protected constraints(): JsonSchemaObject {
    const out: JsonSchemaObject = {}

    if (this.minLength !== undefined) out.minLength = this.minLength
    if (this.maxLength !== undefined) out.maxLength = this.maxLength
    if (this.patternText !== undefined) out.pattern = this.patternText
    if (this.formatName !== undefined) out.format = this.formatName

    return out
  }
}

abstract class NumericSchema extends SchemaType {
  private minimum?: number
  private maximum?: number
  private multiple?: number

  min(value: number): this {
    this.minimum = value

    return this
  }

  max(value: number): this {
    this.maximum = value

    return this
  }

  multipleOf(value: number): this {
    this.multiple = value

    return this
  }

  protected constraints(): JsonSchemaObject {
    const out: JsonSchemaObject = {}

    if (this.minimum !== undefined) out.minimum = this.minimum
    if (this.maximum !== undefined) out.maximum = this.maximum
    if (this.multiple !== undefined) out.multipleOf = this.multiple

    return out
  }
}

export class IntegerSchema extends NumericSchema {
  get jsonType(): string {
    return 'integer'
  }
}

export class NumberSchema extends NumericSchema {
  get jsonType(): string {
    return 'number'
  }
}

export class BooleanSchema extends SchemaType {
  get jsonType(): string {
    return 'boolean'
  }

  protected constraints(): JsonSchemaObject {
    return {}
  }
}

export class ArraySchema extends SchemaType {
  private minItems?: number
  private maxItems?: number
  private itemSchema?: SchemaType
  private uniqueItems?: boolean

  get jsonType(): string {
    return 'array'
  }

  min(count: number): this {
    this.minItems = count

    return this
  }

  max(count: number): this {
    this.maxItems = count

    return this
  }

  items(schema: SchemaType): this {
    this.itemSchema = schema

    return this
  }

  unique(unique = true): this {
    this.uniqueItems = unique

    return this
  }

  protected constraints(): JsonSchemaObject {
    const out: JsonSchemaObject = {}

    if (this.itemSchema) out.items = this.itemSchema.toJsonSchema()
    if (this.minItems !== undefined) out.minItems = this.minItems
    if (this.maxItems !== undefined) out.maxItems = this.maxItems
    if (this.uniqueItems !== undefined) out.uniqueItems = this.uniqueItems

    return out
  }
}

export class ObjectSchema extends SchemaType {
  private closed = false

  constructor(private readonly properties: Record<string, SchemaType> = {}) {
    super()
  }

  get jsonType(): string {
    return 'object'
  }

  /** Reject anything not declared. */
  withoutAdditionalProperties(): this {
    this.closed = true

    return this
  }

  /** The declared properties, for a caller walking the schema. */
  get shape(): Record<string, SchemaType> {
    return this.properties
  }

  protected constraints(): JsonSchemaObject {
    const out: JsonSchemaObject = {}
    const entries = Object.entries(this.properties)

    if (entries.length > 0) {
      out.properties = Object.fromEntries(
        entries.map(([name, schema]) => [name, schema.toJsonSchema()])
      )

      // Collected from the children, which is where `required()` was declared.
      const required = entries.filter(([, schema]) => schema.mandatory).map(([name]) => name)
      if (required.length > 0) out.required = required
    }

    if (this.closed) out.additionalProperties = false

    return out
  }
}

/**
 * One of several schemas — JSON Schema's `anyOf`.
 *
 * Distinct from a union of *type names*: `anyOf` composes whole schemas, so the
 * branches can differ in their constraints and not just their type. `nullable()`
 * adds a `null` branch rather than a `null` type, because there is no single
 * `type` keyword to append to.
 */
export class AnyOfSchema extends SchemaType {
  constructor(private readonly branches: SchemaType[]) {
    super()
  }

  get jsonType(): string {
    return 'anyOf'
  }

  protected constraints(): JsonSchemaObject {
    return {}
  }

  override toJsonSchema(): JsonSchemaObject {
    const branches = this.branches.map((branch) => branch.toJsonSchema())
    if (this.nullableFlag) branches.push({ type: 'null' })

    return { anyOf: branches, ...this.shared() }
  }
}

/** Several primitive types at once — `{"type": ["string", "integer"]}`. */
export class UnionSchema extends SchemaType {
  constructor(private readonly names: string[]) {
    super()
  }

  get jsonType(): string[] {
    return this.names
  }

  protected constraints(): JsonSchemaObject {
    return {}
  }
}
