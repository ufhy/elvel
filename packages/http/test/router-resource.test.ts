import { afterEach, describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { compileRoutes } from '../src/router/compile.ts'
import { Route, resetRouter } from '../src/router/registrar.ts'
import { RouteRegistry } from '../src/routes.ts'

/**
 * `Route::resource`, against `ResourceRegistrar` rather than against the docs.
 *
 * Three of these assertions exist because the source says something the
 * documentation does not: `update` answers PUT **and** PATCH, the parameter is
 * singularised by default (`ResourceRegistrar::$singularParameters` is `true`),
 * and a shallow nested resource is *named* by its own segment.
 */
afterEach(() => {
  resetRouter()
})

class PhotoController {
  index() {
    return 'index'
  }

  create() {
    return 'create'
  }

  store() {
    return 'store'
  }

  show({ params }: { params: Record<string, string> }) {
    return `show ${params.photo}`
  }

  edit({ params }: { params: Record<string, string> }) {
    return `edit ${params.photo}`
  }

  update() {
    return 'update'
  }

  destroy() {
    return 'destroy'
  }
}

class CommentController {
  index({ params }: { params: Record<string, string> }) {
    return `comments of ${params.photo}`
  }

  create() {
    return 'create'
  }

  store() {
    return 'store'
  }

  show({ params }: { params: Record<string, string> }) {
    return `comment ${params.comment}`
  }

  edit() {
    return 'edit'
  }

  update() {
    return 'update'
  }

  destroy() {
    return 'destroy'
  }
}

function boot(): Application {
  const app = new Application(process.cwd())

  app.config.set('app.env', 'testing')
  app.instance('routes', new RouteRegistry())

  return app
}

function names(app: Application): Record<string, string> {
  return app.make('routes').all()
}

describe('testCanRegisterResource', () => {
  test('the seven routes, with Laravel’s URIs and verbs', async () => {
    const app = boot()

    Route.resource('photos', PhotoController)

    const routes = compileRoutes('resource')

    expect<string>(await (await routes.handle(req('/photos'))).text()).toBe('index')
    expect<string>(await (await routes.handle(req('/photos/create'))).text()).toBe('create')
    expect<string>(await (await routes.handle(req('/photos', 'POST'))).text()).toBe('store')
    expect<string>(await (await routes.handle(req('/photos/7'))).text()).toBe('show 7')
    expect<string>(await (await routes.handle(req('/photos/7/edit'))).text()).toBe('edit 7')
    expect<string>(await (await routes.handle(req('/photos/7', 'PUT'))).text()).toBe('update')
    expect<string>(await (await routes.handle(req('/photos/7', 'DELETE'))).text()).toBe('destroy')

    expect<Record<string, string>>(names(app)).toEqual({
      'photos.index': '/photos',
      'photos.create': '/photos/create',
      'photos.store': '/photos',
      'photos.show': '/photos/{photo}',
      'photos.edit': '/photos/{photo}/edit',
      'photos.update': '/photos/{photo}',
      'photos.destroy': '/photos/{photo}'
    })
  })

  /**
   * `addResourceUpdate` is `match(['PUT', 'PATCH'], …)`.
   *
   * Not in the documentation, and the failure it prevents is a form spoofing
   * PATCH against a PUT-only route — a 405 nobody expects.
   */
  test('update answers PATCH as well as PUT', async () => {
    boot()

    Route.resource('photos', PhotoController)

    const routes = compileRoutes('patch')

    expect<string>(await (await routes.handle(req('/photos/7', 'PATCH'))).text()).toBe('update')
  })

  test('the parameter is singular — $singularParameters is true', () => {
    const app = boot()

    Route.resource('photos', PhotoController)
    compileRoutes('singular')

    expect<string | undefined>(app.make('routes').path('photos.show')).toBe('/photos/{photo}')
  })
})

describe('only, except and names', () => {
  test('testCanRegisterResourcesWithOnlyOption', () => {
    const app = boot()

    Route.resource('photos', PhotoController).only(['index', 'show'])
    compileRoutes('only')

    expect<string[]>(Object.keys(names(app)).sort()).toEqual(['photos.index', 'photos.show'])
  })

  test('testCanRegisterResourcesWithExceptOption', () => {
    const app = boot()

    Route.resource('photos', PhotoController).except(['create', 'edit', 'destroy'])
    compileRoutes('except')

    expect<string[]>(Object.keys(names(app)).sort()).toEqual([
      'photos.index',
      'photos.show',
      'photos.store',
      'photos.update'
    ])
  })

  test('testCanNameRoutesOnRegisteredResource', () => {
    const app = boot()

    Route.resource('photos', PhotoController).only(['index']).names({ index: 'gallery' })
    compileRoutes('named')

    expect<string[]>(Object.keys(names(app))).toEqual(['gallery'])
  })

  test('testCanOverrideParametersOnRegisteredResource', () => {
    const app = boot()

    Route.resource('photos', PhotoController).only(['show']).parameters({ photos: 'photo_id' })

    compileRoutes('parameters')

    expect<string | undefined>(app.make('routes').path('photos.show')).toBe('/photos/{photo_id}')
  })
})

describe('nested and shallow', () => {
  test('a dotted name nests the parent — photos.comments', async () => {
    const app = boot()

    Route.resource('photos.comments', CommentController)

    const routes = compileRoutes('nested')

    expect<string>(await (await routes.handle(req('/photos/3/comments'))).text()).toBe(
      'comments of 3'
    )
    expect<string | undefined>(app.make('routes').path('photos.comments.show')).toBe(
      '/photos/{photo}/comments/{comment}'
    )
  })

  /**
   * `testCanSetShallowOptionOnRegisteredResource`.
   *
   * The list routes keep the parent because they have no child to identify; the
   * ones with an id drop it because the id already says which. And the *name*
   * loses the parent too — `getShallowName` returns the last segment.
   */
  test('shallow drops the parent where an id already identifies the child', () => {
    const app = boot()

    Route.resource('photos.comments', CommentController).shallow()
    compileRoutes('shallow')

    const table = names(app)

    expect<string | undefined>(table['comments.index']).toBe('/photos/{photo}/comments')
    expect<string | undefined>(table['comments.store']).toBe('/photos/{photo}/comments')
    expect<string | undefined>(table['comments.show']).toBe('/comments/{comment}')
    expect<string | undefined>(table['comments.destroy']).toBe('/comments/{comment}')
  })

  test('scoped binds the child by a field — {comment:slug}', () => {
    const app = boot()

    Route.resource('photos.comments', CommentController).only(['show']).scoped({ comments: 'slug' })

    compileRoutes('scoped')

    expect<string | undefined>(app.make('routes').path('photos.comments.show')).toBe(
      '/photos/{photo}/comments/{comment}'
    )
  })
})

describe('apiResource and singletons', () => {
  test('testUserCanRegisterApiResource leaves out create and edit', () => {
    const app = boot()

    Route.apiResource('photos', PhotoController)
    compileRoutes('api')

    expect<string[]>(Object.keys(names(app)).sort()).toEqual([
      'photos.destroy',
      'photos.index',
      'photos.show',
      'photos.store',
      'photos.update'
    ])
  })

  test('testCanRegisterSingleton — show, edit, update, and no identifier', () => {
    const app = boot()

    Route.singleton('profile', PhotoController)
    compileRoutes('singleton')

    expect<Record<string, string>>(names(app)).toEqual({
      'profile.show': '/profile',
      'profile.edit': '/profile/edit',
      'profile.update': '/profile'
    })
  })

  test('testCanRegisterCreatableSingleton adds create, store and destroy', () => {
    const app = boot()

    Route.singleton('profile', PhotoController).creatable()
    compileRoutes('creatable')

    expect<string[]>(Object.keys(names(app)).sort()).toEqual([
      'profile.create',
      'profile.destroy',
      'profile.edit',
      'profile.show',
      'profile.store',
      'profile.update'
    ])
  })

  test('testSingletonCanBeDestroyable adds only destroy', () => {
    const app = boot()

    Route.singleton('profile', PhotoController).destroyable()
    compileRoutes('destroyable')

    expect<string[]>(Object.keys(names(app)).sort()).toEqual([
      'profile.destroy',
      'profile.edit',
      'profile.show',
      'profile.update'
    ])
  })

  test('apiSingleton has no edit, because there is no form to render', () => {
    const app = boot()

    Route.apiSingleton('profile', PhotoController)
    compileRoutes('api-singleton')

    expect<string[]>(Object.keys(names(app)).sort()).toEqual(['profile.show', 'profile.update'])
  })
})

describe('a resource inside a group', () => {
  test('takes the group’s prefix and name, though it is declared later', async () => {
    const app = boot()

    Route.prefix('admin')
      .name('admin.')
      .group(() => {
        Route.resource('photos', PhotoController).only(['index'])
      })

    const routes = compileRoutes('grouped')

    expect<string>(await (await routes.handle(req('/admin/photos'))).text()).toBe('index')
    expect<string | undefined>(app.make('routes').path('admin.photos.index')).toBe('/admin/photos')
  })
})

function req(path: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, { method })
}
