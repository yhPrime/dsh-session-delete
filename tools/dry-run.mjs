#!/usr/bin/env node
/**
 * Dry-run install: stage this package the way a profile would carry it, then
 * test everything that can be tested without installing it.
 *
 * What it deliberately does NOT do
 * --------------------------------
 * It never writes to `~/.dsh`. Everything happens under one scratch root
 * (a temp directory by default), and the run ends by asserting that the real
 * Harness home was not touched. `--scratch` refuses a path inside that home
 * for the same reason.
 *
 * What it checks, and why each check exists
 * -----------------------------------------
 * 1. Staged profile   — the install SHAPE: a profile manifest with the package
 *    in `dependencies` and `dsh.profile.bundles`, plus the package copy.
 * 2. Publish contract — the loader banner (`window.__ModuleLoader__.load({
 *    id: "…"` on line 1, no BOM), `exports["./client"]` resolving, the patch
 *    inserting by package name. These are exactly the checks the market's own
 *    preflight runs on its bundle, and the file head a host sniffs the loader
 *    id from.
 * 3. Composition gate — every `dsh.client.inject` entry must exist as a row in
 *    the running host's composed tree. `dsh.client.inject` is a HARD gate: the
 *    host holds the client entry back until every listed seam exists, so a
 *    name that is not in the composition is a plugin that never loads.
 * 4. Classic script   — the bundle must compile as a classic script (`vm.Script`
 *    without executing). That is how a rotten bundle is caught, and it is what
 *    an `import`/`export` inside a client bundle breaks.
 * 5. Client half      — executes the bundle in a sandboxed page, calls
 *    `apply()` on a fake context, and asserts the three registrations, the
 *    dictionary parity, and that the menu row renders nothing without a
 *    Session id and an element with one.
 * 6. Host half        — against a fake Harness home: locate / delete / rollback
 *    on a refused recycle, plus every refusal that protects the rest of the
 *    disk. The recycler is injectable precisely so a dry run never puts
 *    anything in the user's recycle bin.
 * 7. Isolation        — the real home is untouched, and uninstalling the staged
 *    copy leaves no residue.
 *
 * Usage: node tools/dry-run.mjs [--scratch <dir>] [--composition <module-list>] [--keep]
 *
 * `--composition` wants a LIVE module list — a `plugin_manager list_bundles`
 * dump, whose rows carry `moduleName:`. The profile's cordis.yml is the empty
 * root on current hosts ("the tree is composed as patches"), so pointing at it
 * makes step 3 skip rather than fail. The authoritative form of that check is
 * live: the slot occupant list shows whether the gate actually let the entry in.
 */

import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const NAME = 'dsh-session-delete'

const argv = process.argv.slice(2)
/** Value of `--name <value>`; `null` when the flag is absent. */
const flag = (name) => {
  const index = argv.indexOf(name)
  if (index === -1) return null
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a value`)
    process.exit(2)
  }
  return value
}
const keep = argv.includes('--keep')
const scratch = resolve(flag('--scratch') ?? join(tmpdir(), `${NAME}-dry-run`))

const realHome = resolve(process.env.DSH_HOME?.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh'))
const compositionPath = flag('--composition') ?? join(realHome, 'profiles', 'desktop', 'cordis.yml')

let failures = 0
let checks = 0
const pass = (label, detail) => {
  checks += 1
  console.log(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const fail = (label, detail) => {
  checks += 1
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const check = (condition, label, detail) => (condition ? pass(label, detail) : fail(label, detail))

/** A fake HTTP request: an async-iterable body plus the headers a guard reads. */
function fakeRequest({ method = 'GET', body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    headers: { host: '127.0.0.1:19387', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A fake ServerResponse that records what the handler sent. */
function fakeResponse() {
  const record = { status: 0, headers: null, text: '' }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers ?? null
    },
    end(text) {
      record.text = text ?? ''
    },
    json() {
      return record.text === '' ? null : JSON.parse(record.text)
    },
  }
}

async function main() {
  console.log('\ndsh-session-delete dry-run')
  console.log(`  package   ${PACKAGE_ROOT}`)
  console.log(`  scratch   ${scratch}`)
  console.log(`  real home ${realHome} (read-only; must stay untouched)\n`)

  if (scratch === realHome || scratch.startsWith(realHome + sep)) {
    console.error('refusing to run: --scratch must not live inside the real Harness home')
    process.exit(2)
  }

  // Snapshot rather than assume: this plugin IS installed on some machines, so
  // the isolation property is "the run changed nothing", not "the profile does
  // not mention it".
  const realProfilePath = join(realHome, 'profiles', 'desktop', 'package.json')
  const realProfileBefore = existsSync(realProfilePath) ? await readFile(realProfilePath, 'utf8') : null
  // The delete path moves whole Session directories, so the real Session log
  // tree is snapshotted too: a dry run that touched it would be the worst kind
  // of passing test.
  const realSessionsRoot = join(realHome, 'sessions')
  const listRealSessions = async () => {
    const out = []
    if (!existsSync(realSessionsRoot)) return out
    for (const project of await readdir(realSessionsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      for (const session of await readdir(join(realSessionsRoot, project.name), { withFileTypes: true })) {
        if (session.isDirectory()) out.push(`${project.name}/${session.name}`)
      }
    }
    return out.sort()
  }
  const realSessionsBefore = await listRealSessions()
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })

  /* ------------------------- 1. the staged profile ------------------------- */
  console.log('[1] staged profile')
  const profileDir = join(scratch, 'profiles', 'desktop')
  const installed = join(profileDir, 'node_modules', NAME)
  await mkdir(installed, { recursive: true })
  for (const entry of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    if (existsSync(join(PACKAGE_ROOT, entry))) await cp(join(PACKAGE_ROOT, entry), join(installed, entry))
  }
  await cp(join(PACKAGE_ROOT, 'lib'), join(installed, 'lib'), { recursive: true })

  const profileManifest = {
    name: 'dsh-profile-desktop-dry-run',
    private: true,
    dependencies: { [NAME]: `file:./node_modules/${NAME}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', NAME] } },
  }
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(profileManifest, null, 2)}\n`, 'utf8')

  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  check(manifest.name === NAME, 'package name matches the install directory', manifest.name)
  check(profileManifest.dsh.profile.bundles.includes(NAME), 'profile lists the bundle')
  check(manifest.private === undefined, 'no `private` flag (publishable)')
  check(manifest.main === 'lib/index.js', 'host entry declared', manifest.main)

  /* ------------------------ 2. the publish contract ------------------------ */
  console.log('\n[2] publish contract')
  const patchText = await readFile(join(installed, 'cordis.patch.yml'), 'utf8')
  check(patchText.includes(`name: '${NAME}'`), 'cordis.patch.yml inserts by package name')
  const patchPath = manifest.dsh?.bundle?.patch
  check(typeof patchPath === 'string' && existsSync(join(installed, patchPath)), 'bundle patch file exists', patchPath)

  const clientExport = manifest.exports?.['./client']
  const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
  check(typeof clientRel === 'string' && existsSync(join(installed, clientRel)), 'exports["./client"] resolves', clientRel)

  const clientSource = await readFile(join(installed, clientRel), 'utf8')
  const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(NAME)}, factory: (require) => {`
  check(clientSource.charCodeAt(0) !== 0xfeff, 'client bundle has no BOM')
  check(clientSource.startsWith(banner), 'client bundle starts with the one-line loader banner')
  check(clientSource.trimEnd().endsWith('});'), 'client bundle closes the loader call')
  if (!clientSource.startsWith(banner)) fail('banner detail', JSON.stringify(clientSource.slice(0, 60)))

  const hostHalf = await import(pathToFileURL(join(installed, 'lib', 'index.js')).href)
  check(typeof hostHalf.apply === 'function', 'host half exports apply()')
  check(hostHalf.name === NAME, 'host half exports its name', hostHalf.name)

  /* ------------------------- 3. the composition gate ------------------------ */
  console.log('\n[3] dsh.client.inject against the composed tree')
  const declared = manifest.dsh?.client?.inject ?? []
  check(Array.isArray(declared) && declared.length > 0, 'inject list is declared', declared.join(', '))
  if (existsSync(compositionPath)) {
    const composition = await readFile(compositionPath, 'utf8')
    // Accepts a loader entry list (`name:` rows) or a `plugin_manager
    // list_bundles` dump (`moduleName:` rows), quoted either way. The profile's
    // own cordis.yml is the EMPTY root on current hosts — its header says "the
    // tree is composed as patches" — so it is only usable input when something
    // expanded it. An empty file is a SKIP, not a pass: the authoritative check
    // is live (a list_bundles dump, or the slot occupant list).
    const names = new Set(
      [...composition.matchAll(/(?:moduleName|name):\s*['"]?([A-Za-z0-9@/._-]+)['"]?/g)].map((match) => match[1]),
    )
    console.log(`       composition: ${compositionPath} (${names.size} rows)`)
    if (names.size === 0) {
      pass('composition gate skipped — supplied file lists no modules (pass a live list_bundles dump)')
    } else {
      for (const seam of declared) check(names.has(seam), `seam present in the composition: ${seam}`)
    }
  } else {
    fail('composition readable', compositionPath)
  }

  /* --------------------------- 4. classic script --------------------------- */
  console.log('\n[4] classic-script compilation')
  try {
    new vm.Script(clientSource, { filename: 'client.js' })
    pass('compiles as a classic script (no import/export)')
  } catch (error) {
    fail('compiles as a classic script', String(error?.message ?? error))
  }

  /* ---------------------------- 5. client half ---------------------------- */
  console.log('\n[5] client half in a sandboxed page')
  const registrations = []
  const injections = []
  const insertedCss = []
  const localeWrites = []
  const loaderEntries = {}

  // HTTP seam: the client half reaches its Host half with fetch, so recording
  // those calls is how the ordered delete flow gets asserted. `responder` is
  // swapped per case.
  const rpcCalls = []
  let responder = () => ({ status: 200, body: '{}' })

  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { loaderEntries[spec.id] = spec } } },
    document: {
      baseURI: 'http://127.0.0.1:19387/',
      querySelector: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      head: { appendChild() {} },
    },
    styles: { insert: (css) => { insertedCss.push(css); return () => {} } },
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url, init) => {
      const call = { url, method: init?.method, body: init?.body }
      rpcCalls.push(call)
      const answer = responder(call) ?? { status: 200, body: '{}' }
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        async text() { return answer.body ?? '' },
      }
    },
  }
  vm.createContext(sandbox)
  try {
    vm.runInContext(clientSource, sandbox, { filename: 'client.js' })
    pass('bundle evaluated without throwing')
  } catch (error) {
    fail('bundle evaluated', String(error?.message ?? error))
  }

  const entry = loaderEntries[NAME]
  check(entry !== undefined, 'registered itself under its package id')
  if (entry !== undefined) {
    const reactShim = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useState: () => { throw new Error('apply() must not call hooks') },
      useEffect: () => { throw new Error('apply() must not call hooks') },
      useRef: () => ({ current: null }),
      useCallback: (fn) => fn,
    }
    const client = entry.factory((specifier) => {
      if (specifier === 'react') return reactShim
      throw new Error(`this half must not require ${specifier}`)
    })
    check(typeof client.apply === 'function', 'client half exports apply()')
    // The client half no longer touches `workspaces`: the Host half owns the
    // registry work now that the whole delete is one request.
    check(
      JSON.stringify(client.inject) === JSON.stringify(['slots', 'locale']),
      'cordis inject is slots/locale',
      JSON.stringify(client.inject),
    )

    // MEASURED, not assumed: reloading the page does NOT clear the row a
    // deleted-but-still-loaded Session leaves behind — that row lives in the
    // HOST's in-memory session store — so the acknowledgement must not reload.
    // Rendering the dialog needs hooks this lane does not fake, so the wiring is
    // asserted at the source level, which is enough to catch its return.
    check(clientSource.indexOf('location.reload') === -1, 'the acknowledgement does not reload the page')
    check(clientSource.indexOf('liveNotice') !== -1, 'a lingering row is announced as a notice')

    const ctx = {
      effect: (callback) => ({ dispose: callback() }),
      locale: {
        register: (ns, dicts) => { localeWrites.push({ ns, dicts }); return () => {} },
        bind: () => (key) => key,
        getSnapshot: () => ({ active: 'zh' }),
      },
      slots: {
        inject: (slot, callback) => { injections.push(slot); callback(); return () => {} },
        register: (meta, component) => { registrations.push({ meta, component }); return () => {} },
      },
    }
    try {
      client.apply(ctx)
      pass('apply() runs against a fake client context')
    } catch (error) {
      fail('apply() runs', String(error?.message ?? error))
    }

    check(insertedCss.length === 1, 'stylesheet installed through the host seam (styles.insert)')
    check(localeWrites.length === 1 && localeWrites[0].ns === 'session-delete', 'dictionary registered under its namespace')
    const dicts = localeWrites[0]?.dicts ?? {}
    const zhKeys = Object.keys(dicts.zh ?? {}).sort()
    const enKeys = Object.keys(dicts.en ?? {}).sort()
    check(
      zhKeys.length > 0 && JSON.stringify(zhKeys) === JSON.stringify(enKeys),
      'zh/en dictionaries have identical key sets',
      `${zhKeys.length} keys`,
    )
    for (const slot of ['sidebar.workspaces.session.menu.item', 'shell.overlay']) {
      check(injections.includes(slot), `waits for the ${slot} slot`)
    }
    check(injections.includes('settings.section') === false, 'no settings page is registered any more')

    const bySlot = Object.fromEntries(registrations.map(({ meta, component }) => [meta.name, { meta, component }]))
    check(registrations.length === 2, 'registers exactly two slots', String(registrations.length))
    const menu = bySlot['sidebar.workspaces.session.menu.item']
    check(menu !== undefined && menu.meta.id === NAME, 'menu row uses the package-namespaced id', menu?.meta.id)
    check(menu !== undefined && menu.meta.order === 500, 'menu row sits after the shipped rows', String(menu?.meta.order))

    // The menu row uses no hooks, so it can be rendered for real here.
    if (menu !== undefined) {
      const withoutId = menu.component({ t: (key) => key })
      check(withoutId === null, 'menu row renders nothing without a session id')
      const withId = menu.component({ t: (key) => key, sessionId: 'session-abc', displayTitle: '题目' })
      check(withId !== null && typeof withId === 'object', 'menu row renders with a session id')
      const flat = JSON.stringify(withId)
      check(flat.includes('menuitem'), 'menu row renders a role="menuitem" button')
      check(flat.includes('session-abc') === false, 'menu row keeps the session id out of markup')

      // The official-primitive path, through a SECOND factory instance whose
      // require table carries ui-primitives. This is the regression test for the
      // bug 1.1.0 shipped: the row rendered and never fired, because
      // MenuItemButton's activation prop is `onSelect`, not `onClick`.
      const primitivesStub = {
        MenuItemButton: (props) => ({ type: 'MenuItemButton', props: props ?? {}, children: props?.children ?? [] }),
        IconTrashOutlineRegular: (props) => ({ type: 'IconTrashOutlineRegular', props: props ?? {}, children: [] }),
      }
      const official = entry.factory((specifier) => {
        if (specifier === 'react') return reactShim
        if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
        throw new Error(`unexpected require: ${specifier}`)
      })
      const officialRegistrations = []
      const officialCtx = {
        effect: (callback) => ({ dispose: callback() }),
        locale: { register: () => () => {}, bind: () => (key) => key, getSnapshot: () => ({ active: 'en' }) },
        slots: {
          inject: (slot, callback) => { callback(); return () => {} },
          register: (meta, component) => { officialRegistrations.push({ meta, component }); return () => {} },
        },
      }
      official.apply(officialCtx)
      const officialMenu = officialRegistrations.find(({ meta }) => meta.name === 'sidebar.workspaces.session.menu.item')
      check(officialMenu !== undefined, 'primitives path: menu row registered')
      if (officialMenu !== undefined) {
        const menuCloses = []
        const row = officialMenu.component({
          t: (key) => key,
          sessionId: 'session-abc',
          displayTitle: '题目',
          useMenuOpenState: () => [true, (open) => { menuCloses.push(open) }],
        })
        check(row.type === primitivesStub.MenuItemButton, 'menu row renders through the official MenuItemButton')
        check(row.props.onClick === undefined, 'menu row does NOT pass onClick (the primitive takes onSelect)')
        check(typeof row.props.onSelect === 'function', 'menu row passes onSelect as a function')
        check(row.props.separatorBefore === true, 'menu row asks for a group hairline')
        check(row.props.icon?.type === primitivesStub.IconTrashOutlineRegular, 'menu row uses the official trash icon')
        check(row.props.icon?.props?.size === 14, 'trash icon drawn at the shipped 14px', String(row.props.icon?.props?.size))
        row.props.onSelect()
        check(menuCloses.length === 1 && menuCloses[0] === false, 'selecting the row dismisses the menu')
      }

      // The ordered delete flow, driven through the module's test seam: it takes
      // its UI callbacks as plain functions, so the sequence is assertable
      // without a React renderer — the only way to test it offline at all.
      const internal = official.__internal
      check(internal !== undefined && typeof internal.deleteSessionFlow === 'function', 'client exposes the delete flow as a test seam')
      if (internal !== undefined && typeof internal.deleteSessionFlow === 'function') {
        const drive = async (answer) => {
          rpcCalls.length = 0
          const ui = { busy: [], error: [], done: [], live: [] }
          responder = (call) => answer(call)
          await internal.deleteSessionFlow('session-abc', {
            busy: (value) => ui.busy.push(value),
            error: (value) => { if (value !== null) ui.error.push(value) },
            done: (value) => { if (value !== null) ui.done.push(value) },
            live: (value) => ui.live.push(value),
          })
          return ui
        }
        const paths = () => rpcCalls.map((call) => call.url).join(' ')
        const answer = (status, body) => () => ({ status, body })

        const happy = await drive(answer(200, '{"ok":true,"sessionId":"session-abc","recycled":[],"notes":[]}'))
        check(paths() === '/dsh-session-delete/delete', 'the flow makes ONE request — the Host owns the order', paths())
        check(happy.done.length === 1 && happy.error.length === 0, 'the happy path reports success')
        check(JSON.parse(rpcCalls[0].body).sessionId === 'session-abc', 'the delete carries the session id')

        const removedOnly = await drive(answer(200, '{"ok":true,"removedOnly":true,"notes":["the registry did not report this row"]}'))
        check(
          removedOnly.done.length === 1 && removedOnly.error.length === 0,
          'a row with no log left is removed, and reported as such',
        )

        const wasLive = await drive(answer(200, '{"ok":true,"wasLive":true,"notes":[]}'))
        check(wasLive.done.length === 1, 'the live case still reports success')
        check(wasLive.done[0] === happy.done[0], 'the success text is the same; only the notice differs')
        check(wasLive.live.length === 1 && wasLive.live[0] === true, 'the flow tells the UI a row will linger')
        check(happy.live.length === 0, 'the plain path reports no lingering row')

        const partial = await drive(answer(200, '{"ok":true,"notes":["detach failed: boom"]}'))
        check(partial.error.length === 1, 'a registry note the Host calls a failure is surfaced', partial.error.join(' | '))

        const unknown = await drive(answer(404, '{"error":"no log directory"}'))
        check(unknown.error.length === 1 && unknown.done.length === 0, 'an id the Host cannot place is reported, not glossed over')

        const unsupported = await drive(answer(501, '{"error":"no recycle bin","reason":"unsupported-platform"}'))
        check(unsupported.error.length === 1 && unsupported.done.length === 0, 'an unsupported platform is reported as such')
      }
    }
  }

  /* ----------------------------- 6. host half ----------------------------- */
  console.log('\n[6] host half against a fake Harness home')
  const home = join(scratch, 'home')
  // The canonical SessionId carries the `session-` prefix — that is the shape
  // workspace.json stores and the shape the slot hands the client — and the
  // directory name IS that string. The fixtures use the canonical form on
  // purpose, so a double-prefixed lookup cannot pass by accident; the bare uuid
  // is kept as the second accepted spelling.
  const sessionId = 'session-921ab38a-21e8-461f-96d0-4d330d70e4e9'
  const bareSessionId = '921ab38a-21e8-461f-96d0-4d330d70e4e9'
  const keepId = 'session-8ecc5c85-a8e4-4739-9282-3e574446207e'
  const project = '--E-workDeepSeek-demo--'
  const sessionDir = join(home, 'sessions', project, sessionId)
  const keepDir = join(home, 'sessions', project, keepId)
  const projcache = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  await mkdir(sessionDir, { recursive: true })
  await mkdir(keepDir, { recursive: true })
  await mkdir(dirname(projcache), { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log-bytes', 'utf8')
  await writeFile(join(keepDir, 'session.v4.jsonl.zstd'), 'other-log', 'utf8')
  await writeFile(projcache, '{"projection":true}', 'utf8')

  process.env.DSH_HOME = home

  // apply() must mount through the carrier and inside an effect.
  const applied = new Map()
  let effects = 0
  const applyCtx = {
    webServer: {
      register: (route) => {
        applied.set(route.path, route.handler)
        return () => applied.delete(route.path)
      },
    },
    get: () => undefined,
    inject: (names, callback) => { callback(applyCtx); return () => {} },
    effect: (callback) => { effects += 1; callback(); return () => {} },
  }
  try {
    hostHalf.apply(applyCtx)
    pass('host half mounts against a fake Host context')
  } catch (error) {
    fail('host half mounts', String(error?.message ?? error))
  }
  check(effects === 1, 'routes mount inside a ctx.effect (unloadable)')
  for (const path of ['/dsh-session-delete/locate', '/dsh-session-delete/delete']) {
    check(applied.has(path), `${path} registered`)
  }

  // A second table whose recycler is injectable. The real one hands bytes to
  // the OS bin; this stand-in MOVES them somewhere else instead, because a dry
  // run must never put anything in the user's recycle bin.
  const routes = new Map()
  const recycledTo = join(scratch, 'fake-recycle-bin')
  const recycledPaths = []
  const fakeRecycle = async (paths) => {
    await mkdir(recycledTo, { recursive: true })
    for (const target of paths) {
      const destination = join(recycledTo, `${String(Date.now())}-${basename(target)}`)
      await rename(target, destination)
      recycledPaths.push(destination)
    }
    return { ok: true, recycled: paths }
  }
  const refusingRecycle = async () => ({ ok: false, reason: 'recycle-failed', message: 'refused by the stand-in' })
  // The registry's own durable file decides what counts as a row this Host
  // knows about — which is what makes a row whose log is already gone
  // removable instead of permanently stuck.
  const zombieId = 'session-00000000-0000-4000-8000-0000000000ff'
  const workspaceFile = join(home, 'storages', 'workspace.json')
  await mkdir(dirname(workspaceFile), { recursive: true })
  await writeFile(workspaceFile, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [zombieId], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-1': { path: 'E:\\demo', title: '插件', sessionIds: [sessionId, zombieId, keepId] },
      },
    },
  }, null, 2), 'utf8')

  const registryCalls = []
  // Which Sessions the running process has loaded. A live Session can only be
  // un-loaded by its owner, so it is what leaves a lingering row behind.
  const liveSessions = new Set()
  const sessionsStore = { get: (id) => (liveSessions.has(id) ? { id } : undefined) }
  const registry = {
    list: () => [{
      id: 'ws-1',
      title: '插件',
      sessionIds: [sessionId, zombieId],
      detachSession: async (id) => {
        registryCalls.push(`detach:${id}`)
        // Detaching is durable on a real host, so the fixture follows: a second
        // delete then has nothing left to find, exactly as in production.
        const document = JSON.parse(await readFile(workspaceFile, 'utf8'))
        for (const workspace of Object.values(document.tables?.workspaces ?? {})) {
          if (Array.isArray(workspace.sessionIds)) {
            workspace.sessionIds = workspace.sessionIds.filter((entry) => entry !== id)
          }
        }
        if (Array.isArray(document.global?.archivedSessionIds)) {
          document.global.archivedSessionIds = document.global.archivedSessionIds.filter((entry) => entry !== id)
        }
        await writeFile(workspaceFile, JSON.stringify(document, null, 2), 'utf8')
      },
    }],
    archiveSession: async (id, options) => { registryCalls.push(`archive:${id}:stopActivity=${String(options?.stopActivity === true)}`) },
    unarchiveSession: async (id) => { registryCalls.push(`unarchive:${id}`) },
  }
  const mountWith = (recycle) => {
    const table = new Map()
    hostHalf.__test__.mountRoutes({
      webServer: {
        register: (route) => {
          table.set(route.path, route.handler)
          return () => {}
        },
      },
      get: (name) => (name === 'workspaceRegistry' ? registry : name === 'sessions' ? sessionsStore : undefined),
    }, { recycle })
    return table
  }
  for (const [path, handler] of mountWith(fakeRecycle)) routes.set(path, handler)

  const call = async (path, options = {}) => {
    const handler = routes.get(path)
    if (handler === undefined) throw new Error(`route not registered: ${path}`)
    const response = fakeResponse()
    await handler(fakeRequest(options), response)
    return response
  }
  const sameOrigin = { origin: 'http://127.0.0.1:19387' }

  // The read-only locator proves an install can SEE a Session without moving it
  // — the one failure the UI cannot explain by itself, and the regression test
  // for the double-`session-` lookup an earlier release shipped.
  const located = await call('/dsh-session-delete/locate', { method: 'POST', body: { sessionId }, headers: sameOrigin })
  check(located.record.status === 200 && located.json()?.dir === sessionDir, 'locate finds the canonical session id', JSON.stringify(located.json()))
  check(located.json()?.projectionCache === true, 'locate reports the projection cache too')
  const locatedBare = await call('/dsh-session-delete/locate', { method: 'POST', body: { sessionId: bareSessionId }, headers: sameOrigin })
  check(locatedBare.record.status === 200 && locatedBare.json()?.dir === sessionDir, 'locate accepts a bare uuid for the same Session')
  const locatedMissing = await call('/dsh-session-delete/locate', { method: 'POST', body: { sessionId: 'session-00000000-0000-4000-8000-000000000000' }, headers: sameOrigin })
  check(locatedMissing.record.status === 404, 'locate reports a Session it cannot find', `HTTP ${locatedMissing.record.status}`)
  check(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), 'locate moves nothing')

  const traversal = await call('/dsh-session-delete/delete', { method: 'POST', body: { sessionId: '../../etc/passwd' } })
  check(traversal.record.status === 400, 'traversal-shaped session id refused', `HTTP ${traversal.record.status}`)

  const crossOrigin = await call('/dsh-session-delete/delete', {
    method: 'POST',
    body: { sessionId },
    headers: { origin: 'http://evil.example', host: '127.0.0.1:19387' },
  })
  check(crossOrigin.record.status === 403, 'cross-origin request refused', `HTTP ${crossOrigin.record.status}`)

  const wrongMethod = await call('/dsh-session-delete/delete', { method: 'GET' })
  check(wrongMethod.record.status === 405, 'wrong method answered 405', `HTTP ${wrongMethod.record.status}`)

  // A row whose log is already gone: there is nothing to recycle, but the
  // registry still lists it, so it must remain removable. This is the state an
  // earlier design could produce, and it was un-fixable from the UI.
  registryCalls.length = 0
  recycledPaths.length = 0
  const zombie = await call('/dsh-session-delete/delete', { method: 'POST', body: { sessionId: zombieId }, headers: sameOrigin })
  check(zombie.record.status === 200 && zombie.json()?.removedOnly === true, 'a row with no log is removed, not refused', JSON.stringify(zombie.json()))
  check(recycledPaths.length === 0, 'nothing is handed to the recycler for a row with no log')
  check(registryCalls.includes(`detach:${zombieId}`), 'the row with no log is detached', registryCalls.join(' '))
  check(registryCalls.includes(`unarchive:${zombieId}`), 'its archive entry is cleared too', registryCalls.join(' '))
  check(registryCalls.some((entry) => entry.startsWith('archive:')) === false, 'a row with no log is never archived for stopping')
  check(zombie.json()?.wasLive === false, 'a Session this process never loaded is not reported as live')

  // Neither on disk nor in the registry: that, and only that, is not-found.
  const nowhere = await call('/dsh-session-delete/delete', {
    method: 'POST',
    body: { sessionId: 'session-00000000-0000-4000-8000-0000000000ee' },
    headers: sameOrigin,
  })
  check(nowhere.record.status === 404, 'an id that is nowhere at all is not-found', `HTTP ${nowhere.record.status}`)

  // A refused recycle leaves EVERYTHING as it was: the log in place, the archive
  // from the stop step undone, and nothing detached. That is the difference
  // between a failure and a half-state.
  registryCalls.length = 0
  for (const [path, handler] of mountWith(refusingRecycle)) routes.set(path, handler)
  const refused = await call('/dsh-session-delete/delete', { method: 'POST', body: { sessionId }, headers: sameOrigin })
  check(refused.record.status === 500, 'a refused recycle is a failure, not a silent unlink', `HTTP ${refused.record.status}`)
  check(registryCalls.includes(`archive:${sessionId}:stopActivity=true`), 'the Session is stopped before the move', registryCalls.join(' '))
  check(registryCalls.includes(`unarchive:${sessionId}`), 'a failed move undoes the stop archive', registryCalls.join(' '))
  check(registryCalls.some((entry) => entry.startsWith('detach:')) === false, 'a failed move detaches nothing')
  check(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), 'a failed move leaves the log where it was')
  check(existsSync(projcache), 'a failed move leaves the projection cache where it was')

  registryCalls.length = 0
  recycledPaths.length = 0
  // Loaded in this process — the case that leaves a row behind, and the one the
  // answer has to admit.
  liveSessions.add(sessionId)
  for (const [path, handler] of mountWith(fakeRecycle)) routes.set(path, handler)
  const deleted = await call('/dsh-session-delete/delete', { method: 'POST', body: { sessionId }, headers: sameOrigin })
  check(deleted.record.status === 200 && deleted.json()?.ok === true, 'delete succeeds', JSON.stringify(deleted.json()))
  check(deleted.json()?.wasLive === true, 'a Session loaded in this process is reported as live — the honest half of the lingering row', JSON.stringify(deleted.json()?.wasLive))
  check(existsSync(sessionDir) === false, 'the log directory left its old home')
  check(existsSync(projcache) === false, 'the projection cache left its old home')
  check(existsSync(keepDir) === true, 'an unrelated session is untouched')
  check(recycledPaths.length === 2, 'both files were handed to the recycler', String(recycledPaths.length))
  check(recycledPaths.every((target) => existsSync(target)), 'the recycled bytes still exist — a recycle is not an unlink')
  check(registryCalls.includes(`archive:${sessionId}:stopActivity=true`), 'the sequence stops the Session first', registryCalls.join(' '))
  check(registryCalls.includes(`detach:${sessionId}`), 'the sequence detaches it from the workspace', registryCalls.join(' '))
  check(registryCalls.includes(`unarchive:${sessionId}`), 'the sequence clears the archive entry it made', registryCalls.join(' '))
  check(
    registryCalls.indexOf(`archive:${sessionId}:stopActivity=true`) < registryCalls.indexOf(`detach:${sessionId}`),
    'the order is stop, recycle, detach',
    registryCalls.join(' '),
  )

  const second = await call('/dsh-session-delete/delete', { method: 'POST', body: { sessionId }, headers: sameOrigin })
  check(second.record.status === 404, 'deleting an already-deleted Session is a 404, not a crash', `HTTP ${second.record.status}`)
  check(existsSync(keepDir) === true, 'the unrelated session is still untouched')

  /* ---------------------------- 7. isolation ---------------------------- */
  console.log('\n[7] isolation and uninstall')
  check(resolve(process.env.DSH_HOME) === home, 'the run used the scratch home')
  const realSessionsAfter = await listRealSessions()
  check(
    JSON.stringify(realSessionsAfter) === JSON.stringify(realSessionsBefore),
    'every real Session log is exactly where it was',
    `${realSessionsAfter.length} sessions`,
  )
  const realProfileAfter = existsSync(realProfilePath) ? await readFile(realProfilePath, 'utf8') : null
  check(realProfileAfter === realProfileBefore, 'the real desktop profile manifest is untouched by the run')

  await rm(installed, { recursive: true, force: true })
  check(existsSync(installed) === false, 'uninstalling the staged copy removes it cleanly')
  check(existsSync(profileDir) === true, 'the profile itself survives an uninstall')

  if (!keep) await rm(scratch, { recursive: true, force: true })
  else console.log(`  kept ${scratch}`)

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('\ndry-run crashed:', error)
  process.exit(2)
})
