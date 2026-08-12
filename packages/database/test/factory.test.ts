import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { Factory } from '../src/factory.ts'
import { Model } from '../src/model/model.ts'
import { QueryBuilder } from '../src/query/builder.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'
import { Seeder, type SeederContext, SeederRunner } from '../src/seeder.ts'

class Widget extends Model {
  static override table = 'widgets'
  static override fillable = ['label', 'active', 'weight']

  declare id: number
  declare label: string
  declare active: boolean
  declare weight: number
}

class WidgetFactory extends Factory<Widget> {
  readonly model = Widget

  definition(index: number) {
    return { label: `Widget ${index}`, active: 1, weight: index }
  }
}

let connection: BunSqlConnection

beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })
  Model.setConnectionResolver(async () => connection)
  Model.setEventDispatcher(undefined)

  await new SchemaBuilder(connection).create('widgets', (table) => {
    table.id()
    table.string('label')
    table.boolean('active').default(true)
    table.integer('weight').default(0)
    table.timestamps()
  })
})

afterEach(async () => {
  await connection.disconnect()
})

describe('Factory', () => {
  test('raw() produces attribute sets without touching the database', async () => {
    const rows = await new WidgetFactory().count(2).raw()

    expect(rows).toEqual([
      { label: 'Widget 0', active: 1, weight: 0 },
      { label: 'Widget 1', active: 1, weight: 1 }
    ])
    expect(await new QueryBuilder(connection, 'widgets').count()).toBe(0)
  })

  test('make() builds unsaved models', async () => {
    const widgets = await new WidgetFactory().count(3).make()

    expect(widgets.count()).toBe(3)
    expect(widgets.first()).toBeInstanceOf(Widget)
    expect(widgets.first()?.exists).toBe(false)
    expect(await Widget.query().count()).toBe(0)
  })

  test('create() saves them', async () => {
    const widgets = await new WidgetFactory().count(3).create()

    expect(await Widget.query().count()).toBe(3)
    expect(widgets.pluck('label').all()).toEqual(['Widget 0', 'Widget 1', 'Widget 2'])
  })

  test('the index makes values unique, so a unique index cannot collide', async () => {
    await new SchemaBuilder(connection).table('widgets', (table) => {
      table.unique(['label'])
    })

    // A random source would collide roughly one run in fifty at this size.
    await new WidgetFactory().count(25).create()

    expect(await Widget.query().count()).toBe(25)
  })

  test('state layers attributes over the definition', async () => {
    const widgets = await new WidgetFactory()
      .count(2)
      .state({ active: 0 })
      .state((attributes, index) => ({ label: `${attributes.label} #${index}` }))
      .create()

    expect(widgets.first()?.attributes.active).toBe(0)
    expect(widgets.first()?.label).toBe('Widget 0 #0')
  })

  test('with() wins over the definition and every state', async () => {
    const widgets = await new WidgetFactory()
      .count(1)
      .state({ label: 'from state' })
      .with({
        label: 'from with'
      })
      .create()

    expect(widgets.first()?.label).toBe('from with')
  })

  test('createOne returns a single saved model', async () => {
    const widget = await new WidgetFactory().createOne({ label: 'Only' })

    expect(widget.label).toBe('Only')
    expect(widget.exists).toBe(true)
    expect(await Widget.query().count()).toBe(1)
  })

  test('count(0) produces nothing', async () => {
    expect((await new WidgetFactory().count(0).create()).count()).toBe(0)
  })

  test('factories bypass fillable, so a factory can set anything', async () => {
    class Guarded extends Model {
      static override table = 'widgets'
      // Nothing is fillable, yet the factory must still be able to build a row.
      declare label: string
    }

    class GuardedFactory extends Factory<Guarded> {
      readonly model = Guarded
      definition() {
        return { label: 'forced' }
      }
    }

    const model = await new GuardedFactory().createOne()

    expect(model.label).toBe('forced')
  })
})

describe('Seeder', () => {
  test('run() executes and reports', async () => {
    const notes: string[] = []

    class WidgetSeeder extends Seeder {
      async run({ table }: SeederContext) {
        await table('widgets').insert({ label: 'Seeded' })
      }
    }

    await new SeederRunner(connection, { onNote: (note) => notes.push(note) }).run(WidgetSeeder)

    expect(await Widget.query().count()).toBe(1)
    expect(notes).toContain('Seeded WidgetSeeder.')
  })

  test('call() composes, and a shared seeder runs once', async () => {
    const order: string[] = []

    class Shared extends Seeder {
      run() {
        order.push('shared')
      }
    }
    class First extends Seeder {
      async run({ call }: SeederContext) {
        order.push('first')
        await call(Shared)
      }
    }
    class Second extends Seeder {
      async run({ call }: SeederContext) {
        order.push('second')
        await call(Shared)
      }
    }
    class Root extends Seeder {
      async run({ call }: SeederContext) {
        await call(First, Second)
      }
    }

    await new SeederRunner(connection).run(Root)

    // `shared` appears once even though two seeders asked for it.
    expect(order).toEqual(['first', 'shared', 'second'])
  })

  test('a seeder can use factories', async () => {
    class FactorySeeder extends Seeder {
      async run() {
        await new WidgetFactory().count(4).create()
      }
    }

    await new SeederRunner(connection).run(FactorySeeder)

    expect(await Widget.query().count()).toBe(4)
  })
})
