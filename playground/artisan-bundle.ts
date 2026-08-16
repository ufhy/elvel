#!/usr/bin/env bun
import app from './bootstrap/bundle.ts'

/** `artisan.ts`, for a bundled build — see `bootstrap/bundle.ts`. */
process.exit(await app.make('artisan').run(Bun.argv.slice(2)))
