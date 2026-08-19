#!/usr/bin/env bun
import app from './bootstrap/app.ts'

/**
 * Elvel entry point.
 *
 * The application is fully booted before commands run, which is why `serve`,
 * `route:list` and `about` can inspect the real container and route table.
 */
process.exit(await app.make('elvel').run())
