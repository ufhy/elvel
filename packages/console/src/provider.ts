import { ServiceProvider } from '@elysian/core'
import { AboutCommand } from './commands/about.ts'
import { ConfigCacheCommand } from './commands/config-cache.ts'
import { ConfigClearCommand } from './commands/config-clear.ts'
import { ConfigShowCommand } from './commands/config-show.ts'
import { DevCommand } from './commands/dev.ts'
import { DownCommand } from './commands/down.ts'
import { EnvironmentCommand } from './commands/env.ts'
import { InstallApiCommand, InstallBroadcastingCommand } from './commands/install.ts'
import { MakeClassCommand } from './commands/make-class.ts'
import { MakeCommandCommand } from './commands/make-command.ts'
import { MakeComponentCommand } from './commands/make-component.ts'
import { MakeConfigCommand } from './commands/make-config.ts'
import { MakeControllerCommand } from './commands/make-controller.ts'
import { MakeEnumCommand } from './commands/make-enum.ts'
import { MakeEventCommand } from './commands/make-event.ts'
import { MakeExceptionCommand } from './commands/make-exception.ts'
import { MakeInterfaceCommand } from './commands/make-interface.ts'
import { MakeListenerCommand } from './commands/make-listener.ts'
import { MakeMiddlewareCommand } from './commands/make-middleware.ts'
import { MakeProviderCommand } from './commands/make-provider.ts'
import { MakeTestCommand } from './commands/make-test.ts'
import { MakeViewCommand } from './commands/make-view.ts'
import { OptimizeClearCommand, OptimizeCommand } from './commands/optimize.ts'
import { RouteListCommand } from './commands/route-list.ts'
import { ServeCommand } from './commands/serve.ts'
import { StubPublishCommand } from './commands/stub-publish.ts'
import { UpCommand } from './commands/up.ts'
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
      DevCommand,
      RouteListCommand,
      AboutCommand,
      ConfigCacheCommand,
      ConfigClearCommand,
      ConfigShowCommand,
      OptimizeCommand,
      OptimizeClearCommand,
      EnvironmentCommand,
      DownCommand,
      UpCommand,
      MakeControllerCommand,
      MakeViewCommand,
      MakeComponentCommand,
      MakeMiddlewareCommand,
      MakeProviderCommand,
      MakeCommandCommand,
      MakeEventCommand,
      MakeListenerCommand,
      MakeEnumCommand,
      MakeExceptionCommand,
      MakeInterfaceCommand,
      MakeClassCommand,
      MakeConfigCommand,
      MakeTestCommand,
      InstallApiCommand,
      InstallBroadcastingCommand,
      StubPublishCommand
    )

    // Application commands — discovered, not registered by hand.
    await kernel.loadFrom(this.app.appPath('Console', 'Commands'))
  }
}
