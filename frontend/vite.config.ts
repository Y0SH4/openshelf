import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** Builds dist/sw.js from sw.template.js with the list of files to keep offline. */
function serviceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'openshelf-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const files: string[] = []
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else files.push(path.relative(outDir, full).split(path.sep).join('/'))
        }
      }
      walk(outDir)
      const precache = files.filter((f) => f !== 'sw.js').sort()

      const hash = createHash('sha256')
      for (const file of precache) hash.update(file).update(fs.readFileSync(path.join(outDir, file)))
      const version = hash.digest('hex').slice(0, 12)

      const template = fs.readFileSync(path.resolve(import.meta.dirname, 'sw.template.js'), 'utf8')
      const sw = template
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(precache.map((f) => `/${f}`)))
      fs.writeFileSync(path.join(outDir, 'sw.js'), sw)
    },
  }
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
