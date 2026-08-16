import { Config } from '@elysian/core'

const config = await Config.loadFrom(`${process.cwd()}/config`)
const providers = config.get<unknown[]>('app.providers', [])

console.log('kunci config :', Object.keys(config.all?.() ?? {}).length || 'tidak ada all()')
console.log('jumlah provider:', providers.length)
