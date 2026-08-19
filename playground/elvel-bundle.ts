#!/usr/bin/env bun
import app from './bootstrap/bundle.ts'

/** `elvel.ts`, for a bundled build — see `bootstrap/bundle.ts`. */
process.exit(await app.make('elvel').run(Bun.argv.slice(2)))
