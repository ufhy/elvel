#!/usr/bin/env bun
import app from './bootstrap/app.ts'

/**
 * Elvel entry point.
 *
 * The application is fully booted before commands run, which is why `serve`,
 * `route:list` and `about` can inspect the real container and route table.
 */
const kernel = app.make('elvel')
const code = await kernel.run()

/**
 * Exit, unless the command left the server running.
 *
 * `serve` returns as soon as it is listening, because a command that never
 * returns leaves this module still evaluating — and `bun --hot` will not
 * re-evaluate a graph whose entry has not finished, so every edit needed a
 * restart. Measured: five successive edits to a view, five stale responses.
 *
 * So the exit is conditional. Nothing is holding the loop after an ordinary
 * command, and `process.exit` is what makes that immediate even when a driver
 * left a socket open; after `serve` the server is holding it, and exiting here
 * would close the thing that was just started.
 */
if (kernel.holdsProcess) process.exitCode = code
else process.exit(code)
