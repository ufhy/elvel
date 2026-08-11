import type { BindingKey, Resolved } from '@elysian/contracts'
import { Application } from './application.ts'

/**
 * Global helpers, deliberately mirroring Laravel's.
 *
 * These resolve from the running application rather than being injected into
 * the request context. That keeps the Elysia context clean — every decorator we
 * add to it is a type every route has to carry — while giving handlers the
 * short, familiar call sites Laravel developers expect.
 */

/** The running application, or a binding from its container. */
export function app(): Application
export function app<K extends BindingKey>(key: K): Resolved<K>
export function app<K extends BindingKey>(key?: K): Application | Resolved<K> {
  const instance = Application.getInstance()
  return key === undefined ? instance : instance.make(key)
}

export function config<T = unknown>(key: string): T
export function config<T>(key: string, fallback: T): T
export function config<T>(key: string, fallback?: T): T {
  return Application.getInstance().config.get<T>(key, fallback as T)
}

export function base_path(...segments: string[]): string {
  return Application.getInstance().basePath(...segments)
}

export function storage_path(...segments: string[]): string {
  return Application.getInstance().storagePath(...segments)
}

export function public_path(...segments: string[]): string {
  return Application.getInstance().publicPath(...segments)
}

export function resource_path(...segments: string[]): string {
  return Application.getInstance().resourcePath(...segments)
}
