import { ConsoleServiceProvider } from '@elysian/console'
import { ViewServiceProvider } from '@elysian/view'

export default {
  name: 'Fixture',
  env: 'testing',
  debug: true,
  url: 'http://localhost',
  providers: [ConsoleServiceProvider, ViewServiceProvider]
}
