/**
 * Message catalogue, worded as Laravel's `lang/en/validation.php`.
 *
 * Size rules carry one message per value type, because "must be at least 3"
 * means characters for a string, items for an array, and a magnitude for a
 * number — collapsing them produces sentences that are subtly wrong.
 */
export type SizeMessages = { numeric: string; string: string; array: string }

export const MESSAGES: Record<string, string | SizeMessages> = {
  accepted: 'The :attribute field must be accepted.',
  accepted_if: 'The :attribute field must be accepted when :other is :value.',
  after: 'The :attribute field must be a date after :date.',
  after_or_equal: 'The :attribute field must be a date after or equal to :date.',
  alpha: 'The :attribute field must only contain letters.',
  alpha_dash: 'The :attribute field must only contain letters, numbers, dashes, and underscores.',
  alpha_num: 'The :attribute field must only contain letters and numbers.',
  array: 'The :attribute field must be an array.',
  between: {
    numeric: 'The :attribute field must be between :min and :max.',
    string: 'The :attribute field must be between :min and :max characters.',
    array: 'The :attribute field must have between :min and :max items.'
  },
  boolean: 'The :attribute field must be true or false.',
  confirmed: 'The :attribute field confirmation does not match.',
  date: 'The :attribute field must be a valid date.',
  date_equals: 'The :attribute field must be a date equal to :date.',
  decimal: 'The :attribute field must have :decimal decimal places.',
  declined: 'The :attribute field must be declined.',
  declined_if: 'The :attribute field must be declined when :other is :value.',
  different: 'The :attribute field and :other must be different.',
  digits: 'The :attribute field must be :digits digits.',
  digits_between: 'The :attribute field must be between :min and :max digits.',
  email: 'The :attribute field must be a valid email address.',
  ends_with: 'The :attribute field must end with one of the following: :values.',
  exists: 'The selected :attribute is invalid.',
  filled: 'The :attribute field must have a value.',
  gt: {
    numeric: 'The :attribute field must be greater than :value.',
    string: 'The :attribute field must be greater than :value characters.',
    array: 'The :attribute field must have more than :value items.'
  },
  gte: {
    numeric: 'The :attribute field must be greater than or equal to :value.',
    string: 'The :attribute field must be greater than or equal to :value characters.',
    array: 'The :attribute field must have :value items or more.'
  },
  in: 'The selected :attribute is invalid.',
  in_array: 'The :attribute field must exist in :other.',
  integer: 'The :attribute field must be an integer.',
  ip: 'The :attribute field must be a valid IP address.',
  json: 'The :attribute field must be a valid JSON string.',
  lowercase: 'The :attribute field must be lowercase.',
  lt: {
    numeric: 'The :attribute field must be less than :value.',
    string: 'The :attribute field must be less than :value characters.',
    array: 'The :attribute field must have less than :value items.'
  },
  lte: {
    numeric: 'The :attribute field must be less than or equal to :value.',
    string: 'The :attribute field must be less than or equal to :value characters.',
    array: 'The :attribute field must not have more than :value items.'
  },
  max: {
    numeric: 'The :attribute field must not be greater than :max.',
    string: 'The :attribute field must not be greater than :max characters.',
    array: 'The :attribute field must not have more than :max items.'
  },
  min: {
    numeric: 'The :attribute field must be at least :min.',
    string: 'The :attribute field must be at least :min characters.',
    array: 'The :attribute field must have at least :min items.'
  },
  missing: 'The :attribute field must be missing.',
  not_in: 'The selected :attribute is invalid.',
  not_regex: 'The :attribute field format is invalid.',
  numeric: 'The :attribute field must be a number.',
  present: 'The :attribute field must be present.',
  prohibited: 'The :attribute field is prohibited.',
  prohibited_if: 'The :attribute field is prohibited when :other is :value.',
  prohibits: 'The :attribute field prohibits :other from being present.',
  regex: 'The :attribute field format is invalid.',
  required: 'The :attribute field is required.',
  required_if: 'The :attribute field is required when :other is :value.',
  required_if_accepted: 'The :attribute field is required when :other is accepted.',
  required_unless: 'The :attribute field is required unless :other is in :values.',
  required_with: 'The :attribute field is required when :values is present.',
  required_with_all: 'The :attribute field is required when :values are present.',
  required_without: 'The :attribute field is required when :values is not present.',
  required_without_all: 'The :attribute field is required when none of :values are present.',
  same: 'The :attribute field must match :other.',
  size: {
    numeric: 'The :attribute field must be :size.',
    string: 'The :attribute field must be :size characters.',
    array: 'The :attribute field must contain :size items.'
  },
  starts_with: 'The :attribute field must start with one of the following: :values.',
  string: 'The :attribute field must be a string.',
  unique: 'The :attribute has already been taken.',
  uppercase: 'The :attribute field must be uppercase.',
  url: 'The :attribute field must be a valid URL.',
  uuid: 'The :attribute field must be a valid UUID.',

  // Phase one — TypeBox reports a shape mismatch rather than a named rule.
  schema: 'The :attribute field is invalid.'
}

/** `first_name` -> `first name`, matching Laravel's default attribute naming. */
export function humanizeAttribute(attribute: string): string {
  return attribute
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .join(' ')
    .replaceAll('_', ' ')
}

export type ValueType = 'numeric' | 'string' | 'array'

/** Which size message applies, decided by the value rather than by the rule. */
export function typeOf(value: unknown, hasNumericRule = false): ValueType {
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' || hasNumericRule) return 'numeric'

  return 'string'
}

export function resolveMessage(
  rule: string,
  type: ValueType,
  custom: Record<string, string> = {}
): string {
  const specific = custom[rule]
  if (specific) return specific

  const template = MESSAGES[rule]
  if (template === undefined) return `The :attribute field is invalid.`

  return typeof template === 'string' ? template : template[type]
}

/** Substitute `:attribute`, `:other`, `:values`, `:min` and friends. */
export function interpolate(template: string, replacements: Record<string, string>): string {
  return template.replace(/:([a-z_]+)/g, (match, key: string) => replacements[key] ?? match)
}
