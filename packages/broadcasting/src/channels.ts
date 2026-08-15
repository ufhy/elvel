/** Who may listen, given the channel's own parameters. */
export type ChannelAuthorizer = (
  user: { id?: unknown } | null,
  parameters: Record<string, string>
) => boolean | Promise<boolean>

/**
 * Who may listen, and what the others should be told about them.
 *
 * A presence channel answers with the member — `{ id, name }`, whatever a client
 * needs to draw a list of who is here — or `null`/`false` to refuse. Laravel
 * uses the same shape, and for the same reason: authorising and identifying are
 * one question, since a member list of people who were not allowed in is not a
 * member list.
 */
export type PresenceAuthorizer = (
  user: { id?: unknown } | null,
  parameters: Record<string, string>
) => Member | null | false | Promise<Member | null | false>

/** One person on a presence channel, as the other members see them. */
export type Member = { id: unknown } & Record<string, unknown>

/**
 * The channels an application declares, and who may join them.
 *
 * A channel name is a pattern — `orders.{id}` — and the callback receives the
 * matched parameters. That shape is what makes authorisation expressible at all:
 * "may this user listen to *this* order" is a different question per order, and
 * a list of literal channel names cannot ask it.
 *
 * A channel nobody declared is **refused**, not allowed. A socket subscribing to
 * a name the server has never heard of is either a bug or a probe, and the
 * failure mode of the other default — broadcasting a private channel to whoever
 * asks — is the one that ends up in an incident report.
 */
export class ChannelRegistry {
  private readonly channels = new Map<string, ChannelAuthorizer>()

  /** Patterns declared with `presence()`, so the broadcaster knows to track. */
  private readonly presenceChannels = new Map<string, PresenceAuthorizer>()

  /**
   * Declare a channel.
   *
   * ```ts
   * channels().channel('orders.{id}', (user, { id }) => user?.id === ownerOf(id))
   * ```
   */
  channel(pattern: string, authorizer: ChannelAuthorizer): this {
    this.channels.set(pattern, authorizer)

    return this
  }

  /** A channel anyone may listen to. Public data still has to say so out loud. */
  public(pattern: string): this {
    return this.channel(pattern, () => true)
  }

  /**
   * Declare a presence channel — one that knows who is on it.
   *
   * ```ts
   * channels().presence('room.{id}', (user) => user && { id: user.id, name: user.name })
   * ```
   *
   * The callback both authorises and identifies: what it returns is what the
   * other members are told, and returning nothing refuses. Everything the
   * members list contains is therefore something the server chose to publish —
   * a presence channel that leaked a user's email would have had to say `email`.
   */
  presence(pattern: string, authorizer: PresenceAuthorizer): this {
    this.presenceChannels.set(pattern, authorizer)

    return this.channel(pattern, async (user, parameters) => {
      const member = await authorizer(user, parameters)

      return member !== null && member !== false
    })
  }

  /** Is this channel a presence channel? */
  isPresence(name: string): boolean {
    return this.presenceFor(name) !== undefined
  }

  /**
   * The member this user joins as, or nothing when they may not join.
   *
   * Asked separately from `authorize` rather than returned by it: the two have
   * different answers for an ordinary channel, where there is no member at all.
   */
  async member(name: string, user: { id?: unknown } | null): Promise<Member | undefined> {
    const matched = this.presenceFor(name)

    if (!matched) return undefined

    try {
      const member = await matched.authorizer(user, matched.parameters)

      return member === null || member === false ? undefined : member
    } catch {
      // As with `authorize`: a callback that throws refuses.
      return undefined
    }
  }

  private presenceFor(
    name: string
  ): { authorizer: PresenceAuthorizer; parameters: Record<string, string> } | undefined {
    for (const [pattern, authorizer] of this.presenceChannels) {
      const parameters = matchChannel(pattern, name)

      if (parameters) return { authorizer, parameters }
    }

    return undefined
  }

  has(name: string): boolean {
    return this.match(name) !== undefined
  }

  /**
   * Every declared pattern, in the order they are matched.
   *
   * Order is what `channel:list` shows and the reason it is worth showing: the
   * first pattern that matches decides, so a broad `{anything}` declared above a
   * specific channel silently takes every authorization the specific one was
   * written for.
   */
  patterns(): string[] {
    return [...this.channels.keys()]
  }

  /**
   * May this user join this channel?
   *
   * The first declared pattern that matches decides — so a specific channel goes
   * above a broad one, the same way route matching reads.
   */
  async authorize(name: string, user: { id?: unknown } | null): Promise<boolean> {
    const matched = this.match(name)

    if (!matched) return false

    try {
      return (await matched.authorizer(user, matched.parameters)) === true
    } catch {
      // An authorizer that throws refuses. Letting the socket in because the
      // check failed is the wrong way round.
      return false
    }
  }

  private match(
    name: string
  ): { authorizer: ChannelAuthorizer; parameters: Record<string, string> } | undefined {
    for (const [pattern, authorizer] of this.channels) {
      const parameters = matchChannel(pattern, name)

      if (parameters) return { authorizer, parameters }
    }

    return undefined
  }
}

/** `orders.{id}` against `orders.7` — the parameters, or undefined. */
export function matchChannel(pattern: string, name: string): Record<string, string> | undefined {
  const keys: string[] = []

  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, (character) =>
      character === '{' || character === '}' ? character : `\\${character}`
    )
    .replace(/\\?\{(\w+)\\?\}/g, (_match, key: string) => {
      keys.push(key)

      // A parameter never spans a dot: `orders.{id}` must not swallow
      // `orders.7.lines`, which is a different channel.
      return '([^.]+)'
    })

  const matched = new RegExp(`^${source}$`).exec(name)

  if (!matched) return undefined

  return Object.fromEntries(keys.map((key, index) => [key, matched[index + 1] as string]))
}
