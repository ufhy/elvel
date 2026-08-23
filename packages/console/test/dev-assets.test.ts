import { describe, expect, test } from 'bun:test'
import { assetServer } from '../src/commands/dev.ts'

/**
 * `dev` ran Vite at the application root and nowhere else.
 *
 * That is right for the scaffold and wrong for a client that is its own project.
 * Measured in a demo whose `vite.config.ts` lives in `frontend/`: Vite started at
 * the application root, took 5173, answered 404 for every path, and wrote no hot
 * file — so the server rendered manifest tags and `dev` served the previous
 * build while reporting that assets were up.
 */
describe('where `dev` runs the asset server', () => {
  test('the scaffold runs it here, and says nothing about a directory', () => {
    const decided = assetServer('.', '/app', true)

    expect(decided.process?.argv).toEqual(['bun', 'x', 'vite'])
    expect(decided.process?.cwd).toBe('/app')
    expect(decided.notice).toBe('starting, its port is reported below')
  })

  test('a client of its own runs there, and the notice names it', () => {
    const decided = assetServer('frontend', '/app/frontend', true)

    expect(decided.process?.cwd).toBe('/app/frontend')
    expect(decided.notice).toBe('starting in frontend, its port is reported below')
  })

  /**
   * The notice quotes the configured name, not the resolved path.
   *
   * A developer who wrote `frontend` should read `frontend` back. An absolute
   * path is longer, carries their username, and answers a question nobody asked.
   */
  test('no vite, no process — and the reason says where it looked', () => {
    const here = assetServer('.', '/app', false)
    const there = assetServer('frontend', '/app/frontend', false)

    expect(here.process).toBeUndefined()
    expect(here.notice).toBe('vite is not installed, so there is no browser reload')

    expect(there.process).toBeUndefined()
    expect(there.notice).toBe('vite is not installed in frontend, so there is no browser reload')
  })
})
