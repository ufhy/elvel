import { ConsoleServiceProvider } from '@elvel/console'
import { ViewServiceProvider } from '@elvel/view'

export default {
  name: 'Fixture',
  env: 'testing',
  debug: true,
  url: 'http://localhost',
  providers: [ConsoleServiceProvider, ViewServiceProvider]
}
