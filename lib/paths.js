/**
 * Locating the DSH home, the active profile and the plugin's own data
 * directory.
 *
 * Every path here is *read* except `<profile>/.dsh-happycode/`, which is the
 * one directory this plugin writes. The session logs and the projection cache
 * are opened read-only.
 *
 * @module dsh-happycode/paths
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Directory name this plugin owns inside the profile. */
export const DATA_DIR_NAME = '.dsh-happycode'

/** Expand the tilde forms DSH configuration accepts. */
export function expandHomePath (path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the Harness home: explicit configuration, then `DSH_HOME`, then
 * `~/.dsh`. A blank environment value counts as unset.
 */
export function resolveDshHome (configured, env = process.env) {
  const fromEnv = env.DSH_HOME
  const configuredUsable = typeof configured === 'string' && configured.trim() !== ''
  const selected = configuredUsable
    ? configured
    : (typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh'))
  return resolve(expandHomePath(selected))
}

/**
 * Whether a string may be used as one profile directory segment.
 * Dots, spaces and Unicode are ordinary; separators and traversal are not.
 */
export function isProfileName (name) {
  return typeof name === 'string'
    && name !== ''
    && name !== '.'
    && name !== '..'
    && name !== 'node_modules'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0')
}

/**
 * The profile this process was launched into, as the launcher reports it.
 *
 * `profileContext` is the launcher-owned service (`{ name, dir }`); it is the
 * only source that knows where a non-default profile lives. Everything else
 * is a fallback for hosts that do not publish it.
 *
 * @param {object} [ctx] - cordis context, for `ctx.get`.
 * @param {NodeJS.ProcessEnv} [env] - environment.
 * @param {string[]} [argv] - process argv, for `--profile`.
 * @returns {{ name: string, dir: string }}
 */
export function resolveProfile (ctx, env = process.env, argv = process.argv) {
  const home = resolveDshHome(undefined, env)
  let context
  try {
    context = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
  } catch {
    context = undefined
  }
  if (context && typeof context === 'object' && isProfileName(context.name)) {
    const dir = typeof context.dir === 'string' && context.dir.trim() !== ''
      ? resolve(expandHomePath(context.dir))
      : join(home, 'profiles', context.name)
    return { name: context.name, dir }
  }

  const fromEnv = typeof env.DSH_PROFILE === 'string' && isProfileName(env.DSH_PROFILE) ? env.DSH_PROFILE : undefined
  const flagAt = argv.indexOf('--profile')
  const fromArgv = flagAt !== -1 && isProfileName(argv[flagAt + 1]) ? argv[flagAt + 1] : undefined
  const profilesRoot = join(home, 'profiles')
  let name = fromArgv ?? fromEnv
  if (name === undefined) {
    // No declaration and no flag: an install with exactly one profile is
    // unambiguous, and reading its name beats inventing `web`.
    const known = listProfileNames(profilesRoot)
    name = known.length === 1 ? known[0] : 'web'
  }
  return { name, dir: join(profilesRoot, name) }
}

/** Profile directory names present under `profiles/`, newest first. */
function listProfileNames (profilesRoot) {
  try {
    return readdirSync(profilesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && isProfileName(entry.name) && !entry.name.startsWith('.'))
      .map(entry => {
        let mtime = 0
        try { mtime = statSync(join(profilesRoot, entry.name)).mtimeMs } catch { /* ignore */ }
        return { name: entry.name, mtime }
      })
      .filter(entry => existsSync(join(profilesRoot, entry.name, 'package.json')))
      .sort((a, b) => b.mtime - a.mtime)
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/**
 * The paths this plugin works with.
 * @returns {{ home: string, profile: string, profileDir: string, dataDir: string, sessionsRoot: string, projcacheRoot: string }}
 */
export function resolvePaths (ctx, env = process.env, argv = process.argv) {
  const home = resolveDshHome(undefined, env)
  const profile = resolveProfile(ctx, env, argv)
  return {
    home,
    profile: profile.name,
    profileDir: profile.dir,
    dataDir: join(profile.dir, DATA_DIR_NAME),
    sessionsRoot: join(home, 'sessions'),
    projcacheRoot: join(home, 'storages', 'session_projcache', 'sessions'),
  }
}

/**
 * Whether an absolute path stays inside a root (used before any write).
 */
export function isInside (root, candidate) {
  const normalizedRoot = resolve(root)
  const normalized = resolve(candidate)
  if (normalized === normalizedRoot) return true
  const prefix = normalizedRoot.endsWith('\\') || normalizedRoot.endsWith('/') ? normalizedRoot : normalizedRoot + (normalizedRoot.includes('\\') ? '\\' : '/')
  return normalized.startsWith(prefix) && isAbsolute(normalized)
}
