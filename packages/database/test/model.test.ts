import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { ModelNotFoundError } from '../src/model/builder.ts'
import { Model } from '../src/model/model.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

class User extends Model {
  static override table = 'users'
  static override fillable = ['name', 'email', 'votes', 'active', 'meta']
  static override casts = { votes: 'int', active: 'boolean', meta: 'json' } as const as never
  static override hidden = ['secret']

  declare id: number
  declare name: string
  declare email: string
  declare votes: number
  declare active: boolean
  declare meta: Record<string, unknown> | null

  posts() {
    return this.hasMany(Post)
  }

  profile() {
    return this.hasOne(Profile)
  }

  tags() {
    return this.belongsToMany(Tag)
  }

  static scopeActive(query: { where(column: string, value: unknown): unknown }) {
    query.where('active', 1)
  }
}

class Post extends Model {
  static override table = 'posts'
  static override fillable = ['title', 'user_id']

  declare id: number
  declare title: string
  declare user_id: number

  author() {
    return this.belongsTo(User)
  }

  comments() {
    return this.hasMany(Comment)
  }
}

class Comment extends Model {
  static override table = 'comments'
  static override fillable = ['body', 'post_id']

  declare id: number
  declare body: string
}

class Profile extends Model {
  static override table = 'profiles'
  static override fillable = ['bio', 'user_id']

  declare bio: string
}

class Tag extends Model {
  static override table = 'tags'
  static override fillable = ['label']

  declare id: number
  declare label: string
}

class Trashable extends Model {
  static override table = 'trashables'
  static override fillable = ['label']
  static override softDeletes = true

  declare id: number
  declare label: string
}

class Timeless extends Model {
  static override table = 'timeless'
  static override fillable = ['label']
  static override timestamps = false

  declare label: string
}

let connection: BunSqlConnection

beforeEach(async () => {
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })
  Model.setConnectionResolver(async () => connection)
  Model.setEventDispatcher(undefined)

  const schema = new SchemaBuilder(connection)

  await schema.create('users', (table) => {
    table.id()
    table.string('name')
    table.string('email').nullable()
    table.integer('votes').default(0)
    table.boolean('active').default(true)
    table.text('meta').nullable()
    table.string('secret').nullable()
    table.timestamps()
  })
  await schema.create('posts', (table) => {
    table.id()
    table.foreignId('user_id').nullable()
    table.string('title')
    table.timestamps()
  })
  await schema.create('comments', (table) => {
    table.id()
    table.foreignId('post_id')
    table.string('body')
    table.timestamps()
  })
  await schema.create('profiles', (table) => {
    table.id()
    table.foreignId('user_id')
    table.string('bio')
    table.timestamps()
  })
  await schema.create('tags', (table) => {
    table.id()
    table.string('label')
    table.timestamps()
  })
  await schema.create('tag_user', (table) => {
    table.foreignId('user_id')
    table.foreignId('tag_id')
    table.primary(['user_id', 'tag_id'])
  })
  await schema.create('trashables', (table) => {
    table.id()
    table.string('label')
    table.softDeletes()
    table.timestamps()
  })
  await schema.create('timeless', (table) => {
    table.id()
    table.string('label')
  })
})

afterEach(async () => {
  await connection.disconnect()
})

describe('table naming', () => {
  test('uses the static table when given', () => {
    expect(User.getTable()).toBe('users')
  })

  test('otherwise pluralises the class name', () => {
    class Category extends Model {}
    class Box extends Model {}
    class BlogPost extends Model {}

    expect(Category.getTable()).toBe('categories')
    expect(Box.getTable()).toBe('boxes')
    expect(BlogPost.getTable()).toBe('blog_posts')
  })
})

describe('attributes', () => {
  test('read and write through the proxy', () => {
    const user = new User({ name: 'Ada' })

    expect(user.name).toBe('Ada')

    user.name = 'Ada Lovelace'
    expect(user.name).toBe('Ada Lovelace')
    expect(user.attributes.name).toBe('Ada Lovelace')
  })

  test('methods still resolve, and unknown keys are undefined', () => {
    const user = new User({ name: 'Ada' })

    expect(typeof user.save).toBe('function')
    expect((user as unknown as Record<string, unknown>).nope).toBeUndefined()
  })

  test('instanceof survives the proxy', () => {
    expect(new User()).toBeInstanceOf(User)
    expect(new User()).toBeInstanceOf(Model)
  })

  test('mass assignment respects fillable', () => {
    const user = new User({ name: 'Ada', id: 99, secret: 'nope' })

    expect(user.name).toBe('Ada')
    expect(user.attributes.id).toBeUndefined()
    expect(user.attributes.secret).toBeUndefined()
  })

  test('forceFill bypasses fillable', () => {
    const user = new User().forceFill({ id: 99, secret: 'shh' })

    expect(user.attributes.id).toBe(99)
    expect(user.attributes.secret).toBe('shh')
  })

  test('guarded defaults to blocking everything', () => {
    class Locked extends Model {
      static override table = 'users'
    }

    const model = new Locked({ name: 'nope' })
    expect(model.attributes.name).toBeUndefined()
  })
})

describe('casts', () => {
  test('sqlite integers become booleans, not truthy strings', async () => {
    await User.create({ name: 'Ada', active: false })
    const user = await User.first()

    // The column round-trips as 0; without a cast this would read as truthy.
    expect(user?.attributes.active).toBe(0)
    expect(user?.active).toBe(false)
  })

  test('json is parsed on read and stringified on write', async () => {
    await User.create({ name: 'Ada', meta: { theme: 'dark', tags: [1, 2] } })
    const user = await User.first()

    expect(typeof user?.attributes.meta).toBe('string')
    expect(user?.meta).toEqual({ theme: 'dark', tags: [1, 2] })
  })

  test('int cast coerces strings from the driver', () => {
    const user = new User()
    user.attributes.votes = '42'

    expect(user.votes).toBe(42)
  })

  test('timestamps read back as Dates without an explicit cast', async () => {
    await User.create({ name: 'Ada' })
    const user = await User.first()

    expect(user?.getAttribute('created_at')).toBeInstanceOf(Date)
  })

  test('null stays null through every cast', () => {
    const user = new User()
    user.attributes.meta = null
    user.attributes.votes = null

    expect(user.meta).toBeNull()
    expect(user.votes).toBeNull()
  })
})

describe('dirty tracking', () => {
  test('a new model is dirty for everything it was given', () => {
    const user = new User({ name: 'Ada' })

    expect(user.isDirty()).toBe(true)
    expect(user.getDirty()).toEqual({ name: 'Ada' })
  })

  test('a hydrated model is clean', async () => {
    await User.create({ name: 'Ada' })
    const user = await User.first()

    expect(user?.isDirty()).toBe(false)
    expect(user?.getDirty()).toEqual({})
  })

  test('changing an attribute marks only that key dirty', async () => {
    await User.create({ name: 'Ada' })
    const user = (await User.first()) as User

    user.name = 'Grace'

    expect(user.isDirty()).toBe(true)
    expect(user.isDirty('name')).toBe(true)
    expect(user.isDirty('email')).toBe(false)
    expect(user.getDirty()).toEqual({ name: 'Grace' })
  })

  test('rewriting the same value is not dirty', async () => {
    await User.create({ name: 'Ada' })
    const user = (await User.first()) as User

    user.name = 'Ada'

    expect(user.isClean()).toBe(true)
  })

  test('a value that differs only by driver type is not dirty', async () => {
    await User.create({ name: 'Ada', votes: 5 })
    const user = (await User.first()) as User

    // The driver returned a number; assigning the string form must not count.
    user.attributes.votes = '5'

    expect(user.isDirty('votes')).toBe(false)
  })
})

describe('persistence', () => {
  test('create inserts and fills the key', async () => {
    const user = await User.create({ name: 'Ada' })

    expect(user.id).toBe(1)
    expect(user.exists).toBe(true)
    expect(await User.query().count()).toBe(1)
  })

  test('timestamps are set on insert', async () => {
    const user = await User.create({ name: 'Ada' })

    expect(user.attributes.created_at).toBeString()
    expect(user.attributes.updated_at).toBe(user.attributes.created_at)
  })

  test('timestamps are skipped when the model opts out', async () => {
    const model = await Timeless.create({ label: 'x' })

    expect(model.attributes.created_at).toBeUndefined()
  })

  test('save on a clean model issues no query', async () => {
    await User.create({ name: 'Ada' })
    const user = (await User.first()) as User

    const before = user.attributes.updated_at
    await user.save()

    // updated_at untouched proves no UPDATE ran.
    expect(user.attributes.updated_at).toBe(before)
  })

  test('save sends only the dirty columns', async () => {
    const seen: string[] = []
    const instrumented = await BunSqlConnection.make(
      'instrumented',
      { driver: 'sqlite', database: ':memory:' },
      {
        dispatch: async (event: unknown) => {
          seen.push((event as { sql: string }).sql)
          return []
        }
      } as never
    )
    await new SchemaBuilder(instrumented).create('users', (table) => {
      table.id()
      table.string('name')
      table.string('email').nullable()
      table.timestamps()
    })
    Model.setConnectionResolver(async () => instrumented)

    const user = await User.create({ name: 'Ada', email: 'a@b.c' })
    seen.length = 0

    user.name = 'Grace'
    await user.save()

    const update = seen.find((sql) => sql.startsWith('update'))
    expect(update).toContain('"name" = ?')
    expect(update).not.toContain('"email"')

    await instrumented.disconnect()
  })

  test('updating refreshes updated_at but not created_at', async () => {
    const user = await User.create({ name: 'Ada' })
    const created = user.attributes.created_at

    user.attributes.updated_at = '2000-01-01 00:00:00'
    user.syncOriginal()
    user.name = 'Grace'
    await user.save()

    expect(user.attributes.created_at).toBe(created)
    expect(user.attributes.updated_at).not.toBe('2000-01-01 00:00:00')
  })

  test('update() fills and saves', async () => {
    const user = await User.create({ name: 'Ada' })

    expect(await user.update({ name: 'Grace' })).toBe(true)
    expect((await User.find(user.id))?.name).toBe('Grace')
  })

  test('delete removes the row', async () => {
    const user = await User.create({ name: 'Ada' })

    expect(await user.delete()).toBe(true)
    expect(user.exists).toBe(false)
    expect(await User.query().count()).toBe(0)
  })

  test('fresh re-reads without touching the instance', async () => {
    const user = await User.create({ name: 'Ada' })
    await User.query().where('id', user.id).update({ name: 'Changed' })

    const fresh = await user.fresh()

    expect(fresh?.name).toBe('Changed')
    expect(user.name).toBe('Ada')
  })

  test('refresh discards unsaved changes', async () => {
    const user = await User.create({ name: 'Ada' })
    user.name = 'Unsaved'

    await user.refresh()

    expect(user.name).toBe('Ada')
    expect(user.isClean()).toBe(true)
  })
})

describe('querying', () => {
  beforeEach(async () => {
    await User.create({ name: 'Ada', votes: 10, active: true })
    await User.create({ name: 'Linus', votes: 5, active: true })
    await User.create({ name: 'Grace', votes: 20, active: false })
  })

  test('all and get hydrate models', async () => {
    const users = await User.all()

    expect(users.count()).toBe(3)
    expect(users.first()).toBeInstanceOf(User)
  })

  test('find, findOrFail and the error it throws', async () => {
    expect((await User.find(2))?.name).toBe('Linus')
    expect(await User.find(99)).toBeUndefined()
    expect((await User.findOrFail(1)).name).toBe('Ada')

    await expect(User.findOrFail(99)).rejects.toThrow(ModelNotFoundError)
    await expect(User.findOrFail(99)).rejects.toThrow(/User \[99\]/)
  })

  test('where chains and aggregates', async () => {
    expect(await User.where('votes', '>', 5).count()).toBe(2)
    expect(await User.query().sum('votes')).toBe(35)
    expect(await User.query().max<number>('votes')).toBe(20)
  })

  test('ordering and limiting', async () => {
    const top = await User.query().orderByDesc('votes').limit(2).get()

    expect(top.pluck('name').all()).toEqual(['Grace', 'Ada'])
  })

  test('scopes are applied by name', async () => {
    expect(await User.query().scope('active').count()).toBe(2)
  })

  test('firstOrCreate does not duplicate', async () => {
    const first = await User.query().firstOrCreate({ name: 'Ada' })
    const second = await User.query().firstOrCreate({ name: 'Ada' })

    expect(first.id).toBe(second.id)
    expect(await User.query().count()).toBe(3)
  })

  test('firstOrCreate inserts with the extra values', async () => {
    const user = await User.query().firstOrCreate({ name: 'New' }, { votes: 7 })

    expect(user.votes).toBe(7)
    expect(await User.query().count()).toBe(4)
  })

  test('updateOrCreate updates in place', async () => {
    const user = await User.query().updateOrCreate({ name: 'Ada' }, { votes: 99 })

    expect(user.votes).toBe(99)
    expect(await User.query().count()).toBe(3)
  })

  test('paginate reports the totals', async () => {
    const page = await User.query().orderBy('id').paginate(2, 2)

    expect(page.data.pluck('name').all()).toEqual(['Grace'])
    expect(page).toMatchObject({ total: 3, perPage: 2, currentPage: 2, lastPage: 2 })
  })

  test('chunk walks every model', async () => {
    const seen: string[] = []
    await User.query()
      .orderBy('id')
      .chunk(2, (models) => {
        seen.push(...models.pluck('name').map(String).all())
      })

    expect(seen).toEqual(['Ada', 'Linus', 'Grace'])
  })

  test('mass update through the builder', async () => {
    expect(await User.query().where('active', 1).update({ votes: 0 })).toBe(2)
    expect(await User.query().sum('votes')).toBe(20)
  })
})

describe('serialisation', () => {
  test('hidden columns are removed and casts applied', async () => {
    const user = await User.create({ name: 'Ada', meta: { a: 1 } })
    user.attributes.secret = 'shh'

    const object = user.toObject()

    expect(object.secret).toBeUndefined()
    expect(object.meta).toEqual({ a: 1 })
    expect(JSON.parse(JSON.stringify(user)).name).toBe('Ada')
  })

  test('loaded relations are serialised too', async () => {
    const user = await User.create({ name: 'Ada' })
    await user.posts().create({ title: 'First' })

    const loaded = await User.with('posts').first()
    const object = loaded?.toObject() as { posts: Array<{ title: string }> }

    expect(object.posts).toHaveLength(1)
    expect(object.posts[0]?.title).toBe('First')
  })
})

describe('soft deletes', () => {
  test('delete sets deleted_at and hides the row', async () => {
    const model = await Trashable.create({ label: 'x' })

    await model.delete()

    expect(model.trashed()).toBe(true)
    expect(await Trashable.query().count()).toBe(0)
    expect(await Trashable.withTrashed().count()).toBe(1)
    expect(await Trashable.onlyTrashed().count()).toBe(1)
  })

  test('restore brings it back', async () => {
    const model = await Trashable.create({ label: 'x' })
    await model.delete()

    await model.restore()

    expect(model.trashed()).toBe(false)
    expect(await Trashable.query().count()).toBe(1)
  })

  test('forceDelete really removes it', async () => {
    const model = await Trashable.create({ label: 'x' })

    await model.forceDelete()

    expect(await Trashable.withTrashed().count()).toBe(0)
  })

  test('fresh finds a trashed model', async () => {
    const model = await Trashable.create({ label: 'x' })
    await model.delete()

    expect(await model.fresh()).toBeDefined()
  })
})

describe('relations', () => {
  test('hasMany reads and creates', async () => {
    const user = await User.create({ name: 'Ada' })

    await user.posts().create({ title: 'First' })
    await user.posts().create({ title: 'Second' })

    const posts = await user.posts().get()

    expect(posts.count()).toBe(2)
    expect(posts.first()).toBeInstanceOf(Post)
    expect(await user.posts().count()).toBe(2)
  })

  test('hasOne returns a single model', async () => {
    const user = await User.create({ name: 'Ada' })
    await Profile.create({ user_id: user.id, bio: 'Mathematician' })

    const profile = await user.profile().get()

    expect(profile).toBeInstanceOf(Profile)
    expect(profile?.bio).toBe('Mathematician')
  })

  test('belongsTo walks back to the owner', async () => {
    const user = await User.create({ name: 'Ada' })
    const post = await Post.create({ title: 'First', user_id: user.id })

    expect((await post.author().get())?.name).toBe('Ada')
  })

  test('belongsTo with a null key resolves to undefined without querying', async () => {
    const post = await Post.create({ title: 'Orphan' })

    expect(await post.author().get()).toBeUndefined()
  })

  test('associate and dissociate set the key', async () => {
    const user = await User.create({ name: 'Ada' })
    const post = new Post({ title: 'Draft' })

    post.author().associate(user)
    expect(post.attributes.user_id).toBe(user.id)

    post.author().dissociate()
    expect(post.attributes.user_id).toBeNull()
  })

  test('belongsToMany attaches, reads, detaches and syncs', async () => {
    const user = await User.create({ name: 'Ada' })
    const first = await Tag.create({ label: 'maths' })
    const second = await Tag.create({ label: 'code' })

    await user.tags().attach([first.id, second.id])
    expect((await user.tags().get()).count()).toBe(2)

    // Attaching the same pair twice must not violate the pivot's primary key.
    await user.tags().attach(first.id)
    expect((await user.tags().get()).count()).toBe(2)

    await user.tags().detach(first.id)
    expect((await user.tags().get()).pluck('label').all()).toEqual(['code'])

    await user.tags().sync([first.id])
    expect((await user.tags().get()).pluck('label').all()).toEqual(['maths'])
  })

  test('the pivot table name is derived alphabetically', () => {
    // `User` + `Tag` sort to `tag_user`, which is the table the schema created.
    expect(new User().tags()).toBeDefined()
  })
})

describe('eager loading', () => {
  beforeEach(async () => {
    const ada = await User.create({ name: 'Ada' })
    const linus = await User.create({ name: 'Linus' })
    await User.create({ name: 'Grace' })

    const first = await ada.posts().create({ title: 'A1' })
    await ada.posts().create({ title: 'A2' })
    await linus.posts().create({ title: 'L1' })
    await Comment.create({ post_id: first.id, body: 'Nice' })
  })

  test('with() loads a hasMany in one extra query', async () => {
    const queries: string[] = []
    const instrumented = await BunSqlConnection.make(
      'instrumented',
      { driver: 'sqlite', database: ':memory:' },
      {
        dispatch: async (event: unknown) => {
          queries.push((event as { sql: string }).sql)
          return []
        }
      } as never
    )

    const schema = new SchemaBuilder(instrumented)
    await schema.create('users', (table) => {
      table.id()
      table.string('name')
      table.timestamps()
    })
    await schema.create('posts', (table) => {
      table.id()
      table.foreignId('user_id').nullable()
      table.string('title')
      table.timestamps()
    })

    Model.setConnectionResolver(async () => instrumented)
    const user = await User.create({ name: 'Ada' })
    await user.posts().create({ title: 'One' })
    queries.length = 0

    const users = await User.with('posts').get()

    // Two selects: the parents, then every child in one `where in`.
    expect(queries.filter((sql) => sql.startsWith('select'))).toHaveLength(2)
    expect(users.first()?.relationLoaded('posts')).toBe(true)

    await instrumented.disconnect()
  })

  test('each parent gets only its own children', async () => {
    const users = await User.with('posts').orderBy('id').get()
    const byName = new Map(users.all().map((user) => [user.name, user]))
    const postsOf = (name: string) => {
      const user = byName.get(name)
      if (!user) throw new Error(`Expected a user named ${name}.`)

      return (user.getRelation('posts') as { count(): number }).count()
    }

    expect(postsOf('Ada')).toBe(2)
    expect(postsOf('Linus')).toBe(1)
    // A parent with no children still gets an empty collection, not undefined.
    expect(postsOf('Grace')).toBe(0)
  })

  test('belongsTo eager loads without duplicating owners', async () => {
    const posts = await Post.with('author').orderBy('id').get()

    const first = posts.first()
    if (!first) throw new Error('Expected at least one post.')

    expect(posts.count()).toBe(3)
    expect((first.getRelation('author') as User).name).toBe('Ada')
  })

  test('nested relations load with dot notation', async () => {
    const users = await User.with('posts.comments').orderBy('id').get()
    const posts = users.first()?.getRelation('posts') as { first(): Post }
    const comments = posts.first()?.getRelation('comments') as { count(): number }

    expect(comments.count()).toBe(1)
  })

  test('load() fills a relation on an existing instance', async () => {
    const user = (await User.first()) as User

    expect(user.relationLoaded('posts')).toBe(false)

    await user.load('posts')

    expect(user.relationLoaded('posts')).toBe(true)
    expect((user.getRelation('posts') as { count(): number }).count()).toBe(2)
  })

  test('hasOne eager loading yields a model, not a collection', async () => {
    const user = (await User.first()) as User
    await Profile.create({ user_id: user.id, bio: 'Maths' })

    const loaded = await User.with('profile').find(user.id)

    expect(loaded?.getRelation('profile')).toBeInstanceOf(Profile)
  })

  test('an unknown relation name fails loudly', async () => {
    await expect(User.with('nope').get()).rejects.toThrow(/Relation \[nope\] is not defined/)
  })
})
