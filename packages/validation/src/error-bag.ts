/**
 * Validation errors, keyed by attribute.
 *
 * It also remembers which failures came from *implicit* rules, because that is
 * what tells the engine to stop validating an attribute — an absent value should
 * report "required" and nothing else.
 */
export class ErrorBag {
  private readonly bag = new Map<string, string[]>()
  private readonly implicitFailures = new Set<string>()

  add(attribute: string, message: string, implicit = false): this {
    const messages = this.bag.get(attribute) ?? []

    // Duplicate messages read as a bug to the person seeing the form.
    if (!messages.includes(message)) messages.push(message)

    this.bag.set(attribute, messages)
    if (implicit) this.implicitFailures.add(attribute)

    return this
  }

  /**
   * Fold another bag's messages into this one, keeping this one's key order.
   *
   * Attributes are validated concurrently, so their failures arrive in whatever
   * order the slowest rule finished — but a form reports its errors in the order
   * its fields were declared, and `first()` means the first field, not the first
   * database round trip to come back. Each attribute fills its own bag and the
   * bags are merged here in declaration order.
   */
  merge(other: ErrorBag): this {
    for (const [attribute, messages] of other.bag) {
      for (const message of messages) {
        this.add(attribute, message, other.implicitFailures.has(attribute))
      }
    }

    return this
  }

  has(attribute?: string): boolean {
    return attribute === undefined ? this.bag.size > 0 : (this.bag.get(attribute)?.length ?? 0) > 0
  }

  failedImplicit(attribute: string): boolean {
    return this.implicitFailures.has(attribute)
  }

  /** The first message overall, or the first for one attribute. */
  first(attribute?: string): string | undefined {
    if (attribute !== undefined) return this.bag.get(attribute)?.[0]

    for (const messages of this.bag.values()) {
      if (messages[0] !== undefined) return messages[0]
    }

    return undefined
  }

  get(attribute: string): string[] {
    return [...(this.bag.get(attribute) ?? [])]
  }

  /** Every message, flattened. */
  all(): string[] {
    return [...this.bag.values()].flat()
  }

  /** The shape a JSON 422 response uses: `{ field: [messages] }`. */
  messages(): Record<string, string[]> {
    return Object.fromEntries([...this.bag.entries()].map(([key, value]) => [key, [...value]]))
  }

  keys(): string[] {
    return [...this.bag.keys()]
  }

  count(): number {
    return this.all().length
  }

  isEmpty(): boolean {
    return this.bag.size === 0
  }

  isNotEmpty(): boolean {
    return !this.isEmpty()
  }

  toJSON(): Record<string, string[]> {
    return this.messages()
  }
}
