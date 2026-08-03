// Mechanical enforcement of kit/README.md's hard rules, so they hold without review:
//   1. No kit file imports from src/ (copy-portability — rule #1).
//   2. Core files (everything not in the dom/react layer, not an example, not a test)
//      import neither react nor dom/react layer files (layering — rule #2).
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

const KIT_DIR = import.meta.dir

function allFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allFilesUnder(full))
    else out.push(full)
  }
  return out
}

function kitSourceFiles(dir: string): string[] {
  return allFilesUnder(dir).filter((file) => /\.(ts|tsx)$/.test(file))
}

// Also matches require('...') and bare side-effect import '...' forms.
const IMPORT_RE = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const specs: string[] = []
  for (const match of source.matchAll(IMPORT_RE)) {
    specs.push(match[1]!)
  }
  return specs
}

// The dom/react layer is named exactly: dom.ts(x), react.ts(x), or a dom/ or react/
// subdirectory. "dominance.ts" is core.
function isDomOrReactLayerFile(relPath: string): boolean {
  const parts = relPath.split('/')
  if (parts.some((p, i) => i < parts.length - 1 && (p === 'dom' || p === 'react'))) return true
  const stem = basename(relPath).replace(/\.(ts|tsx)$/, '')
  return stem === 'dom' || stem === 'react'
}

function isDomOrReactLayerImport(spec: string): boolean {
  const last = spec.split('/').at(-1) ?? ''
  const stem = last.replace(/\.(ts|tsx|js|jsx)$/, '')
  return stem === 'dom' || stem === 'react'
}

test('kit has no .js/.jsx sources (the guards below only scan .ts/.tsx)', () => {
  const stray = allFilesUnder(KIT_DIR)
    .filter((file) => /\.(js|jsx)$/.test(file))
    .map((file) => relative(KIT_DIR, file))
  expect(stray).toEqual([])
})

test('no kit file imports from src/', () => {
  for (const file of kitSourceFiles(KIT_DIR)) {
    for (const spec of importsOf(file)) {
      const escapesToSrc = spec.startsWith('@/') || /\.\.\/.*\bsrc\//.test(spec)
      if (escapesToSrc) {
        throw new Error(`${relative(KIT_DIR, file)} imports "${spec}" — kit modules must not depend on src/ (kit/README.md rule 1)`)
      }
    }
  }
  expect(true).toBe(true)
})

test('core files import neither react nor dom/react layer files', () => {
  for (const file of kitSourceFiles(KIT_DIR)) {
    const rel = relative(KIT_DIR, file)
    const isCoreFile = !isDomOrReactLayerFile(rel) && !rel.includes('examples/') && !rel.endsWith('.test.ts')
    if (!isCoreFile) continue
    for (const spec of importsOf(file)) {
      const isReactPackage = spec === 'react' || spec === 'react-dom' || spec.startsWith('react/') || spec.startsWith('react-dom/')
      if (isReactPackage || isDomOrReactLayerImport(spec)) {
        throw new Error(`${rel} (core layer) imports "${spec}" — core must not import react or dom/react layer files (kit/README.md rule 2)`)
      }
    }
  }
  expect(true).toBe(true)
})
