/**
 * The three Blade directives JSX has no answer for.
 *
 * Most of Blade's directive set is a workaround for PHP-in-HTML that TSX makes
 * unnecessary: `@if` is a ternary, `@foreach` is `.map()`, `@include` is a
 * component, `@checked` is `checked={…}`, and `{{ }}`'s escaping is the `safe`
 * attribute. What is left is the handful where the *string being built* needs
 * rules of its own — a class list assembled from conditions, a style attribute,
 * and data embedded in a `<script>` tag, which is the one with teeth.
 */

/** What `classes()` and `styles()` accept: a string, or a condition per key. */
export type ClassInput = string | false | null | undefined | Record<string, unknown>

/**
 * Build a class attribute from strings and conditions — Blade's `@class`.
 *
 * ```tsx
 * <div class={classes('card', { 'card--wide': wide, 'is-active': active })} />
 * ```
 *
 * Plain strings are always included; an object contributes each key whose value
 * is truthy. Written by hand this becomes `[a, b && c].filter(Boolean).join(' ')`
 * every time, and the hand-written version is where a stray `false` ends up
 * rendered into the markup as the word "false".
 */
export function classes(...inputs: ClassInput[]): string {
  const names: string[] = []

  for (const input of inputs) {
    if (!input) continue

    if (typeof input === 'string') {
      names.push(input)

      continue
    }

    for (const [name, condition] of Object.entries(input)) {
      if (condition) names.push(name)
    }
  }

  // Joined as they were given, which is what `Arr::toCssClasses` does. An
  // earlier version here deduplicated; that reads like an improvement and is a
  // difference from Laravel for no reason, and the day somebody relies on a
  // class appearing twice — a CSS-in-JS scheme keyed by occurrence, a test that
  // counts them — it is a difference nobody wrote down.
  return names.join(' ')
}

/**
 * Build a style attribute the same way — Blade's `@style`.
 *
 * ```tsx
 * <div style={styles('color: red', { 'font-weight: bold': isImportant })} />
 * ```
 *
 * Declarations are separated by `;`, and a trailing one is added so appending
 * another later cannot silently merge two properties into one.
 */
export function styles(...inputs: ClassInput[]): string {
  const declarations: string[] = []

  for (const input of inputs) {
    if (!input) continue

    if (typeof input === 'string') {
      declarations.push(input)

      continue
    }

    for (const [declaration, condition] of Object.entries(input)) {
      if (condition) declarations.push(declaration)
    }
  }

  const written = declarations
    .flatMap((declaration) => declaration.split(';'))
    .map((declaration) => declaration.trim())
    .filter(Boolean)

  return written.length === 0 ? '' : `${written.join('; ')};`
}

/**
 * Embed a value in a `<script>` tag safely — Blade's `@json` and `@js`.
 *
 * ```tsx
 * <script>{`window.__STATE__ = ${json(state)}`}</script>
 * ```
 *
 * The escaping is the entire point, and it is not the escaping HTML needs. Inside
 * a `<script>` the parser is looking for the literal characters `</script`, so a
 * value containing one ends the block early and everything after it is markup
 * again — `{"bio": "</script><img onerror=…>"}` is a working XSS through a field
 * that never touched the HTML escaper, because JSON.stringify has no reason to
 * care. `<!--` opens an HTML comment for the same reason.
 *
 * The set is Laravel's: `@json` encodes with `JSON_HEX_TAG | JSON_HEX_APOS |
 * JSON_HEX_AMP | JSON_HEX_QUOT`, which is `<` `>` `&` `'` `"`. The quotes are
 * what make the result safe in an *attribute* as well as in a script body —
 * `<button data-user='{json(user)}'>` does not need a second helper. Only the
 * quotes inside strings are touched: after `JSON.stringify` a `"` that belongs
 * to the data is written `\"`, and the bare ones are structure.
 *
 * U+2028 and U+2029 are escaped as well. PHP gets this for nothing, since
 * `json_encode` escapes every non-ASCII character by default; here they have to
 * be named. They are valid in JSON strings and are line terminators in
 * JavaScript, so leaving them alone produces a syntax error in the page from a
 * value that looks like ordinary text.
 */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replaceAll('\\"', '\\u0022')
    .replaceAll("'", '\\u0027')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}
