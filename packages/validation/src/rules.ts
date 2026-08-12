import { Arr } from '@elysian/support'
import { extensionOf, isFile, kilobytes, looksExecutable, mediaTypesFor, sniff } from './files.ts'
import type { Data, RuleContext, RuleHandler } from './types.ts'
import { ExistsRule, UniqueRule } from './types.ts'
import { valuesUnder } from './wildcards.ts'

/**
 * Rules that run even when the attribute is absent.
 *
 * Verbatim from `Validator::$implicitRules`, and the reason `required` can fail
 * on a key that was never sent.
 */
export const IMPLICIT_RULES = new Set([
  'accepted',
  'accepted_if',
  'declined',
  'declined_if',
  'filled',
  'missing',
  'missing_if',
  'missing_unless',
  'missing_with',
  'missing_with_all',
  'present',
  'present_if',
  'present_unless',
  'present_with',
  'present_with_all',
  'required',
  'required_if',
  'required_if_accepted',
  'required_if_declined',
  'required_unless',
  'required_with',
  'required_with_all',
  'required_without',
  'required_without_all'
])

/** Rules whose parameters name other fields, so they need the whole payload. */
export const DEPENDENT_RULES = new Set([
  'after',
  'after_or_equal',
  'before',
  'before_or_equal',
  'confirmed',
  'different',
  'exclude_if',
  'exclude_unless',
  'exclude_with',
  'exclude_without',
  'gt',
  'gte',
  'lt',
  'lte',
  'accepted_if',
  'declined_if',
  'required_if',
  'required_if_accepted',
  'required_if_declined',
  'required_unless',
  'required_with',
  'required_with_all',
  'required_without',
  'required_without_all',
  'present_if',
  'present_unless',
  'present_with',
  'present_with_all',
  'prohibited',
  'prohibited_if',
  'prohibited_unless',
  'prohibits',
  'missing_if',
  'missing_unless',
  'missing_with',
  'missing_with_all',
  'same',
  'unique',
  'in_array'
])

/** Rules that drop the attribute from the validated output. */
export const EXCLUDE_RULES = new Set([
  'exclude',
  'exclude_if',
  'exclude_unless',
  'exclude_with',
  'exclude_without'
])

/** Rules whose message depends on the value's type. */
export const SIZE_RULES = new Set(['size', 'between', 'min', 'max', 'gt', 'lt', 'gte', 'lte'])

/** Rules the engine handles itself rather than dispatching. */
export const NON_VALIDATING_RULES = new Set(['nullable', 'sometimes', 'bail', 'exclude'])

/** `min_width=100` pairs, as `dimensions` takes them. */
function namedParameters(params: string[]): Record<string, string> {
  const named: Record<string, string> = {}

  for (const param of params) {
    const [key, value] = param.split('=')
    if (key !== undefined && value !== undefined) named[key.trim()] = value.trim()
  }

  return named
}

/** `3/2` as a number. A bare `1.5` is accepted too, as Laravel's sscanf is. */
function parseRatio(ratio: string): number {
  const [numerator, denominator] = ratio.split('/')

  return Number(numerator) / Number(denominator ?? 1)
}

/** An array, or a plain object: both arrive as "an array" over JSON or a form. */
function isArrayLike(value: unknown): boolean {
  return Array.isArray(value) || (value !== null && typeof value === 'object')
}

// ------------------------------------------------------------------- helpers

function has(data: Data, key: string): boolean {
  return Arr.has(data, key)
}

function get(data: Data, key: string): unknown {
  return Arr.get(data, key)
}

/** Laravel's notion of "present": not null, not an empty string or array. */
export function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0

  return true
}

const TRUTHY = new Set([true, 'true', 1, '1', 'yes', 'on'])
const FALSY = new Set([false, 'false', 0, '0', 'no', 'off'])

/** Numeric size for a value: magnitude, length, or item count. */
export function sizeOf(value: unknown, treatAsNumeric = false): number {
  if (typeof value === 'number') return value
  // Kilobytes, so `max:2048` on an upload means what everybody writing it means.
  if (isFile(value)) return kilobytes(value)
  if (Array.isArray(value)) return value.length
  if (typeof value === 'string') {
    return treatAsNumeric && value.trim() !== '' && !Number.isNaN(Number(value))
      ? Number(value)
      : value.length
  }

  return 0
}

function numericContext(context: RuleContext): boolean {
  return context.siblings.some((rule) => ['numeric', 'integer', 'decimal'].includes(rule.name))
}

function compareSize(context: RuleContext): number {
  return sizeOf(context.value, numericContext(context))
}

function otherValue(context: RuleContext, field?: string): unknown {
  return field === undefined ? undefined : get(context.data, field)
}

function anyPresent(context: RuleContext, fields: string[]): boolean {
  return fields.some((field) => isFilled(otherValue(context, field)))
}

function allPresent(context: RuleContext, fields: string[]): boolean {
  return fields.every((field) => isFilled(otherValue(context, field)))
}

function toDate(value: unknown): number {
  if (value instanceof Date) return value.getTime()

  const parsed = Date.parse(String(value))

  return Number.isNaN(parsed) ? Number.NaN : parsed
}

/** A date rule's parameter may name another field or be a literal date. */
function dateBoundary(context: RuleContext, param: string | undefined): number {
  if (param === undefined) return Number.NaN
  if (has(context.data, param)) return toDate(get(context.data, param))

  return toDate(param)
}

// --------------------------------------------------------------------- rules

export const RULES: Record<string, RuleHandler> = {
  // -- presence ------------------------------------------------------------
  required: ({ value }) => isFilled(value),

  filled: ({ attribute, value, data }) => (has(data, attribute) ? isFilled(value) : true),

  present: ({ attribute, data }) => has(data, attribute),

  missing: ({ attribute, data }) => !has(data, attribute),

  missing_if: (context) => {
    const [field, ...values] = context.params
    return values.includes(String(otherValue(context, field)))
      ? !has(context.data, context.attribute)
      : true
  },

  missing_unless: (context) => {
    const [field, ...values] = context.params
    return values.includes(String(otherValue(context, field)))
      ? true
      : !has(context.data, context.attribute)
  },

  missing_with: (context) =>
    anyPresent(context, context.params) ? !has(context.data, context.attribute) : true,

  missing_with_all: (context) =>
    allPresent(context, context.params) ? !has(context.data, context.attribute) : true,

  required_if: (context) => {
    const [field, ...values] = context.params
    if (field === undefined || !has(context.data, field)) return true

    return values.includes(String(otherValue(context, field))) ? isFilled(context.value) : true
  },

  required_unless: (context) => {
    const [field, ...values] = context.params

    return values.includes(String(otherValue(context, field))) ? true : isFilled(context.value)
  },

  required_if_accepted: (context) => {
    const [field] = context.params

    return TRUTHY.has(otherValue(context, field) as never) ? isFilled(context.value) : true
  },

  required_if_declined: (context) => {
    const [field] = context.params

    return FALSY.has(otherValue(context, field) as never) ? isFilled(context.value) : true
  },

  required_with: (context) =>
    anyPresent(context, context.params) ? isFilled(context.value) : true,

  required_with_all: (context) =>
    allPresent(context, context.params) ? isFilled(context.value) : true,

  required_without: (context) =>
    context.params.some((field) => !isFilled(otherValue(context, field)))
      ? isFilled(context.value)
      : true,

  required_without_all: (context) =>
    context.params.every((field) => !isFilled(otherValue(context, field)))
      ? isFilled(context.value)
      : true,

  prohibited: ({ value }) => !isFilled(value),

  prohibited_if: (context) => {
    const [field, ...values] = context.params

    return values.includes(String(otherValue(context, field))) ? !isFilled(context.value) : true
  },

  prohibited_unless: (context) => {
    const [field, ...values] = context.params

    return values.includes(String(otherValue(context, field))) ? true : !isFilled(context.value)
  },

  /** This field being present forbids the others. */
  prohibits: (context) =>
    isFilled(context.value)
      ? context.params.every((field) => !isFilled(otherValue(context, field)))
      : true,

  // -- types ---------------------------------------------------------------
  string: ({ value }) => typeof value === 'string',

  numeric: ({ value }) =>
    typeof value === 'number'
      ? Number.isFinite(value)
      : typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)),

  integer: ({ value }) =>
    typeof value === 'number'
      ? Number.isInteger(value)
      : typeof value === 'string' && /^-?\d+$/.test(value.trim()),

  boolean: ({ value }) => TRUTHY.has(value as never) || FALSY.has(value as never),

  /**
   * An array — and, when keys are named, *only* those keys.
   *
   * `array:name,email` is the guard against mass assignment through a nested
   * object: an extra key is a failure rather than something quietly carried into
   * `validated()`. A plain object counts, because JSON has no separate shape for
   * "associative array" and a form posts one either way.
   */
  array: ({ value, params }) => {
    if (!isArrayLike(value)) return false
    if (params.length === 0) return true

    return Object.keys(value as object).every((key) => params.includes(key))
  },

  // ---------------------------------------------------------------- files

  /** An upload arrived, rather than a field named like one. */
  file: ({ value }) => isFile(value),

  /**
   * An image, decided by the file's **bytes** rather than its claimed type.
   *
   * `image:allow_svg` adds SVG, which is off by default because an SVG is a
   * document that can carry script — Laravel made the same choice.
   */
  image: async ({ value, params }) => {
    if (!isFile(value)) return false

    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp']

    if (params.includes('allow_svg')) {
      // Nothing to sniff: an SVG is text, so the claim and the extension are all
      // there is. Asking for it is opting into that.
      if (mediaTypesFor(extensionOf(value)).includes('image/svg+xml')) return true
    }

    const sniffed = await sniff(value)

    return sniffed !== undefined && allowed.includes(sniffed.type)
  },

  /**
   * One of these extensions — checked against the content, not the name.
   *
   * `mimes:jpg` accepts a file called `photo.jpeg`, and refuses `photo.jpg` that
   * is really a zip. An executable extension is refused unless it was asked for
   * by name, which is Laravel's `shouldBlockPhpUpload` widened a little.
   */
  mimes: async ({ value, params }) => {
    if (!isFile(value)) return false
    if (looksExecutable(value) && !params.includes(extensionOf(value))) return false

    const accepted = params.flatMap((extension) => mediaTypesFor(extension))
    const sniffed = await sniff(value)

    // Believe the bytes when they are legible; fall back to the declared type for
    // formats this cannot read, and say so in the docs rather than pretending.
    const actual = sniffed?.type ?? value.type

    return accepted.includes(actual)
  },

  /** One of these media types exactly, for anything the extension map misses. */
  mimetypes: async ({ value, params }) => {
    if (!isFile(value)) return false

    const sniffed = await sniff(value)

    return params.includes(sniffed?.type ?? value.type)
  },

  /**
   * One of these filename extensions.
   *
   * The **name**, deliberately: this is the rule for "must be called .csv", and
   * it says nothing about the contents. Pair it with `mimes` when that matters.
   */
  extensions: ({ value, params }) => {
    if (!isFile(value)) return false

    return params.map((param) => param.toLowerCase()).includes(extensionOf(value))
  },

  /**
   * `dimensions:min_width=100,ratio=3/2` — width, height and aspect ratio.
   *
   * The ratio tolerance is Laravel's, and it is not arbitrary: an exact
   * comparison of two floats rejects a 1600x900 image for `16/9`.
   */
  dimensions: async ({ value, params }) => {
    if (!isFile(value)) return false

    const sniffed = await sniff(value)
    if (!sniffed || sniffed.width === 0 || sniffed.height === 0) return false

    const { width, height } = sniffed
    const named = namedParameters(params)
    const number = (key: string) => (named[key] === undefined ? undefined : Number(named[key]))

    if (number('width') !== undefined && number('width') !== width) return false
    if (number('height') !== undefined && number('height') !== height) return false
    if ((number('min_width') ?? -Infinity) > width) return false
    if ((number('max_width') ?? Infinity) < width) return false
    if ((number('min_height') ?? -Infinity) > height) return false
    if ((number('max_height') ?? Infinity) < height) return false

    if (named.ratio !== undefined) {
      const target = parseRatio(named.ratio)
      const precision = 1 / (Math.max((width + height) / 2, height) + 1)

      if (Math.abs(target - width / height) > precision) return false
    }

    return true
  },

  /** An array with sequential numeric keys — a list, not a map. */
  list: ({ value }) => Array.isArray(value),

  /** Every named key is present. Says nothing about what else is there. */
  required_array_keys: ({ value, params }) => {
    if (!isArrayLike(value)) return false

    const keys = Object.keys(value as object)

    return params.every((param) => keys.includes(param))
  },

  /** The array contains every one of these values. Laravel's `contains`. */
  contains: ({ value, params }) => {
    if (!Array.isArray(value)) return false

    const present = value.map((entry) => String(entry))

    return params.every((param) => present.includes(param))
  },

  /**
   * No two values under the same wildcard repeat.
   *
   * The comparison is loose by default, as Laravel's is: `1` and `'1'` collide,
   * because a form sends numbers as text and "two of the same id" is what the
   * caller means. `strict` compares by type as well, `ignore_case` folds case.
   */
  distinct: ({ value, params, data, pattern, attribute }) => {
    const strict = params.includes('strict')
    const ignoreCase = params.includes('ignore_case')

    const siblings = Object.entries(valuesUnder(data, pattern))
      .filter(([key]) => key !== attribute)
      .map(([, entry]) => entry)

    return !siblings.some((other) => {
      if (ignoreCase) {
        return String(other).toLowerCase() === String(value).toLowerCase()
      }

      return strict ? other === value : String(other) === String(value)
    })
  },

  json: ({ value }) => {
    if (typeof value !== 'string') return false
    try {
      JSON.parse(value)
      return true
    } catch {
      return false
    }
  },

  date: ({ value }) => !Number.isNaN(toDate(value)),

  // -- format --------------------------------------------------------------
  email: ({ value }) => typeof value === 'string' && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value),

  url: ({ value }) => {
    if (typeof value !== 'string') return false
    try {
      new URL(value)
      return true
    } catch {
      return false
    }
  },

  uuid: ({ value }) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),

  ip: ({ value }) => {
    if (typeof value !== 'string') return false
    const v4 = /^(\d{1,3}\.){3}\d{1,3}$/
    if (v4.test(value)) return value.split('.').every((part) => Number(part) <= 255)

    return /^[0-9a-f:]+$/i.test(value) && value.includes(':')
  },

  alpha: ({ value }) => typeof value === 'string' && /^[a-z]+$/i.test(value),

  alpha_num: ({ value }) => typeof value === 'string' && /^[a-z0-9]+$/i.test(value),

  alpha_dash: ({ value }) => typeof value === 'string' && /^[a-z0-9_-]+$/i.test(value),

  lowercase: ({ value }) => typeof value === 'string' && value === value.toLowerCase(),

  uppercase: ({ value }) => typeof value === 'string' && value === value.toUpperCase(),

  regex: ({ value, params }) => {
    const pattern = params.join(',')

    return typeof value === 'string' && buildRegExp(pattern).test(value)
  },

  not_regex: ({ value, params }) => {
    const pattern = params.join(',')

    return typeof value === 'string' && !buildRegExp(pattern).test(value)
  },

  digits: ({ value, params }) =>
    /^\d+$/.test(String(value)) && String(value).length === Number(params[0]),

  digits_between: ({ value, params }) => {
    if (!/^\d+$/.test(String(value))) return false
    const length = String(value).length

    return length >= Number(params[0]) && length <= Number(params[1])
  },

  decimal: ({ value, params }) => {
    const match = /^-?\d+(?:\.(\d+))?$/.exec(String(value))
    if (!match) return false

    const places = match[1]?.length ?? 0
    const [min, max] = params

    return max === undefined
      ? places === Number(min)
      : places >= Number(min) && places <= Number(max)
  },

  // -- size ----------------------------------------------------------------
  size: (context) => compareSize(context) === Number(context.params[0]),

  min: (context) => compareSize(context) >= Number(context.params[0]),

  max: (context) => compareSize(context) <= Number(context.params[0]),

  between: (context) => {
    const size = compareSize(context)

    return size >= Number(context.params[0]) && size <= Number(context.params[1])
  },

  gt: (context) => compareSize(context) > sizeOf(otherValue(context, context.params[0]), true),

  gte: (context) => compareSize(context) >= sizeOf(otherValue(context, context.params[0]), true),

  lt: (context) => compareSize(context) < sizeOf(otherValue(context, context.params[0]), true),

  lte: (context) => compareSize(context) <= sizeOf(otherValue(context, context.params[0]), true),

  // -- membership ----------------------------------------------------------
  in: ({ value, params }) => params.includes(String(value)),

  not_in: ({ value, params }) => !params.includes(String(value)),

  in_array: (context) => {
    const other = otherValue(context, context.params[0])

    return Array.isArray(other) ? other.map(String).includes(String(context.value)) : false
  },

  starts_with: ({ value, params }) =>
    typeof value === 'string' && params.some((prefix) => value.startsWith(prefix)),

  ends_with: ({ value, params }) =>
    typeof value === 'string' && params.some((suffix) => value.endsWith(suffix)),

  // -- cross-field ---------------------------------------------------------
  same: (context) => String(context.value) === String(otherValue(context, context.params[0])),

  different: (context) => String(context.value) !== String(otherValue(context, context.params[0])),

  confirmed: (context) => {
    const field = context.params[0] ?? `${context.attribute}_confirmation`

    return String(context.value) === String(otherValue(context, field))
  },

  accepted: ({ value }) => TRUTHY.has(value as never),

  declined: ({ value }) => FALSY.has(value as never),

  accepted_if: (context) => {
    const [field, ...values] = context.params

    return values.includes(String(otherValue(context, field)))
      ? TRUTHY.has(context.value as never)
      : true
  },

  declined_if: (context) => {
    const [field, ...values] = context.params

    return values.includes(String(otherValue(context, field)))
      ? FALSY.has(context.value as never)
      : true
  },

  after: (context) => toDate(context.value) > dateBoundary(context, context.params[0]),

  after_or_equal: (context) => toDate(context.value) >= dateBoundary(context, context.params[0]),

  before: (context) => toDate(context.value) < dateBoundary(context, context.params[0]),

  before_or_equal: (context) => toDate(context.value) <= dateBoundary(context, context.params[0]),

  date_equals: (context) => toDate(context.value) === dateBoundary(context, context.params[0]),

  // -- database ------------------------------------------------------------
  /**
   * `unique:table,column,ignoreId,idColumn` — passes when no other row matches.
   * The rule object form adds `->ignore()` and extra `where` constraints.
   */
  unique: async (context) => {
    const verifier = requireVerifier(context, 'unique')
    const rule = context.rule instanceof UniqueRule ? context.rule : undefined

    const table = rule?.table ?? (context.params[0] as string)
    const column = rule?.column ?? context.params[1] ?? context.attribute

    const ignore = rule
      ? rule.ignoring()
      : context.params[2] !== undefined
        ? { id: context.params[2], column: context.params[3] ?? 'id' }
        : undefined

    const extra = rule ? rule.constraints() : extraConstraints(context.params.slice(4))

    return (await verifier.count(table, column, context.value, ignore, extra)) === 0
  },

  /** `exists:table,column` — every value given must be present. */
  exists: async (context) => {
    const verifier = requireVerifier(context, 'exists')
    const rule = context.rule instanceof ExistsRule ? context.rule : undefined

    const table = rule?.table ?? (context.params[0] as string)
    const column = rule?.column ?? context.params[1] ?? context.attribute
    const extra = rule ? rule.constraints() : extraConstraints(context.params.slice(2))

    const values = Array.isArray(context.value) ? [...new Set(context.value)] : [context.value]
    if (values.length === 0) return true

    return (await verifier.countIn(table, column, values, extra)) >= values.length
  }
}

function requireVerifier(context: RuleContext, rule: string) {
  if (!context.verifier) {
    throw new Error(
      `The [${rule}] rule needs a database. Register DatabaseServiceProvider, or pass a verifier to the Validator.`
    )
  }

  return context.verifier
}

/** `where_column,value` pairs trailing a string rule. */
function extraConstraints(params: string[]): Array<[string, unknown]> {
  const pairs: Array<[string, unknown]> = []

  for (let index = 0; index + 1 < params.length; index += 2) {
    pairs.push([params[index] as string, params[index + 1]])
  }

  return pairs
}

/** `/pattern/flags` or a bare pattern. */
function buildRegExp(pattern: string): RegExp {
  const delimited = /^\/(.*)\/([gimsuy]*)$/s.exec(pattern)

  return delimited ? new RegExp(delimited[1] as string, delimited[2]) : new RegExp(pattern)
}
