import {
  AnyOfSchema,
  ArraySchema,
  BooleanSchema,
  IntegerSchema,
  NumberSchema,
  ObjectSchema,
  type SchemaType,
  StringSchema,
  UnionSchema
} from './types.ts'

/**
 * Build a JSON Schema — Laravel's `JsonSchema` facade.
 *
 * ```ts
 * const schema = Schema.object({
 *   name: Schema.string().min(3).required(),
 *   age: Schema.integer().min(0),
 *   tags: Schema.array().items(Schema.string()).unique()
 * }).withoutAdditionalProperties()
 *
 * schema.toJsonSchema()   // a plain document, for an API or a model
 * toTypeBox(schema)       // a validator Elysia can compile
 * ```
 */
export const Schema = {
  string: () => new StringSchema(),
  integer: () => new IntegerSchema(),
  number: () => new NumberSchema(),
  boolean: () => new BooleanSchema(),
  array: (items?: SchemaType) => {
    const schema = new ArraySchema()

    return items ? schema.items(items) : schema
  },
  object: (properties: Record<string, SchemaType> = {}) => new ObjectSchema(properties),
  /** One of several whole schemas. */
  anyOf: (...branches: SchemaType[]) => new AnyOfSchema(branches.flat()),
  /** Several primitive type names at once. */
  union: (...names: string[]) => new UnionSchema(names.flat())
}

export { fromJsonSchema } from './deserialize.ts'
export { fromTypeBox, toTypeBox } from './typebox.ts'
export {
  AnyOfSchema,
  ArraySchema,
  BooleanSchema,
  IntegerSchema,
  type JsonSchemaObject,
  NumberSchema,
  ObjectSchema,
  SchemaType,
  StringSchema,
  UnionSchema
} from './types.ts'
