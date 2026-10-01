/** Independent processes reproduce profile races without sharing JavaScript state. */
import { createTierStore } from '../src/tier-store.ts'

const WRITE_COUNT = 40
const [home, provider, model, tier] = process.argv.slice(2)
if (!home || !provider || !model || !tier) throw new Error('missing tier store worker arguments')
const store = createTierStore(home, value => value === tier)
process.once('message', async () => {
  try {
    for (let count = 0; count < WRITE_COUNT; count++) {
      await store.write(provider, model, tier)
      process.send?.('written')
    }
  } finally {
    process.disconnect()
  }
})
process.send?.('ready')
