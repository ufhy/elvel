import { afterEach, describe, expect, test } from 'bun:test'
import { collect } from '../src/collection.ts'
import { Paginator, Paginators, SimplePaginator } from '../src/paginator.ts'

function page<T>(items: T[], total: number, current = 1, perPage = 3): Paginator<T> {
  return new Paginator(collect(items), total, perPage, current, { path: '/articles' })
}

afterEach(() => {
  Paginators.resolveCurrentPathUsing(() => '/')
  Paginators.resolveQueryStringUsing(() => ({}))
  Paginators.resolveCurrentPageUsing(() => 1)
})

describe('a page knows its own URLs', () => {
  const second = page([4, 5, 6], 10, 2)

  test('url, next and previous', () => {
    expect(second.url(1)).toBe('/articles?page=1')
    expect(second.nextPageUrl()).toBe('/articles?page=3')
    expect(second.previousPageUrl()).toBe('/articles?page=1')
  })

  test('first and last', () => {
    expect(second.firstPageUrl()).toBe('/articles?page=1')
    expect(second.lastPageUrl()).toBe('/articles?page=4')
  })

  test('the ends answer with null, not a URL that goes nowhere', () => {
    expect(page([1, 2, 3], 3).previousPageUrl()).toBeNull()
    expect(page([1, 2, 3], 3).nextPageUrl()).toBeNull()
  })

  test('a fragment travels with them', () => {
    const anchored = new Paginator(collect([1]), 10, 3, 2, { path: '/a', fragment: 'list' })

    expect(anchored.url(2)).toBe('/a?page=2#list')
  })
})

describe('where the page sits', () => {
  test('hasMorePages, onFirstPage and onLastPage', () => {
    expect(page([1, 2, 3], 10, 1).onFirstPage()).toBe(true)
    expect(page([1, 2, 3], 10, 1).hasMorePages()).toBe(true)
    expect(page([1], 10, 4).onLastPage()).toBe(true)
    expect(page([1], 10, 4).hasMorePages()).toBe(false)
  })

  test('firstItem and lastItem count within the whole set', () => {
    const second = page([4, 5, 6], 10, 2)

    expect(second.firstItem()).toBe(4)
    expect(second.lastItem()).toBe(6)
  })

  test('and an empty page has neither', () => {
    const empty = page<number>([], 0)

    expect(empty.firstItem()).toBeNull()
    expect(empty.lastItem()).toBeNull()
    expect(empty.hasPages()).toBe(false)
  })
})

/** The commonest pagination bug there is: paging away drops the filters. */
describe('the query string', () => {
  test('is carried into every page URL', () => {
    Paginators.resolveQueryStringUsing(() => ({ team: 'a', page: '2' }))

    const filtered = new Paginator(collect([1]), 10, 3, 2, { path: '/articles' })

    expect(filtered.url(3)).toBe('/articles?team=a&page=3')
  })

  test('and the page parameter is never duplicated', () => {
    const filtered = page([1], 10, 2).appends({ page: '9', team: 'b' })

    expect(filtered.url(2)).toBe('/articles?team=b&page=2')
  })

  test('appends drops nothing-values rather than writing "null"', () => {
    expect(page([1], 10).appends({ team: null, sort: undefined }).url(1)).toBe('/articles?page=1')
  })
})

describe('the window a pager renders', () => {
  test('a short list is every page and no gaps', () => {
    const links = page([1], 30, 1).linkCollection()

    expect(links.map((link) => link.label)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10'
    ])
    expect(links[0]?.active).toBe(true)
  })

  test('a long one keeps the ends and the neighbours', () => {
    const links = new Paginator(collect([1]), 200, 3, 30, { path: '/a' }).linkCollection(1)

    expect(links.map((link) => link.label)).toEqual(['1', '...', '29', '30', '31', '...', '67'])
  })

  test('and the gap has no URL to click', () => {
    const links = new Paginator(collect([1]), 200, 3, 30, { path: '/a' }).linkCollection(1)

    expect(links[1]?.url).toBeNull()
  })

  test('getUrlRange is the raw form of the same thing', () => {
    expect(page([1], 30, 1).getUrlRange(2, 3)).toEqual({
      2: '/articles?page=2',
      3: '/articles?page=3'
    })
  })
})

describe('through', () => {
  test('maps the items without losing the page around them', () => {
    const mapped = page([1, 2, 3], 10, 2).through((item) => item * 10)

    expect(mapped.items().all()).toEqual([10, 20, 30])
    expect(mapped.currentPage).toBe(2)
    expect(mapped.nextPageUrl()).toBe('/articles?page=3')
  })
})

/** The shape every JavaScript client library already understands. */
describe('serialising', () => {
  test('data, links and meta', () => {
    expect(page([4, 5, 6], 10, 2).toJSON()).toEqual({
      data: [4, 5, 6],
      links: {
        first: '/articles?page=1',
        last: '/articles?page=4',
        prev: '/articles?page=1',
        next: '/articles?page=3'
      },
      meta: {
        current_page: 2,
        from: 4,
        last_page: 4,
        path: '/articles',
        per_page: 3,
        to: 6,
        total: 10
      }
    })
  })
})

describe('a simple page', () => {
  const simple = (more: boolean, current = 1) =>
    new SimplePaginator(collect([1, 2, 3]), 3, current, more, { path: '/articles' })

  test('answers only whether there is another one', () => {
    expect(simple(true).hasMorePages()).toBe(true)
    expect(simple(true).nextPageUrl()).toBe('/articles?page=2')
    expect(simple(false).nextPageUrl()).toBeNull()
  })

  test('and its meta carries no total, because it never counted', () => {
    expect(simple(true, 2).toJSON()).toEqual({
      data: [1, 2, 3],
      links: { prev: '/articles?page=1', next: '/articles?page=3' },
      meta: { current_page: 2, from: 4, path: '/articles', per_page: 3, to: 6 }
    })
  })
})

describe('the current page', () => {
  test('comes from the request when nobody passed one', () => {
    Paginators.resolveCurrentPageUsing(() => 7)

    expect(Paginators.currentPage()).toBe(7)
  })

  test('and anything that is not a page number is page one', () => {
    Paginators.resolveCurrentPageUsing(() => Number.NaN)

    expect(Paginators.currentPage()).toBe(1)
  })
})
