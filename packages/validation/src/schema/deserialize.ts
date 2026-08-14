import {
  AnyOfSchema,
  ArraySchema,
  BooleanSchema,
  IntegerSchema,
  type JsonSchemaObject,
  NumberSchema,
  ObjectSchema,
  type SchemaType,
  StringSchema,
  UnionSchema
} from './types.ts'

/**
 * How many fragments one schema may expand into.
 *
 * A `$ref` that points at an ancestor expands forever, and a document with a
 * few dozen mutually-referencing definitions expands into millions of nodes
 * from a few kilobytes of input. Laravel caps this at 20,000 for the same
 * reason: the parser has to be safe to point at a schema someone uploaded.
 */
const MAX_NODES = 20_000

/** Read `#/$defs/address` out of the root document. */
function resolvePointer(root: JsonSchemaObject, ref: string): JsonSchemaObject | undefined {
  if (!ref.startsWith('#/')) return undefined

  let current: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }

  return current && typeof current === 'object' ? (current as JsonSchemaObject) : undefined
}

class Deserializer {
  private nodes = 0

  constructor(private readonly root: JsonSchemaObject) {}

  build(schema: JsonSchemaObject, seen: Set<string> = new Set()): SchemaType {
    if (++this.nodes > MAX_NODES) {
      throw new Error(
        `The JSON Schema is too large to read; it expands beyond ${MAX_NODES} fragments. ` +
          `A $ref that points at one of its own ancestors will do this.`
      )
    }

    const resolved = this.follow(schema, seen)
    const built = this.buildResolved(resolved.schema, resolved.seen)

    return this.applyShared(built, resolved.schema)
  }

  /** Follow `$ref`, refusing a cycle rather than recursing into it. */
  private follow(
    schema: JsonSchemaObject,
    seen: Set<string>
  ): { schema: JsonSchemaObject; seen: Set<string> } {
    const ref = schema.$ref
    if (typeof ref !== 'string') return { schema, seen }

    if (seen.has(ref)) {
      throw new Error(`The JSON Schema reference [${ref}] points back at itself.`)
    }

    const target = resolvePointer(this.root, ref)
    if (!target) throw new Error(`The JSON Schema reference [${ref}] could not be resolved.`)

    return this.follow(target, new Set([...seen, ref]))
  }

  private buildResolved(schema: JsonSchemaObject, seen: Set<string>): SchemaType {
    if (Array.isArray(schema.anyOf)) {
      const branches = (schema.anyOf as JsonSchemaObject[]).filter(
        (branch) => branch?.type !== 'null'
      )
      const nullable = (schema.anyOf as JsonSchemaObject[]).some(
        (branch) => branch?.type === 'null'
      )

      const built = new AnyOfSchema(branches.map((branch) => this.build(branch, seen)))

      return nullable ? built.nullable() : built
    }

    const declared = schema.type

    if (Array.isArray(declared)) {
      const names = declared.filter((name) => name !== 'null')
      const nullable = declared.includes('null')

      /**
       * A single-name union is just that type.
       *
       * `{"type": ["string", "null"]}` is how nullability is spelled far more
       * often than `anyOf`, and reading it back as a `UnionSchema` of one would
       * lose every string constraint on the way through.
       */
      const built =
        names.length === 1
          ? this.primitive(names[0] as string, schema, seen)
          : new UnionSchema(names as string[])

      return nullable ? built.nullable() : built
    }

    if (typeof declared !== 'string') {
      throw new Error(
        `The JSON Schema fragment has no [type] and no [anyOf]: ${JSON.stringify(schema).slice(0, 120)}`
      )
    }

    return this.primitive(declared, schema, seen)
  }

  private primitive(name: string, schema: JsonSchemaObject, seen: Set<string>): SchemaType {
    switch (name) {
      case 'string': {
        const built = new StringSchema()
        if (typeof schema.minLength === 'number') built.min(schema.minLength)
        if (typeof schema.maxLength === 'number') built.max(schema.maxLength)
        if (typeof schema.pattern === 'string') built.pattern(schema.pattern)
        if (typeof schema.format === 'string') built.format(schema.format)

        return built
      }

      case 'integer':
      case 'number': {
        const built = name === 'integer' ? new IntegerSchema() : new NumberSchema()
        if (typeof schema.minimum === 'number') built.min(schema.minimum)
        if (typeof schema.maximum === 'number') built.max(schema.maximum)
        if (typeof schema.multipleOf === 'number') built.multipleOf(schema.multipleOf)

        return built
      }

      case 'boolean':
        return new BooleanSchema()

      case 'array': {
        const built = new ArraySchema()
        if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
          built.items(this.build(schema.items as JsonSchemaObject, seen))
        }
        if (typeof schema.minItems === 'number') built.min(schema.minItems)
        if (typeof schema.maxItems === 'number') built.max(schema.maxItems)
        if (typeof schema.uniqueItems === 'boolean') built.unique(schema.uniqueItems)

        return built
      }

      case 'object': {
        const required = new Set(
          Array.isArray(schema.required) ? (schema.required as string[]) : []
        )
        const properties: Record<string, SchemaType> = {}

        for (const [key, value] of Object.entries(
          (schema.properties ?? {}) as Record<string, JsonSchemaObject>
        )) {
          const child = this.build(value, seen)
          // Back onto the child, where the builder keeps it.
          if (required.has(key)) child.required()
          properties[key] = child
        }

        const built = new ObjectSchema(properties)

        return schema.additionalProperties === false ? built.withoutAdditionalProperties() : built
      }

      default:
        throw new Error(`Unsupported JSON Schema type [${name}].`)
    }
  }

  private applyShared(built: SchemaType, schema: JsonSchemaObject): SchemaType {
    if (typeof schema.title === 'string') built.title(schema.title)
    if (typeof schema.description === 'string') built.description(schema.description)
    if (Array.isArray(schema.enum)) built.enum(schema.enum)
    if ('default' in schema) built.default(schema.default)

    return built
  }
}

/**
 * Read a JSON Schema document back into builder types.
 *
 * The round trip is not lossless in general and is not meant to be: JSON Schema
 * is far larger than this builder, and a document using `oneOf`, `if`/`then` or
 * `patternProperties` will fail rather than silently drop them. Failing is the
 * point — a parser that quietly ignores half a schema produces a validator that
 * accepts what the schema forbade.
 */
export function fromJsonSchema(schema: JsonSchemaObject): SchemaType {
  return new Deserializer(schema).build(schema)
}
