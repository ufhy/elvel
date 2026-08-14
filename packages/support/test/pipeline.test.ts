import { describe, expect, test } from 'bun:test'
import { Pipehub, Pipeline } from '../src/index.ts'

describe('Pipeline', () => {
  test('runs stages in the order they were given', async () => {
    const order: string[] = []

    const result = await new Pipeline<string>()
      .send('start')
      .through([
        async (value, next) => {
          order.push('first in')
          const out = await next(`${value}>a`)
          order.push('first out')

          return out
        },
        async (value, next) => {
          order.push('second in')

          return next(`${value}>b`)
        }
      ])
      .then((value) => {
        order.push('destination')

        return `${value}>end`
      })

    expect(result).toBe('start>a>b>end')
    // Outermost first on the way in, last on the way out — an onion, not a list.
    expect<string[]>(order).toEqual(['first in', 'second in', 'destination', 'first out'])
  })

  test('a stage can answer without calling next', async () => {
    const reached: string[] = []

    const result = await new Pipeline<string>()
      .send('request')
      .through([
        async () => 'cached',
        async (value, next) => {
          reached.push('never')

          return next(value)
        }
      ])
      .then(() => {
        reached.push('destination')

        return 'handled'
      })

    expect(result).toBe('cached')
    // Short-circuiting is the point: nothing downstream ran.
    expect<string[]>(reached).toEqual([])
  })

  test('a stage can work after the rest has finished', async () => {
    const result = await new Pipeline<number>()
      .send(2)
      .through([async (value, next) => (await next(value)) * 10])
      .then((value) => value + 1)

    expect(result).toBe(30)
  })

  test('no stages at all is just the destination', async () => {
    expect(
      await new Pipeline<number>()
        .send(5)
        .through([])
        .then((value) => value * 2)
    ).toBe(10)
  })

  test('thenReturn hands back what came out of the last stage', async () => {
    const result = await new Pipeline<string>()
      .send('a')
      .through([(value, next) => next(`${value}b`), (value, next) => next(`${value}c`)])
      .thenReturn()

    expect(result).toBe('abc')
  })

  test('pipe() appends without replacing', async () => {
    const result = await new Pipeline<string>()
      .send('')
      .through([(value, next) => next(`${value}1`)])
      .pipe(
        (value, next) => next(`${value}2`),
        (value, next) => next(`${value}3`)
      )
      .thenReturn()

    expect(result).toBe('123')
  })
})

describe('object stages', () => {
  test('are called through handle', async () => {
    const stage = {
      handle: (value: string, next: (value: string) => Promise<string>) => next(`${value}!`)
    }

    expect(await new Pipeline<string>().send('hi').through([stage]).thenReturn()).toBe('hi!')
  })

  test('via() names a different method', async () => {
    const stage = {
      transform: (value: string, next: (value: string) => Promise<string>) => next(`${value}?`)
    }

    expect(
      await new Pipeline<string>().send('hi').through([stage]).via('transform').thenReturn()
    ).toBe('hi?')
  })

  test('a missing method says what to do about it', async () => {
    const stage = { somethingElse: () => Promise.resolve('x') }

    await expect(new Pipeline<string>().send('hi').through([stage]).thenReturn()).rejects.toThrow(
      /has no \[handle\] method/
    )
  })
})

describe('named stages', () => {
  test('are found through the resolver', async () => {
    const registry: Record<
      string,
      (value: string, next: (v: string) => Promise<string>) => Promise<string>
    > = {
      shout: (value, next) => next(value.toUpperCase())
    }

    const result = await new Pipeline<string>((name) => registry[name] as never)
      .send('quiet')
      .through(['shout'])
      .thenReturn()

    expect(result).toBe('QUIET')
  })

  test('without a resolver, the error says so', async () => {
    await expect(
      new Pipeline<string>().send('x').through(['somewhere']).thenReturn()
    ).rejects.toThrow(/no resolver/)
  })
})

describe('finally', () => {
  test('runs after a successful pipeline', async () => {
    const seen: string[] = []

    await new Pipeline<string>()
      .send('x')
      .through([(value, next) => next(value)])
      .finally((value) => {
        seen.push(`cleaned ${value}`)
      })
      .then(() => 'done')

    expect<string[]>(seen).toEqual(['cleaned x'])
  })

  test('runs when a stage throws, and the throw still escapes', async () => {
    const seen: string[] = []

    await expect(
      new Pipeline<string>()
        .send('x')
        .through([
          () => {
            throw new Error('boom')
          }
        ])
        .finally(() => {
          seen.push('cleaned')
        })
        .then(() => 'done')
    ).rejects.toThrow('boom')

    // The reason it exists: a lock taken before the pipeline must be released.
    expect<string[]>(seen).toEqual(['cleaned'])
  })
})

describe('Pipehub', () => {
  test('runs a pipeline by name', async () => {
    const hub = new Pipehub()

    hub.pipeline<string>('slug', (pipeline, passable) =>
      pipeline
        .send(passable)
        .through([
          (value, next) => next(value.trim().toLowerCase()),
          (value, next) => next(value.replace(/\s+/g, '-'))
        ])
        .thenReturn()
    )

    expect(hub.has('slug')).toBe(true)
    expect(await hub.pipe<string>('  Hello There  ', 'slug')).toBe('hello-there')
  })

  test('an undefined pipeline says how to define one', async () => {
    await expect(new Pipehub().pipe('x', 'missing')).rejects.toThrow(
      /is not defined.*pipeline\(\)/s
    )
  })
})
