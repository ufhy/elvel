import type { ApplicationContract } from '@elyvel/contracts'
import type { Disk, Visibility } from './contracts.ts'
import { LocalDisk } from './disks/local.ts'
import { MemoryDisk } from './disks/memory.ts'
import { S3Disk } from './disks/s3.ts'

export type DiskConfig = { driver: string } & Record<string, unknown>

/** Builds a disk from its configuration — how `extend()` adds a driver. */
export type DiskFactory = (name: string, config: DiskConfig, app: ApplicationContract) => Disk

/**
 * Resolves disks — Laravel's `FilesystemManager`.
 *
 * Disks are memoised per name so an S3 client is built once, and `fake()` swaps a
 * disk for one in memory without the calling code knowing.
 */
export class StorageManager {
  private readonly disks = new Map<string, Disk>()
  private readonly customDrivers = new Map<string, DiskFactory>()
  private readonly faked = new Map<string, MemoryDisk>()

  constructor(private readonly app: ApplicationContract) {}

  disk(name?: string): Disk {
    const resolved = name ?? this.defaultDisk()

    const fake = this.faked.get(resolved)
    if (fake) return fake

    const cached = this.disks.get(resolved)
    if (cached) return cached

    const disk = this.resolve(resolved)
    this.disks.set(resolved, disk)

    return disk
  }

  defaultDisk(): string {
    return this.app.config.get<string>('filesystems.default', 'local')
  }

  extend(driver: string, factory: DiskFactory): this {
    this.customDrivers.set(driver, factory)
    this.disks.clear()

    return this
  }

  /**
   * Replace a disk with one in memory.
   *
   * Nothing reaches the filesystem while it is faked, so a test asserts against
   * the same disk the code under test wrote to.
   */
  fake(name?: string): MemoryDisk {
    const resolved = name ?? this.defaultDisk()
    const disk = new MemoryDisk(resolved, { url: `http://localhost/storage/${resolved}` })

    this.faked.set(resolved, disk)

    return disk
  }

  /** Stop faking, and use the configured disks again. */
  restore(name?: string): void {
    if (name === undefined) this.faked.clear()
    else this.faked.delete(name)
  }

  private resolve(name: string): Disk {
    const config = this.app.config.get<DiskConfig | undefined>(`filesystems.disks.${name}`)

    if (!config) {
      throw new Error(`Disk [${name}] is not configured. Add it to config/filesystems.ts.`)
    }

    const custom = this.customDrivers.get(config.driver)
    if (custom) return custom(name, config, this.app)

    switch (config.driver) {
      case 'local':
        return new LocalDisk(name, {
          root: String(config.root ?? this.app.storagePath('app')),
          url: config.url as string | undefined,
          visibility: config.visibility as Visibility | undefined,
          permissions: config.permissions as
            | { publicFile?: number; privateFile?: number; directory?: number }
            | undefined
        })

      case 'memory':
        return new MemoryDisk(name, {
          url: config.url as string | undefined,
          visibility: config.visibility as Visibility | undefined
        })

      case 's3':
        return new S3Disk(name, {
          bucket: String(config.bucket ?? ''),
          accessKeyId: config.accessKeyId as string | undefined,
          secretAccessKey: config.secretAccessKey as string | undefined,
          sessionToken: config.sessionToken as string | undefined,
          region: config.region as string | undefined,
          endpoint: config.endpoint as string | undefined,
          prefix: config.prefix as string | undefined,
          url: config.url as string | undefined,
          visibility: config.visibility as Visibility | undefined
        })

      default:
        throw new Error(
          `Filesystem driver [${config.driver}] for disk [${name}] is not supported. Register it with storage().extend().`
        )
    }
  }
}
