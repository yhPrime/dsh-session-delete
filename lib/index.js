/**
 * Host half of dsh-session-delete.
 *
 * What "delete" means here
 * ------------------------
 * The Session's log directory and its projection-cache file are moved into the
 * OPERATING SYSTEM's recycle bin — the one the user already knows, with the
 * restore flow they already have. This package keeps no trash of its own: an
 * earlier revision moved logs into `<dsh home>/trash/…` and offered its own
 * restore/purge screen, which meant a deleted Session could linger in the
 * archive while its bytes sat in a second, private bin. That was the wrong
 * shape and it is gone.
 *
 * The whole sequence, in one request
 * ----------------------------------
 * 1. locate   — find `<dsh home>/sessions/<project>/<session-id>`.
 * 2. stop     — `workspaceRegistry.archiveSession(id, { stopActivity: true })`.
 *               Archiving is the official stop signal (the archive set is what
 *               the `agent/pre-step` gate reads), so it is what keeps a live
 *               agent from writing into a log we are about to move.
 * 3. recycle  — hand the log and the projection cache to the OS recycle bin.
 * 4. detach   — `Workspace.detachSession(id)` drops the row from the workspace
 *               list; the archive entry from step 2 is then removed too, so
 *               nothing is left behind in either set.
 *
 * Failure is a rollback, not a half-state. If step 3 fails nothing is detached
 * and the archive from step 2 is undone, so the Session is exactly as visible
 * as it was. There is deliberately NO fallback to a permanent unlink: silently
 * destroying a user's log is not how a recycle failure should be handled.
 *
 * Why the Host half and not the browser half
 * ------------------------------------------
 * The official API cannot remove a Session: `sessionPersistence` offers
 * create/open/flush/stat/list, and `workspaceRegistry` offers archive and pin
 * (plus `Workspace.detachSession`, which was the missing piece and is used
 * above). Anything that touches bytes — or the OS recycle bin — has to live
 * here.
 *
 * The browser half reaches this over the Host's HTTP carrier, which is how a
 * PACKAGED plugin talks to its Host half; `host.call` belongs to the dynamic
 * plugin surface (cordis_define), not to a package's `dsh.client` bundle.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const name = 'dsh-session-delete'

/** Every route this package owns starts with this prefix. */
const PREFIX = '/dsh-session-delete'

/**
 * A Session id. Narrower than the filesystem's rules on purpose.
 *
 * The Host's own id already carries the `session-` prefix — `workspace.json`
 * stores exactly `session-921ab38a-…`, and that is the string the shipped
 * `archiveSession` takes — while a bare uuid is accepted too. So the regex
 * anchors at the first character rather than at the prefix: both shapes pass,
 * and `sessionDirName` below is what turns them into one.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Body cap for every JSON request this package accepts. */
const MAX_BODY = 64 * 1024

/** How long the OS recycle call may take before it is abandoned. */
const RECYCLE_TIMEOUT_MS = 30_000

/**
 * The directory name a Session's log lives in:
 * `<dsh home>/sessions/<project>/<this>`.
 *
 * IDEMPOTENT on purpose. The canonical SessionId and the directory name are
 * the SAME string (`session-<uuid>`), so prefixing unconditionally looked for
 * `session-session-<uuid>` — which is why an earlier revision archived a
 * Session and then answered 404. A bare uuid still works, because the plugin
 * also accepts ids from callers that pass them without the prefix.
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
 * `/home/.dsh-evil` for the root `/home/.dsh`, and this file moves whole
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
 * plain form post arrives with a non-JSON content type — neither can delete a
 * Session. Absent `Origin` (non-browser callers) stays allowed: that is the
 * local operator, whom these routes exist to serve.
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

/**
 * Where one Session's directory actually is.
 *
 * The project directory segment is derived from the Session's working
 * directory and is not something this module can compute, so the Session is
 * located by scanning `sessions/` for `<project>/<session-id>`. The scan never
 * joins caller input: the directory name is built from a validated id and the
 * result is containment-checked before it is returned.
 */
async function findSessionDir(sessionsRoot, sessionDir) {
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(sessionsRoot, project.name, sessionDir)
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

/**
 * The Windows PowerShell every Windows install has.
 *
 * A GUI launch inherits no shell PATH (the market documents this for its own
 * spawns), so `pwsh` cannot be assumed even when a terminal would find it.
 * `%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` ships with
 * the OS, and `Microsoft.VisualBasic` — the assembly that asks the shell to
 * recycle instead of unlink — is available in both 5.1 and 7.
 */
function powershellPath() {
  const fromEnv = process.env.SystemRoot !== undefined
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : null
  const candidates = [fromEnv, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']
  for (const candidate of candidates) {
    if (candidate !== null && existsSync(candidate)) return candidate
  }
  return 'powershell.exe'
}

/** One PowerShell single-quoted literal (the only quoting that is safe here). */
const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`

/**
 * Move paths into the OPERATING SYSTEM's recycle bin.
 *
 * Windows only, deliberately: `Microsoft.VisualBasic.FileIO.FileSystem` is the
 * documented way to ask Explorer to recycle rather than unlink. On any other
 * platform this reports `unsupported-platform` instead of guessing, because the
 * alternative — deleting outright — is not this plugin's call to make.
 *
 * Success is decided by the FILESYSTEM, not by the exit code: the sources must
 * be gone. A partial move reports the paths that are still there.
 */
function recycleToOperatingSystem(paths, options = {}) {
  const timeoutMs = options.timeoutMs ?? RECYCLE_TIMEOUT_MS
  const spawnImpl = options.spawnImpl ?? spawn
  if (process.platform !== 'win32') {
    return Promise.resolve({
      ok: false,
      reason: 'unsupported-platform',
      message: `the OS recycle bin is not implemented for ${process.platform}`,
    })
  }

  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    ...paths.flatMap((target) => [
      `$target = ${psLiteral(target)}`,
      'if (Test-Path -LiteralPath $target -PathType Container) {',
      '  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, "OnlyErrorDialogs", "SendToRecycleBin")',
      '} elseif (Test-Path -LiteralPath $target) {',
      '  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, "OnlyErrorDialogs", "SendToRecycleBin")',
      '}',
    ]),
  ].join('\n')

  return new Promise((settle) => {
    let settled = false
    let stderr = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      settle(result)
    }

    let child
    try {
      child = spawnImpl(powershellPath(), [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      finish({ ok: false, reason: 'recycle-failed', message: String(error?.message ?? error) })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone; the filesystem check below still decides.
      }
      finish({ ok: false, reason: 'recycle-failed', message: `the recycle call did not finish within ${timeoutMs} ms` })
    }, timeoutMs)

    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on?.('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, reason: 'recycle-failed', message: String(error?.message ?? error) })
    })
    child.on?.('close', (code) => {
      clearTimeout(timer)
      const left = paths.filter((target) => existsSync(target))
      if (left.length === 0) {
        finish({ ok: true, recycled: paths })
        return
      }
      const detail = stderr.trim() === '' ? '' : ` — ${stderr.trim().split('\n').slice(-3).join(' ')}`
      finish({ ok: false, reason: 'recycle-failed', message: `still on disk: ${left.join(', ')} (exit ${String(code)})${detail}` })
    })
  })
}

/** The registry face this module needs, or `null` when the Host has none. */
function workspaceRegistryOf(hostCtx) {
  const registry = hostCtx?.get?.('workspaceRegistry') ?? hostCtx?.workspaceRegistry
  if (registry === undefined || registry === null) return null
  return typeof registry.list === 'function' ? registry : null
}

/**
 * The in-memory session store, or `null` when the Host has none.
 *
 * Read for ONE question: is this Session loaded in the running process? A live
 * Session leaves that store only when its OWNER fiber disposes — the store
 * offers create/prepare/enter/announce/flush/get/list/fork and NO removal — and
 * that disposer belongs to whoever created the Session (the agent factory's
 * composite teardown), not to a plugin. So this delete cannot un-load it, and
 * the sidebar keeps rendering it until the next start.
 *
 * The answer rides along in the response as `wasLive`, for diagnosis. The UI no
 * longer branches on it: the result box always says the Session leaves on
 * restart, which is true whether or not this process had loaded it.
 */
function sessionsStoreOf(hostCtx) {
  const store = hostCtx?.get?.('sessions') ?? hostCtx?.sessions
  return store !== undefined && store !== null && typeof store.get === 'function' ? store : null
}

/**
 * Read-only: does this Session's directory exist, and where?
 *
 * "A Session that cannot be found" is the one failure a user cannot diagnose
 * from the UI, and this is also how an install is verified without moving
 * anything: it never mutates, and it refuses every id that could not become a
 * path anyway.
 */
async function locateSession(home, sessionId) {
  const wanted = sessionDirName(sessionId)
  const found = await findSessionDir(join(home, 'sessions'), wanted)
  if (found === null) return { ok: false, reason: 'not-found', sessionId, lookedFor: wanted }
  return {
    ok: true,
    sessionId,
    lookedFor: wanted,
    dir: found.dir,
    project: found.project,
    projectionCache: existsSync(join(home, 'storages', 'session_projcache', 'sessions', `${wanted}.json`)),
  }
}

/**
 * Whether the workspace registry still accounts for this id, read from its own
 * durable file.
 *
 * The registry service cannot answer this: `Workspace.sessionIds` is filtered
 * by the session-header index, and the archive and pin sets have no getter at
 * all. Reading `workspace.json` is read-only and answers all three at once —
 * which is what makes a ROW WITH NO LOG (the state an earlier revision could
 * produce) deletable instead of permanently stuck.
 */
async function registryPresence(home, sessionId) {
  try {
    const document = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'))
    const global = document?.global ?? {}
    const list = (value) => (Array.isArray(value) ? value : [])
    const workspaces = document?.tables?.workspaces ?? {}
    return {
      archived: list(global.archivedSessionIds).includes(sessionId),
      pinned: list(global.pinnedSessionIds).includes(sessionId),
      listed: Object.values(workspaces).some((workspace) => list(workspace?.sessionIds).includes(sessionId)),
    }
  } catch {
    return { archived: false, pinned: false, listed: false }
  }
}

/**
 * Delete one Session: stop it, recycle its bytes, then take it out of both
 * registry sets. The module header has the order, and why a failure rolls back
 * instead of half-applying.
 *
 * A Session that has a ROW but no log is not an error: there is simply nothing
 * to recycle, so the row is taken out and the answer says so (`removedOnly`).
 * Only an id that is neither on disk nor in the registry is `not-found`.
 */
async function deleteSession({ home, sessionId, registry, sessions = null, recycle = recycleToOperatingSystem }) {
  const located = await locateSession(home, sessionId)
  const presence = await registryPresence(home, sessionId)
  if (located.ok !== true && presence.listed !== true && presence.archived !== true && presence.pinned !== true) {
    return { ok: false, reason: 'not-found', sessionId, lookedFor: located.lookedFor }
  }

  // Loaded in this process? See sessionsStoreOf — it cannot be un-loaded here,
  // and that is exactly what leaves a row behind after the delete.
  const wasLive = sessions !== null && sessions.get(sessionId) !== undefined

  const wanted = located.lookedFor ?? sessionDirName(sessionId)
  const projectionCache = join(home, 'storages', 'session_projcache', 'sessions', `${wanted}.json`)
  const targets = located.ok === true
    ? (located.projectionCache === true ? [located.dir, projectionCache] : [located.dir])
    : []

  // 1. Stop it — only when there is a log to protect. Archiving is the official
  //    stop signal (the archive set is what the `agent/pre-step` gate reads),
  //    and the id is taken back out of that set once the bytes are gone.
  let archivedForStop = false
  if (targets.length > 0 && registry !== null) {
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      archivedForStop = true
    } catch {
      // Not fatal: the recycle below still has to succeed, and a log held open
      // by a live Session fails there rather than being moved underneath it.
      archivedForStop = false
    }
  }

  // 2. Move the bytes to the OS recycle bin.
  if (targets.length > 0) {
    const recycled = await recycle(targets)
    if (recycled.ok !== true) {
      if (archivedForStop === true && registry !== null) {
        try {
          await registry.unarchiveSession(sessionId)
        } catch {
          // Best effort: the point is to leave the Session as visible as it was.
        }
      }
      return {
        ok: false,
        reason: recycled.reason ?? 'recycle-failed',
        sessionId,
        message: recycled.message ?? 'the operating system recycle bin refused the move',
      }
    }
  }

  // 3. Take it out of the workspace list, then out of the archive and pin sets.
  //    All are attempted even if one fails, and all are reported rather than
  //    thrown: the bytes are already recycled, which is what the user asked for.
  const notes = []
  if (registry !== null) {
    try {
      for (const workspace of registry.list()) {
        const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
        if (!ids.includes(sessionId)) continue
        await workspace.detachSession(sessionId)
        notes.push(`detached from ${String(workspace.title ?? workspace.id)}`)
      }
    } catch (error) {
      notes.push(`detach failed: ${String(error?.message ?? error)}`)
    }
    try {
      await registry.unarchiveSession(sessionId)
    } catch (error) {
      notes.push(`unarchive failed: ${String(error?.message ?? error)}`)
    }
  } else {
    notes.push('no workspace registry: the row may linger until the next start')
  }
  if (presence.listed === true && notes.some((note) => note.startsWith('detached from')) === false) {
    // The file says it was listed but the service did not report it — say so
    // rather than claiming a clean removal.
    notes.push('the registry did not report this row; it may clear on the next start')
  }

  return { ok: true, sessionId, recycled: targets, removedOnly: targets.length === 0, wasLive, notes }
}

/**
 * Register every route on the Host's HTTP carrier.
 *
 * Each `register` returns the disposer for its own row, so the caller's
 * `ctx.effect` unwinds all of them together when the plugin unloads.
 */
function mountRoutes(hostCtx, options = {}) {
  const webServer = hostCtx.webServer ?? hostCtx.get?.('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') return () => {}

  const home = resolveDshHome()
  const recycle = options.recycle ?? recycleToOperatingSystem
  const disposers = []

  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }

  const guard = (request, response) => {
    if (sameOrigin(request)) return true
    sendJson(response, 403, { error: 'cross-origin request refused' })
    return false
  }

  /** Both routes share this shape: POST, one session id, one JSON answer. */
  const withSessionId = (work) => async (request, response) => {
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
      await work(sessionId, response)
    } catch (error) {
      sendJson(response, 400, { error: String(error?.message ?? error) })
    }
  }

  route(`${PREFIX}/locate`, withSessionId(async (sessionId, response) => {
    const result = await locateSession(home, sessionId)
    if (result.ok === true) {
      sendJson(response, 200, result)
      return
    }
    sendJson(response, 404, { ...result, error: `no log directory for ${result.lookedFor}` })
  }))

  route(`${PREFIX}/delete`, withSessionId(async (sessionId, response) => {
    const result = await deleteSession({
      home,
      sessionId,
      registry: workspaceRegistryOf(hostCtx),
      sessions: sessionsStoreOf(hostCtx),
      recycle,
    })
    if (result.ok === true) {
      sendJson(response, 200, result)
      return
    }
    const status = result.reason === 'not-found' ? 404 : result.reason === 'unsupported-platform' ? 501 : 500
    sendJson(response, status, { ...result, error: result.message ?? `delete failed: ${String(result.reason)}` })
  }))

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
 * `ctx.inject` is nested rather than an `export const inject` array, which is
 * the shape the market uses for exactly this reason: the plugin mounts whether
 * or not the HTTP carrier has appeared yet, and it waits when it has not. The
 * registry is looked up per request instead, so a Host without one still gets
 * the recycle half and says so in the answer.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => mountRoutes(hostCtx), 'dsh-session-delete: routes')
  })
}

/** Exported for the dry-run harness; not part of the plugin surface. */
export const __test__ = {
  resolveDshHome,
  safeSessionId,
  sessionDirName,
  isInside,
  findSessionDir,
  locateSession,
  deleteSession,
  mountRoutes,
}
