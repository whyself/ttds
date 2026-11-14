import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')
const entryFile = resolve(packageDir, 'src/client/index.ts')
const outFile = resolve(packageDir, 'lib/client.browser.js')

if (!existsSync(entryFile)) {
  // Placeholder browser bundle while src/client/index.ts is not yet authored.
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(
    outFile,
    'window.__ModuleLoader__.load({ id: "@whyself/ttds", factory: () => ({ apply() {} }) });\n',
    'utf8',
  )
  process.exit(0)
}

const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
const id = manifest.name

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const requestedExternals = Array.isArray(manifest.dsh?.client?.external)
  ? manifest.dsh.client.external
  : []

const externalSet = new Set([...PLATFORM_MODULES, ...requestedExternals])

function rewriteSelectorChunk(selectorText, shortHash, classMap) {
  let out = ''
  let quote = ''
  for (let i = 0; i < selectorText.length;) {
    const ch = selectorText[i]
    if (quote !== '') {
      out += ch
      if (ch === '\\' && i + 1 < selectorText.length) {
        out += selectorText[i + 1]
        i += 2
        continue
      }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '.') {
      const prev = i > 0 ? selectorText[i - 1] : ''
      const match = /^\.([A-Za-z_-][A-Za-z0-9_-]*)/.exec(selectorText.slice(i))
      if (match && !(prev >= '0' && prev <= '9')) {
        const localName = match[1]
        const scoped = `ttds_${shortHash}_${localName}`
        classMap[localName] = scoped
        out += `.${scoped}`
        i += match[0].length
        continue
      }
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * Compile `.module.css` into deterministic hashed class names and inject a single
 * `<style data-plugin="..." data-plugin-css="...">` element when loaded in a browser.
 */
function transformCssModule(cssText, filePath) {
  const shortHash = createHash('sha256').update(`${id}:${basename(filePath)}:${cssText}`).digest('hex').slice(0, 6)
  const classMap = {}
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '')
  const stack = []
  let out = ''
  let cursor = 0
  let quote = ''
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i]
    if (quote !== '') {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    const top = stack[stack.length - 1]
    if (ch === '{') {
      const rawPrelude = stripped.slice(cursor, i)
      if (top === undefined || top === 'at-group') {
        const trimmed = rawPrelude.trimStart()
        if (trimmed.startsWith('@')) {
          out += rawPrelude + '{'
          if (/^@(?:-\w+-)?keyframes\b/i.test(trimmed)) stack.push('keyframes')
          else if (/^@(?:media|supports|container|layer|scope)\b/i.test(trimmed)) stack.push('at-group')
          else stack.push('declarations')
        } else {
          out += rewriteSelectorChunk(rawPrelude, shortHash, classMap) + '{'
          stack.push('declarations')
        }
      } else {
        out += rawPrelude + '{'
        stack.push(top)
      }
      cursor = i + 1
    } else if (ch === '}') {
      out += stripped.slice(cursor, i + 1)
      stack.pop()
      cursor = i + 1
    } else if (ch === ';' && (top === undefined || top === 'at-group')) {
      out += stripped.slice(cursor, i + 1)
      cursor = i + 1
    }
  }
  out += stripped.slice(cursor)
  const transformed = out
  const tagId = `${id}/${basename(filePath)}`
  return [
    `const css = ${JSON.stringify(transformed)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== "undefined" && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement("style");',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

const cssModulesPlugin = {
  name: 'ttds-css-modules',
  setup( pluginBuild ) {
    pluginBuild.onResolve({ filter: /\.module\.css$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path),
      namespace: 'ttds-css-module',
    }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'ttds-css-module' }, (args) => {
      const source = readFileSync(args.path, 'utf8')
      return {
        contents: transformCssModule(source, args.path),
        loader: 'js',
      }
    })
  },
}

await build({
  entryPoints: [entryFile],
  outfile: outFile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  sourcemap: true,
  external: [...externalSet],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: 'return module.exports; } });',
  },
  plugins: [cssModulesPlugin],
})
