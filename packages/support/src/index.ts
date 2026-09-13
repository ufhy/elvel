import { Str as StrMethods } from './str.ts'
import { of as stringableOf } from './stringable.ts'

export { Arr, type ArrMacros, ArrTypeError } from './arr.ts'
export { Lottery, Timebox, timebox } from './chance.ts'
export { Clock } from './clock.ts'
export {
  Collection,
  collect,
  ItemNotFoundError,
  MultipleItemsFoundError
} from './collection.ts'
export {
  blank,
  classBasename,
  filled,
  head,
  type Lazy,
  last,
  type RescueOptions,
  type RetryOptions,
  reportRescuedUsing,
  rescue,
  retry,
  tap,
  throwIf,
  throwUnless,
  transform,
  value
} from './helpers.ts'
export { type Key, KeyedCollection, keyed } from './keyed.ts'
export { LazyCollection, lazy, type Source } from './lazy.ts'
export { type Macro, Macroable, type Macroed, macroable } from './macroable.ts'
export {
  defaultCurrency,
  defaultLocale,
  type FormatOptions,
  Number,
  useCurrency,
  useLocale,
  withCurrency,
  withLocale
} from './number.ts'
export {
  type Next,
  type Pipe,
  type PipeFunction,
  Pipehub,
  Pipeline,
  type PipeObject,
  type PipeResolver
} from './pipeline.ts'
export {
  amzDate,
  type Credentials,
  canonicalRequest,
  type SigningRequest,
  signingKey,
  signRequest,
  stringToSign,
  uriEncode
} from './sigv4.ts'
export { PendingSleep, Sleep, SleepAssertionError } from './sleep.ts'

import { type Macroed, macroable } from './macroable.ts'

export { of, type Stringable, StringableBase } from './stringable.ts'

/**
 * The string helpers, with `of` merged on.
 *
 * Merged here rather than declared inside `str.ts` so the type does not refer
 * to itself: `Stringable` is projected from `typeof StrMethods`, and a `Str`
 * that already carried `of` would be defined in terms of its own projection.
 * TypeScript answers `any` to that, silently.
 */
export type StrMacros = {}

export const Str: typeof StrMethods & { of: typeof stringableOf } & Macroed & StrMacros = macroable(
  { ...StrMethods, of: stringableOf }
)
export { Conditionable } from './traits.ts'
export { isAscii, transliterate } from './transliterate.ts'
