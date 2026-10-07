/**
 * Host half of dsh-session-delete — the Session 回收站 (trash).
 *
 * Why this half exists at all
 * ---------------------------
 * The official API has NO way to remove a Session's persisted bytes.
 * `workspaceRegistry` / `uiWorkspace` offer archive / unarchive / pin / unpin,
 * and the `sessionPersistence` service offers create / open / flush / stat /
 * list. Nothing deletes. So on the official path "delete" can only ever mean
 * "hide" (archive). Anything that actually moves bytes has to live here, in
 * this package's own Host half.
 *
 * What it does — and what it refuses to do
 * ---------------------------------------
 * A Session is never deleted outright. `POST /trash` MOVES one Session's
 * directory out of `<dsh home>/sessions/<project>/` into
 * `<dsh home>/trash/dsh-session-delete/<stamp>--<sessionId>/`, carries its
 * projection-cache file along, and writes a `trash.json` recording where it
 * came from. `restore` moves it back. Only `purge` — behind an explicit
 * confirmation in the UI — actually unlinks bytes.
 *
 * How the browser half reaches this
 * ---------------------------------
 * Over the Host's own HTTP carrier (`ctx.webServer`). That is how a PACKAGED
 * plugin talks to its Host half: the market ships 48 routes this way. The
 * `host.call(...)` builtin belongs to the DYNAMIC plugin surface
 * (cordis_define), not to a package's `dsh.client` bundle, so it is
 * deliberately not used here.
 *
 * Safety rules, all load-bearing
 * ------------------------------
 * 1. A Session id is validated against a narrow character class BEFORE any
 *    path is built, so a traversal-shaped id cannot exist rather than being
 *    caught later.
 * 2. Every path this module touches is re-checked with `isInside` against the
 *    root it is supposed to live under. The check runs on the path as joined,
 *    so a symlinked project directory still resolves inside `sessions/`.
 * 3. Nothing outside `<dsh home>` is ever read or written. `DSH_HOME` wins
 *    when set, matching `@deepseek-ai/dsh-home-paths`.
 * 4. `purge` requires `confirm: true` in the body. The UI's typed
 *    confirmation is the only caller that sends it.
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const name = 'dsh-session-delete'

/** Every route this package owns starts with this prefix. */
const PREFIX = '/dsh-session-delete'

/** Namespaced trash root inside the Harness home — never a bare `trash/`,
 *  so nothing else's directory can be mistaken for ours on a purge. */
const TRASH_SEGMENTS = ['trash', 'dsh-session-delete']

/**
 * A Session id. Narrower than the filesystem's rules on purpose.
 *
 * The Host's own id already carries the `session-` prefix — `workspace.json`
 * stores exactly `session-921ab38a-…`, and that is the string the shipped
 * `archiveSession` is called with — while a bare uuid is accepted too. So the
 * regex anchors at the first character rather than at the prefix: both shapes
 * pass, and `sessionDirName` below is what turns them into one.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** A trash entry directory name: `<stamp>--<sessionId>`. */
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/** Body cap for every JSON request this package accepts. */
const MAX_BODY = 64 * 1024

/**
 * The directory name a Session's log lives in:
 * `<dsh home>/sessions/<project>/<this>`.
 *
 * IDEMPOTENT on purpose. The canonical SessionId and the directory name are
 * the SAME string (`session-<uuid>`), so prefixing unconditionally looked for
 * `session-session-<uuid>` — which is why the first release archived a Session
 * and then answered 404 from the trash route. A bare uuid still works, because
 * the plugin also accepts ids from callers that pass them without the prefix.
 */
const sessionDirName = (sessionId) => (sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`)

/**
 * The Harness home, with the same semantics as `@deepseek-ai/dsh-home-paths`:
 * an explicit value, then a non-blank `DSH_HOME`, then `~/.dsh`, normalized to
 * one absolute path.
 */
function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  const expanded = selected === '~'
    ? homedir()
    : selected.startsWith('~/') || selected.startsWith('~\\')
      ? join(homedir(), selected.slice(2))
      : selected
  return resolve(expanded)
}

/**
 * Whether `target` sits strictly inside `root`.
 *
 * `relative` is the honest test — a string prefix comparison passes
 * `/home/.dsh-evil` for the root `/home/.dsh`, and this file moves
 * directories, so a near-miss is a real one.
 */
function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** A Session id that is safe to build a path from — or `null`. */
function safeSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) return null
  if (value === '.' || value === '..') return null
  return value
}

/** A trash entry name this module could have written — or `null`. */
function safeEntryName(value) {
  if (typeof value !== 'string' || !ENTRY.test(value)) return null
  if (value.includes('..') || !value.includes('--')) return null
  return value
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * A same-origin guard for a local UI.
 *
 * The page is served by this same Host, so a browser request carries its own
 * `Origin`. A request from another site arrives with a different one, and a
 * plain form post arrives with a non-JSON content type — neither can move a
 * Session into the trash. Absent `Origin` (non-browser callers) stays allowed:
 * that is the local operator, whom this route exists to serve.
 */
function sameOrigin(request) {
  const origin = request.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === request.headers?.host
  } catch {
    return false
  }
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/** A Windows-safe, sortable stamp: `2026-10-07T22-11-30-123Z`. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Where one Session's directory actually is.
 *
 * The project directory segment is derived from the Session's working
 * directory and is not something this module can compute, so the Session is
 * located by scanning `sessions/` for `<project>/session-<id>`. The scan never
 * joins caller input: the directory name is built from a validated id and the
 * result is containment-checked before it is returned.
 */
async function findSessionDir(sessionsRoot, sessionId) {
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  const wanted = sessionDirName(sessionId)
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(sessionsRoot, project.name, wanted)
    if (!isInside(sessionsRoot, candidate)) continue
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return { dir: candidate, project: project.name }
    } catch {
      // Not here; keep looking.
    }
  }
  return null
}

/** Every trash entry, newest first. Unreadable entries are skipped, not fatal. */
async function listEntries(trashRoot) {
  let names
  try {
    names = await readdir(trashRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const entries = []
  for (const dirent of names) {
    if (!dirent.isDirectory()) continue
    const entry = safeEntryName(dirent.name)
    if (entry === null) continue
    const dir = join(trashRoot, entry)
    if (!isInside(trashRoot, dir)) continue
    let meta = null
    try {
      meta = JSON.parse(await readFile(join(dir, 'trash.json'), 'utf8'))
    } catch {
      meta = null
    }
    entries.push({
      entry,
      sessionId: typeof meta?.sessionId === 'string' ? meta.sessionId : entry.split('--').pop(),
      movedAt: typeof meta?.movedAt === 'string' ? meta.movedAt : null,
      project: typeof meta?.project === 'string' ? meta.project : null,
    })
  }
  entries.sort((left, right) => (right.movedAt ?? right.entry).localeCompare(left.movedAt ?? left.entry))
  return entries
}

/**
 * Move one archived Session into the trash.
 *
 * The caller is expected to have archived it first (`archiveSession` with
 * `stopActivity`), which is what stops a running agent from holding the log
 * open. This module does not verify that: archiving is the client's step, and
 * a Session with no directory simply reports `not-found`.
 */
async function trashSession(home, sessionId) {
  const sessionsRoot = join(home, 'sessions')
  const trashRoot = join(home, ...TRASH_SEGMENTS)
  const found = await findSessionDir(sessionsRoot, sessionId)
  if (found === null) return { ok: false, reason: 'not-found' }

  const entry = `${stamp()}--${sessionId}`
  const entryDir = join(trashRoot, entry)
  if (!isInside(trashRoot, entryDir)) return { ok: false, reason: 'unsafe' }

  await mkdir(trashRoot, { recursive: true })
  await mkdir(entryDir, { recursive: true })

  // The projection cache is a separate file the Session owns. Carrying it
  // along is what makes `restore` a true undo rather than an approximation.
  const projcache = join(home, 'storages', 'session_projcache', 'sessions', `${sessionDirName(sessionId)}.json`)
  let movedCache = false
  try {
    await stat(projcache)
    await rename(projcache, join(entryDir, 'session_projcache.json'))
    movedCache = true
  } catch {
    movedCache = false
  }

  try {
    await rename(found.dir, join(entryDir, sessionDirName(sessionId)))
  } catch (error) {
    // Put the cache back so a failed move leaves the Session exactly as it was.
    if (movedCache) {
      try {
        await rename(join(entryDir, 'session_projcache.json'), projcache)
      } catch {
        // Best effort; the trash entry is removed below either way.
      }
    }
    await rm(entryDir, { recursive: true, force: true })
    return { ok: false, reason: 'move-failed', message: String(error?.message ?? error) }
  }

  await writeFile(join(entryDir, 'trash.json'), `${JSON.stringify({
    sessionId,
    project: found.project,
    origin: found.dir,
    movedAt: new Date().toISOString(),
    movedProjectionCache: movedCache,
  }, null, 2)}\n`, 'utf8')

  return { ok: true, entry }
}

/** Put a trashed Session back exactly where it came from. */
async function restoreEntry(home, entry) {
  const sessionsRoot = join(home, 'sessions')
  const trashRoot = join(home, ...TRASH_SEGMENTS)
  const entryDir = join(trashRoot, entry)
  if (!isInside(trashRoot, entryDir)) return { ok: false, reason: 'unsafe' }

  let meta
  try {
    meta = JSON.parse(await readFile(join(entryDir, 'trash.json'), 'utf8'))
  } catch {
    return { ok: false, reason: 'no-metadata' }
  }

  const sessionId = safeSessionId(meta?.sessionId)
  const origin = typeof meta?.origin === 'string' ? meta.origin : null
  if (sessionId === null || origin === null) return { ok: false, reason: 'no-metadata' }
  if (!isInside(sessionsRoot, origin) || origin.split(/[\\/]/).pop() !== sessionDirName(sessionId)) {
    return { ok: false, reason: 'unsafe' }
  }

  const payload = join(entryDir, sessionDirName(sessionId))
  try {
    await stat(payload)
  } catch {
    return { ok: false, reason: 'not-found' }
  }

  try {
    await mkdir(dirname(origin), { recursive: true })
    await rename(payload, origin)
  } catch (error) {
    return { ok: false, reason: 'move-failed', message: String(error?.message ?? error) }
  }

  if (meta?.movedProjectionCache === true) {
    const target = join(home, 'storages', 'session_projcache', 'sessions', `${sessionDirName(sessionId)}.json`)
    try {
      await mkdir(dirname(target), { recursive: true })
      await rename(join(entryDir, 'session_projcache.json'), target)
    } catch {
      // The log is back, which is what matters; the cache rebuilds itself.
    }
  }

  await rm(entryDir, { recursive: true, force: true })
  return { ok: true, sessionId }
}

/** Unlink one entry, or every entry. The only irreversible step in the file. */
async function purge(home, entry) {
  const trashRoot = join(home, ...TRASH_SEGMENTS)
  if (entry === null || entry === undefined) {
    const entries = await listEntries(trashRoot)
    let removed = 0
    for (const item of entries) {
      const dir = join(trashRoot, item.entry)
      if (!isInside(trashRoot, dir)) continue
      await rm(dir, { recursive: true, force: true })
      removed += 1
    }
    return { ok: true, removed }
  }

  const name = safeEntryName(entry)
  if (name === null) return { ok: false, reason: 'unsafe' }
  const dir = join(trashRoot, name)
  if (!isInside(trashRoot, dir)) return { ok: false, reason: 'unsafe' }
  try {
    await stat(dir)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  await rm(dir, { recursive: true, force: true })
  return { ok: true, removed: 1 }
}

/**
 * Register every route on the Host's HTTP carrier.
 *
 * Each `register` returns the disposer for its own row, so the caller's
 * `ctx.effect` unwinds all of them together when the plugin unloads.
 */
function mountRoutes(webServer) {
  const home = resolveDshHome()
  const trashRoot = join(home, ...TRASH_SEGMENTS)
  const disposers = []

  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }

  const guard = (request, response) => {
    if (sameOrigin(request)) return true
    sendJson(response, 403, { error: 'cross-origin request refused' })
    return false
  }

  /**
   * Read-only: does this Session's directory exist, and where?
   *
   * "A Session that cannot be found" is the one failure a user cannot diagnose
   * from the UI, and this is also how an install is verified without moving
   * anything. It never mutates, and it refuses every id that could not become a
   * path anyway, so a probe cannot be turned into a probe-and-move.
   */
  route(`${PREFIX}/trash/locate`, async (request, response) => {
    if (!guard(request, response)) return
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    try {
      const body = await readJson(request)
      const sessionId = safeSessionId(body.sessionId)
      if (sessionId === null) {
        sendJson(response, 400, { error: 'sessionId must be a session id' })
        return
      }
      const wanted = sessionDirName(sessionId)
      const found = await findSessionDir(join(home, 'sessions'), wanted)
      if (found === null) {
        sendJson(response, 404, { ok: false, reason: 'not-found', sessionId, lookedFor: wanted })
        return
      }
      sendJson(response, 200, {
        ok: true,
        sessionId,
        lookedFor: wanted,
        dir: found.dir,
        project: found.project,
        projectionCachePresent: existsSync(join(home, 'storages', 'session_projcache', 'sessions', `${wanted}.json`)),
      })
    } catch (error) {
      sendJson(response, 400, { error: String(error?.message ?? error) })
    }
  })

  route(`${PREFIX}/trash`, async (request, response) => {
    if (!guard(request, response)) return
    if (request.method === 'GET') {
      sendJson(response, 200, { home, root: trashRoot, entries: await listEntries(trashRoot) })
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, POST' })
      response.end()
      return
    }
    try {
      const body = await readJson(request)
      const sessionId = safeSessionId(body.sessionId)
      if (sessionId === null) {
        sendJson(response, 400, { error: 'sessionId must be a session id' })
        return
      }
      const result = await trashSession(home, sessionId)
      sendJson(response, result.ok ? 200 : result.reason === 'not-found' ? 404 : 500, result)
    } catch (error) {
      sendJson(response, 400, { error: String(error?.message ?? error) })
    }
  })

  route(`${PREFIX}/trash/restore`, async (request, response) => {
    if (!guard(request, response)) return
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    try {
      const body = await readJson(request)
      const entry = safeEntryName(body.entry)
      if (entry === null) {
        sendJson(response, 400, { error: 'entry must be a trash entry name' })
        return
      }
      const result = await restoreEntry(home, entry)
      sendJson(response, result.ok ? 200 : result.reason === 'not-found' ? 404 : 500, result)
    } catch (error) {
      sendJson(response, 400, { error: String(error?.message ?? error) })
    }
  })

  route(`${PREFIX}/trash/purge`, async (request, response) => {
    if (!guard(request, response)) return
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    try {
      const body = await readJson(request)
      if (body.confirm !== true) {
        sendJson(response, 400, { error: 'purge needs confirm: true' })
        return
      }
      const entry = body.entry === undefined || body.entry === null ? null : safeEntryName(body.entry)
      if (entry === null && body.entry !== undefined && body.entry !== null) {
        sendJson(response, 400, { error: 'entry must be a trash entry name' })
        return
      }
      sendJson(response, 200, await purge(home, entry))
    } catch (error) {
      sendJson(response, 400, { error: String(error?.message ?? error) })
    }
  })

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // A row that refuses to unwind must not stop the others.
      }
    }
  }
}

/**
 * Mount without ever gating the Host's boot.
 *
 * `ctx.inject` (nested, not an `export const inject` array) is the shape the
 * market uses for exactly this reason: the plugin mounts whether or not the
 * HTTP carrier has appeared yet, and it waits when it has not. If this Host
 * has no carrier at all, the Session deletion UI still renders — its trash
 * action reports that the Host half is unavailable instead of the page
 * blanking.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.webServer ?? hostCtx.get?.('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    hostCtx.effect(() => mountRoutes(webServer), 'dsh-session-delete: routes')
  })
}

/** Exported for the dry-run harness; not part of the plugin surface. */
export const __test__ = { resolveDshHome, safeSessionId, safeEntryName, isInside, trashSession, restoreEntry, purge, listEntries, mountRoutes }
