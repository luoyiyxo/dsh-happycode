/**
 * Pre-pack gate.
 *
 * Runs from `npm pack` / `npm publish`. It fails the packaging when the tarball
 * would be unusable in DSH: a missing entry artifact, a client bundle that does
 * not register the package name, a patch row that names another package, a
 * version that does not match the changelog, or development files leaking in.
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const notes = []

function fail (message) { failures.push(message) }
function note (message) { notes.push(message) }

function read (file) {
  try {
    const text = readFileSync(join(ROOT, file), 'utf8')
    // A BOM survives most tooling but breaks JSON.parse and shows up as a stray
    // glyph in rendered markdown — refuse it rather than ship it.
    if (text.charCodeAt(0) === 0xfeff) {
      fail(`${file} starts with a UTF-8 BOM; rewrite it without one`)
      return text.slice(1)
    }
    return text
  } catch {
    fail(`missing ${file}`)
    return ''
  }
}

function exists (file) {
  try {
    return statSync(join(ROOT, file)).isFile()
  } catch {
    return false
  }
}

const packageJson = JSON.parse(read('package.json') || '{}')

// --- identity ---------------------------------------------------------------

if (packageJson.name !== 'dsh-happycode') fail(`package name must be dsh-happycode, found ${JSON.stringify(packageJson.name)}`)
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(packageJson.version ?? '')) fail(`version is not semver: ${packageJson.version}`)
if (packageJson.type !== 'module') fail('type must be "module" (the host half is ESM)')

// --- host contract ----------------------------------------------------------

if (packageJson.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch must point at ./cordis.patch.yml')
if (packageJson.dsh?.client?.platform !== 'web') fail('dsh.client.platform must be "web"')
const injected = packageJson.dsh?.client?.inject
if (!Array.isArray(injected) || injected.length === 0) fail('dsh.client.inject must list the client packages this bundle needs')
if (packageJson.exports?.['./client'] !== './client/client.js') fail('exports["./client"] must be ./client/client.js')

const patch = read('cordis.patch.yml')
if (!patch.includes('name: \'dsh-happycode\'') && !patch.includes('name: dsh-happycode')) {
  fail('cordis.patch.yml must insert an entry named dsh-happycode')
}
if (!/^\s*-\s*insert:/m.test(patch)) fail('cordis.patch.yml must use an insert block')

// --- artifacts --------------------------------------------------------------

for (const file of ['lib/index.js', 'client/client.js', 'README.md', 'README.zh.md', 'LICENSE', 'CHANGELOG.md']) {
  if (!exists(file)) fail(`missing artifact ${file}`)
}
if (!exists('assets/logo.svg')) note('assets/logo.svg is missing; the plugin list will show no icon')

const client = read('client/client.js')
if (!client.includes("id: 'dsh-happycode'")) fail('client bundle does not register the module id dsh-happycode')
if (!client.includes('__ModuleLoader__')) fail('client bundle does not register with window.__ModuleLoader__')
if (!/exports\.apply\s*=/.test(client)) fail('client bundle does not export apply()')
// XML namespace identifiers are names, not addresses; nothing is fetched.
const ALLOWED_URLS = [/^https?:\/\/www\.w3\.org\//]
const urlPattern = /https?:\/\/[^\s'"`)]+/g
for (const line of client.split('\n')) {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue
  for (const match of line.match(urlPattern) ?? []) {
    if (ALLOWED_URLS.some(allowed => allowed.test(match))) continue
    fail(`client bundle contains a URL: ${match}`)
  }
}

const server = read('lib/index.js')
if (!/export function apply/.test(server)) fail('lib/index.js does not export apply()')
if (!/export const name/.test(server)) fail('lib/index.js does not export the plugin name')

// --- packaging hygiene ------------------------------------------------------

const files = packageJson.files ?? []
for (const entry of ['lib', 'client', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  if (!files.includes(entry)) fail(`files[] must include ${entry}`)
}
for (const entry of ['node_modules', 'test', 'scripts', '.npmrc']) {
  if (files.includes(entry)) fail(`files[] must not include ${entry}`)
}

// --- version / changelog ----------------------------------------------------

const changelog = read('CHANGELOG.md')
if (changelog !== '' && !changelog.includes(`## ${packageJson.version}`)) {
  fail(`CHANGELOG.md has no section for ${packageJson.version}`)
}

// --- engines ----------------------------------------------------------------

if (!packageJson.engines?.dsh) fail('engines.dsh must declare the tested host line')
if (!packageJson.engines?.node) fail('engines.node must declare the minimum Node')

// --- report -----------------------------------------------------------------

for (const message of notes) console.log(`note: ${message}`)
if (failures.length > 0) {
  console.error('prepack check failed:')
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}
console.log(`prepack check passed for ${packageJson.name}@${packageJson.version}`)
