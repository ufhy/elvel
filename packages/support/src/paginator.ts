import type { Collection } from './collection.ts'

/** Where a page's URLs are built from, when nothing was set by hand. */
let resolvePath: () => string = () => '/'
let resolveQuery: () => Record<string, string> = () => ({})
let resolvePage: (name: string) => number = () => 1

/**
 * How a page finds the request it belongs to.
 *
 * A paginator is built in the database layer and rendered in the http one, and
 * neither can import the other. So the http provider hands these over at boot,
 * and the paginator asks rather than reaches — the same shape the validator uses
 * to find the gate.
 */
export const Paginators = {
  resolveCurrentPathUsing(resolver: () => string): void {
    resolvePath = resolver
  },

  resolveQueryStringUsing(resolver: () => Record<string, string>): void {
    resolveQuery = resolver
  },

  resolveCurrentPageUsing(resolver: (name: string) => number): void {
    resolvePage = resolver
  },

  /** The page the request asked for, or 1. */
  currentPage(name = 'page'): number {
    const page = resolvePage(name)

    return Number.isInteger(page) && page > 0 ? page : 1
  },

  path(): string {
    return resolvePath()
  },

  query(): Record<string, string> {
    return resolveQuery()
  }
}

/** One entry in the rendered page list: a page, or the gap between two runs. */
export type PageLink = {
  url: string | null
  label: string
  active: boolean
}

export type PaginatorOptions = {
  path?: string
  query?: Record<string, string>
  fragment?: string
  pageName?: string
}

/** What both paginators share: the items, the window, and the URLs. */
abstract class BasePaginator<T> {
  protected path_: string
  protected query_: Record<string, string>
  protected fragment_: string | undefined
  protected readonly pageName: string

  constructor(
    readonly data: Collection<T>,
    readonly perPage: number,
    readonly currentPage: number,
    options: PaginatorOptions = {}
  ) {
    this.path_ = options.path ?? Paginators.path()
    this.query_ = { ...Paginators.query(), ...options.query }
    this.fragment_ = options.fragment
    this.pageName = options.pageName ?? 'page'

    delete this.query_[this.pageName]
  }

  /** The items themselves, for a caller that wants the list and not the page. */
  items(): Collection<T> {
    return this.data
  }

  count(): number {
    return this.data.count()
  }

  isEmpty(): boolean {
    return this.data.count() === 0
  }

  isNotEmpty(): boolean {
    return this.data.count() > 0
  }

  /** Where in the whole set this page's first and last item sit. */
  firstItem(): number | null {
    return this.count() === 0 ? null : (this.currentPage - 1) * this.perPage + 1
  }

  lastItem(): number | null {
    const first = this.firstItem()

    return first === null ? null : first + this.count() - 1
  }

  onFirstPage(): boolean {
    return this.currentPage <= 1
  }

  abstract hasMorePages(): boolean

  hasPages(): boolean {
    return this.currentPage > 1 || this.hasMorePages()
  }

  setPath(path: string): this {
    this.path_ = path

    return this
  }

  path(): string {
    return this.path_
  }

  /** Extra query parameters every page URL carries. */
  appends(values: Record<string, string | number | undefined | null>): this {
    for (const [key, value] of Object.entries(values)) {
      if (key === this.pageName || value === undefined || value === null) continue

      this.query_[key] = String(value)
    }

    return this
  }

  /**
   * Carry the request's own query string into every page URL.
   *
   * Without it, paging away from a filtered list drops the filters — the
   * commonest pagination bug there is. On by default for that reason; this exists
   * to say so explicitly, and to re-read the query after `setPath`.
   */
  withQueryString(): this {
    return this.appends(Paginators.query())
  }

  fragment(value?: string): this | string | undefined {
    if (value === undefined) return this.fragment_

    this.fragment_ = value

    return this
  }

  /** The URL for a page number, whether or not that page exists. */
  url(page: number): string {
    const parameters = new URLSearchParams(this.query_)
    parameters.set(this.pageName, String(Math.max(1, page)))

    const search = parameters.toString()
    const hash = this.fragment_ === undefined ? '' : `#${this.fragment_}`

    return `${this.path_}${search === '' ? '' : `?${search}`}${hash}`
  }

  nextPageUrl(): string | null {
    return this.hasMorePages() ? this.url(this.currentPage + 1) : null
  }

  previousPageUrl(): string | null {
    return this.currentPage > 1 ? this.url(this.currentPage - 1) : null
  }

  /** Map the items without losing the page around them. */
  through<U>(callback: (item: T, index: number) => U): BasePaginator<U> {
    const mapped = this.clone(this.data.map(callback))

    return mapped
  }

  protected abstract clone<U>(data: Collection<U>): BasePaginator<U>

  protected options(): PaginatorOptions {
    return {
      path: this.path_,
      query: this.query_,
      fragment: this.fragment_,
      pageName: this.pageName
    }
  }
}

/**
 * A numbered page: it knows the total, so it knows the last page.
 *
 * The count costs a query over the whole filtered set. `SimplePaginator` is the
 * answer when a Previous/Next control is all the UI has.
 */
export class Paginator<T> extends BasePaginator<T> {
  constructor(
    data: Collection<T>,
    readonly total: number,
    perPage: number,
    currentPage: number,
    options: PaginatorOptions = {}
  ) {
    super(data, perPage, currentPage, options)
  }

  get lastPage(): number {
    return Math.max(1, Math.ceil(this.total / this.perPage))
  }

  hasMorePages(): boolean {
    return this.currentPage < this.lastPage
  }

  onLastPage(): boolean {
    return this.currentPage >= this.lastPage
  }

  firstPageUrl(): string {
    return this.url(1)
  }

  lastPageUrl(): string {
    return this.url(this.lastPage)
  }

  /** Every page number in a range, for a caller rendering its own control. */
  getUrlRange(start: number, end: number): Record<number, string> {
    const out: Record<number, string> = {}

    for (let page = start; page <= end; page += 1) out[page] = this.url(page)

    return out
  }

  /**
   * The window a pager actually renders: `1 … 4 5 6 … 20`.
   *
   * `onEachSide` is how many neighbours the current page keeps. A null entry is
   * the gap, which the caller renders as an ellipsis. Small page counts return
   * every page and no gaps, because a window narrower than the list is noise.
   */
  linkCollection(onEachSide = 3): PageLink[] {
    const last = this.lastPage
    const link = (page: number): PageLink => ({
      url: this.url(page),
      label: String(page),
      active: page === this.currentPage
    })

    const gap: PageLink = { url: null, label: '...', active: false }

    if (last <= onEachSide * 2 + 5) {
      return Array.from({ length: last }, (_, index) => link(index + 1))
    }

    const from = Math.max(2, this.currentPage - onEachSide)
    const to = Math.min(last - 1, this.currentPage + onEachSide)

    const middle: PageLink[] = []

    for (let page = from; page <= to; page += 1) middle.push(link(page))

    return [
      link(1),
      ...(from > 2 ? [gap] : []),
      ...middle,
      ...(to < last - 1 ? [gap] : []),
      link(last)
    ]
  }

  /** The shape every JavaScript client library already understands. */
  toJSON(): Record<string, unknown> {
    return {
      data: this.data.all(),
      links: {
        first: this.firstPageUrl(),
        last: this.lastPageUrl(),
        prev: this.previousPageUrl(),
        next: this.nextPageUrl()
      },
      meta: this.meta()
    }
  }

  meta(): Record<string, unknown> {
    return {
      current_page: this.currentPage,
      from: this.firstItem(),
      last_page: this.lastPage,
      path: this.path_,
      per_page: this.perPage,
      to: this.lastItem(),
      total: this.total
    }
  }

  protected clone<U>(data: Collection<U>): Paginator<U> {
    return new Paginator(data, this.total, this.perPage, this.currentPage, this.options())
  }
}

/**
 * A page that knows only whether there is another one.
 *
 * One query instead of two: `perPage + 1` rows are fetched and the extra one is
 * dropped, which is the whole difference. On a large filtered table the count
 * the numbered paginator pays for is usually the slower of its two queries.
 */
export class SimplePaginator<T> extends BasePaginator<T> {
  constructor(
    data: Collection<T>,
    perPage: number,
    currentPage: number,
    private readonly more: boolean,
    options: PaginatorOptions = {}
  ) {
    super(data, perPage, currentPage, options)
  }

  hasMorePages(): boolean {
    return this.more
  }

  toJSON(): Record<string, unknown> {
    return {
      data: this.data.all(),
      links: {
        prev: this.previousPageUrl(),
        next: this.nextPageUrl()
      },
      meta: this.meta()
    }
  }

  meta(): Record<string, unknown> {
    return {
      current_page: this.currentPage,
      from: this.firstItem(),
      path: this.path_,
      per_page: this.perPage,
      to: this.lastItem()
    }
  }

  protected clone<U>(data: Collection<U>): SimplePaginator<U> {
    return new SimplePaginator(data, this.perPage, this.currentPage, this.more, this.options())
  }
}
