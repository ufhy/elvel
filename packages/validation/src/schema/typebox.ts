import { type TSchema, t } from 'elysia'
import type { JsonSchemaObject, SchemaType } from './types.ts'

/**
 * Turn a JSON Schema fragment into a real TypeBox schema.
 *
 * The obvious shortcut does not work. A TypeBox schema *looks* like JSON Schema
 * — serialise one and you get valid JSON Schema back — so handing a raw fragment
 * to `t.Unsafe()` seems like it should be free. It compiles and then throws
 * `Unknown type` the moment Elysia builds a validator, because TypeBox's
 * compiler dispatches on a `Symbol(TypeBox.Kind)` that a plain object does not
 * carry. The types have to be constructed, so they are.
 */
export function toTypeBox(schema: JsonSchemaObject | SchemaType): TSchema {
  const fragment =
    typeof (schema as SchemaType).toJsonSchema === 'function'
      ? (schema as SchemaType).toJsonSchema()
      : (schema as JsonSchemaObject)

  return build(fragment)
}

function build(schema: JsonSchemaObject): TSchema {
  if (Array.isArray(schema.anyOf)) {
    return t.Union((schema.anyOf as JsonSchemaObject[]).map(build), options(schema))
  }

  const declared = schema.type

  if (Array.isArray(declared)) {
    return t.Union(
      (declared as string[]).map((name) => build({ ...schema, type: name })),
      options(schema)
    )
  }

  switch (declared) {
    case 'string':
      return t.String(options(schema, ['minLength', 'maxLength', 'pattern', 'format']))

    case 'integer':
      return t.Integer(options(schema, ['minimum', 'maximum', 'multipleOf']))

    case 'number':
      return t.Number(options(schema, ['minimum', 'maximum', 'multipleOf']))

    case 'boolean':
      return t.Boolean(options(schema))

    case 'null':
      return t.Null()

    case 'array': {
      const items =
        schema.items && typeof schema.items === 'object'
          ? build(schema.items as JsonSchemaObject)
          : t.Unknown()

      return t.Array(items, options(schema, ['minItems', 'maxItems', 'uniqueItems']))
    }

    case 'object': {
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
      const shape: Record<string, TSchema> = {}

      for (const [key, value] of Object.entries(
        (schema.properties ?? {}) as Record<string, JsonSchemaObject>
      )) {
        const child = build(value)
        // TypeBox marks optionality on the property, not on the parent.
        shape[key] = required.has(key) ? child : t.Optional(child)
      }

      return t.Object(shape, {
        ...options(schema),
        ...(schema.additionalProperties === false ? { additionalProperties: false } : {})
      })
    }

    default:
      throw new Error(
        `Cannot build a TypeBox schema from type [${String(declared)}]. ` +
          `Supported: string, integer, number, boolean, null, array, object, and anyOf.`
      )
  }
}

/** Carry the keywords TypeBox understands onto the constructed type. */
function options(schema: JsonSchemaObject, keys: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const key of ['title', 'description', 'default', ...keys]) {
    if (key in schema) out[key] = schema[key]
  }

  return out
}

/**
 * A TypeBox schema as plain JSON Schema.
 *
 * A round trip through JSON drops the `Kind` symbols, which is exactly what is
 * wanted: the symbols are TypeBox's dispatch table, not part of the schema, and
 * anything reading the output over the wire has no use for them.
 *
 * What it does *not* drop is Elysia's coercion. `t.Integer()` from Elysia is an
 * `anyOf` of a numeric string and an integer, so a query parameter arriving as
 * `"36"` validates — right for HTTP, and surprising in a document handed to a
 * client. The widening is Elysia's, and it comes through.
 */
export function fromTypeBox(schema: TSchema): JsonSchemaObject {
  return JSON.parse(JSON.stringify(schema)) as JsonSchemaObject
}
