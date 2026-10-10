// @ts-check
import { defineConfig } from 'vitest/config'
import { readFileSync } from 'fs'

export default defineConfig({
  test: {
    environment: 'jsdom',
  },
  plugins: [
    {
      name: 'wasm-base64',
      enforce: 'pre',
      load(id) {
        if (!id.endsWith('.wasm')) return null
        const buf = readFileSync(id)
        return { code: `export default '${buf.toString('base64')}'`, map: null }
      },
    },
  ],
})
