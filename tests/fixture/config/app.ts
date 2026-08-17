import { ConsoleServiceProvider } from '@elyvel/console'
import { ViewServiceProvider } from '@elyvel/view'

export default {
  name: 'Fixture',
  env: 'testing',
  debug: true,
  url: 'http://localhost',
  providers: [ConsoleServiceProvider, ViewServiceProvider]
}
