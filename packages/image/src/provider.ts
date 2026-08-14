import { ServiceProvider } from '@elysian/core'
import { ImageManager } from './manager.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    image: ImageManager
  }
}

/**
 * Binds the image manager and detects a backend at boot.
 *
 * Detection happens here rather than on first use so the cost — a process spawn
 * per candidate — is paid once at startup instead of inside whichever request
 * happens to resize something first.
 */
export class ImageServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('image', (app) => new ImageManager(app))
  }

  override async boot(): Promise<void> {
    if (this.config<string>('image.driver', 'auto') === 'auto') {
      await this.app.make('image').detect()
    }
  }
}
