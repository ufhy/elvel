import { ServiceProvider } from '@elysian/core'
import { AboutCommand } from './commands/about.ts'
import { MakeCommandCommand } from './commands/make-command.ts'
import { MakeComponentCommand } from './commands/make-component.ts'
import { MakeControllerCommand } from './commands/make-controller.ts'
import { MakeProviderCommand } from './commands/make-provider.ts'
import { MakeViewCommand } from './commands/make-view.ts'
import { RouteListCommand } from './commands/route-list.ts'
import { ServeCommand } from './commands/serve.ts'
import { Kernel } from './kernel.ts'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    artisan: Kernel
  }
}

export class ConsoleServiceProvider extends ServiceProvider {
  register(): void {
    this.app.singleton('artisan', (app) => new Kernel(app as never))
  }

  override async boot(): Promise<void> {
    const kernel = this.app.make('artisan')

    kernel.register(
      ServeCommand,
      RouteListCommand,
      AboutCommand,
      MakeControllerCommand,
      MakeViewCommand,
      MakeComponentCommand,
      MakeProviderCommand,
      MakeCommandCommand
    )

    // Application commands — discovered, not registered by hand.
    await kernel.loadFrom(this.app.appPath('Console', 'Commands'))
  }
}
