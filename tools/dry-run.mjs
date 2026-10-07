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
 * 6. Host half        — against a fake Harness home: trash / list / restore /
 *    purge, plus every refusal that protects the rest of the disk.
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

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
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

  const realTrashBefore = existsSync(join(realHome, 'trash', NAME))
  // Snapshot rather than assume: this plugin IS installed on some machines, so
  // the isolation property is "the run changed nothing", not "the profile does
  // not mention it".
  const realProfilePath = join(realHome, 'profiles', 'desktop', 'package.json')
  const realProfileBefore = existsSync(realProfilePath) ? await readFile(realProfilePath, 'utf8') : null
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
    check(
      JSON.stringify(client.inject) === JSON.stringify(['slots', 'locale', 'workspaces']),
      'cordis inject is slots/locale/workspaces',
      JSON.stringify(client.inject),
    )

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
      workspaces: { archiveSession: async () => {}, unarchiveSession: async () => {} },
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
    for (const slot of ['sidebar.workspaces.session.menu.item', 'shell.overlay', 'settings.section']) {
      check(injections.includes(slot), `waits for the ${slot} slot`)
    }

    const bySlot = Object.fromEntries(registrations.map(({ meta, component }) => [meta.name, { meta, component }]))
    check(registrations.length === 3, 'registers exactly three slots', String(registrations.length))
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
      official.apply({
        effect: (callback) => ({ dispose: callback() }),
        locale: { register: () => () => {}, bind: () => (key) => key, getSnapshot: () => ({ active: 'en' }) },
        slots: {
          inject: (slot, callback) => { callback(); return () => {} },
          register: (meta, component) => { officialRegistrations.push({ meta, component }); return () => {} },
        },
        workspaces: { archiveSession: async () => {}, unarchiveSession: async () => {} },
      })
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
    }
  }

  /* ----------------------------- 6. host half ----------------------------- */
  console.log('\n[6] host half against a fake Harness home')
  const home = join(scratch, 'home')
  const sessionId = '921ab38a-21e8-461f-96d0-4d330d70e4e9'
  const keepId = '8ecc5c85-a8e4-4739-9282-3e574446207e'
  const project = '--E-workDeepSeek-demo--'
  const sessionDir = join(home, 'sessions', project, `session-${sessionId}`)
  const keepDir = join(home, 'sessions', project, `session-${keepId}`)
  const projcache = join(home, 'storages', 'session_projcache', 'sessions', `session-${sessionId}.json`)
  await mkdir(sessionDir, { recursive: true })
  await mkdir(keepDir, { recursive: true })
  await mkdir(dirname(projcache), { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log-bytes', 'utf8')
  await writeFile(join(keepDir, 'session.v4.jsonl.zstd'), 'other-log', 'utf8')
  await writeFile(projcache, '{"projection":true}', 'utf8')
  await writeFile(join(home, 'storages', 'workspace.json'), '{"unit":{"name":"workspace","version":2}}', 'utf8')

  process.env.DSH_HOME = home
  const routes = new Map()
  let effects = 0
  const hostCtx = {
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    get: () => undefined,
    inject: (names, callback) => { callback(hostCtx); return () => {} },
    effect: (callback) => { effects += 1; callback(); return () => {} },
  }
  try {
    hostHalf.apply(hostCtx)
    pass('host half mounts against a fake Host context')
  } catch (error) {
    fail('host half mounts', String(error?.message ?? error))
  }
  check(effects === 1, 'routes mount inside a ctx.effect (unloadable)')
  for (const path of ['/dsh-session-delete/trash', '/dsh-session-delete/trash/restore', '/dsh-session-delete/trash/purge']) {
    check(routes.has(path), `${path} registered`)
  }

  const call = async (path, options = {}) => {
    const handler = routes.get(path)
    if (handler === undefined) throw new Error(`route not registered: ${path}`)
    const response = fakeResponse()
    await handler(fakeRequest(options), response)
    return response
  }
  const sameOrigin = { origin: 'http://127.0.0.1:19387' }

  const empty = await call('/dsh-session-delete/trash')
  check(
    empty.record.status === 200 && Array.isArray(empty.json()?.entries) && empty.json().entries.length === 0,
    'GET /trash starts empty',
  )
  check(empty.json()?.root?.startsWith(home) === true, 'trash root resolves inside the fake home', empty.json()?.root)

  const traversal = await call('/dsh-session-delete/trash', { method: 'POST', body: { sessionId: '../../etc/passwd' } })
  check(traversal.record.status === 400, 'traversal-shaped session id refused', `HTTP ${traversal.record.status}`)

  const crossOrigin = await call('/dsh-session-delete/trash', {
    method: 'POST',
    body: { sessionId },
    headers: { origin: 'http://evil.example', host: '127.0.0.1:19387' },
  })
  check(crossOrigin.record.status === 403, 'cross-origin request refused', `HTTP ${crossOrigin.record.status}`)

  const trashed = await call('/dsh-session-delete/trash', { method: 'POST', body: { sessionId }, headers: sameOrigin })
  const trashBody = trashed.json()
  check(trashed.record.status === 200 && trashBody?.ok === true, 'session moves to the trash', JSON.stringify(trashBody))
  const entryName = String(trashBody?.entry)
  check(existsSync(sessionDir) === false, 'session directory left its old home')
  check(existsSync(projcache) === false, 'projection cache left its old home')
  check(existsSync(keepDir) === true, 'an unrelated session is untouched')
  const entryDir = join(home, 'trash', NAME, entryName)
  check(existsSync(join(entryDir, `session-${sessionId}`, 'session.v4.jsonl.zstd')), 'payload sits inside the trash entry')
  check(existsSync(join(entryDir, 'session_projcache.json')), 'projection cache travelled with it')
  check(existsSync(join(entryDir, 'trash.json')), 'entry records where it came from')
  const meta = JSON.parse(await readFile(join(entryDir, 'trash.json'), 'utf8'))
  check(meta.origin === sessionDir, 'origin recorded for a true restore', meta.origin)

  const listed = await call('/dsh-session-delete/trash')
  check(listed.json()?.entries?.length === 1, 'GET /trash lists the entry', String(listed.json()?.entries?.length))

  const noConfirm = await call('/dsh-session-delete/trash/purge', { method: 'POST', body: { entry: entryName } })
  check(noConfirm.record.status === 400, 'purge without confirmation refused', `HTTP ${noConfirm.record.status}`)

  const restored = await call('/dsh-session-delete/trash/restore', { method: 'POST', body: { entry: entryName } })
  check(restored.record.status === 200 && restored.json()?.ok === true, 'restore succeeds', JSON.stringify(restored.json()))
  check(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), 'session directory is back where it was')
  check(existsSync(projcache), 'projection cache is back where it was')
  check(existsSync(entryDir) === false, 'a restored entry leaves no residue')

  const again = await call('/dsh-session-delete/trash', { method: 'POST', body: { sessionId } })
  const againEntry = String(again.json()?.entry)
  const purged = await call('/dsh-session-delete/trash/purge', {
    method: 'POST',
    body: { confirm: true, entry: againEntry },
  })
  check(purged.record.status === 200 && purged.json()?.removed === 1, 'purge removes one entry', JSON.stringify(purged.json()))
  check(existsSync(join(home, 'trash', NAME, againEntry)) === false, 'purged bytes are gone')
  check(existsSync(sessionDir) === false, 'a purged session does not come back')

  const unsafeEntry = await call('/dsh-session-delete/trash/purge', {
    method: 'POST',
    body: { confirm: true, entry: '..\\..\\windows' },
  })
  check(unsafeEntry.record.status === 400, 'traversal-shaped entry refused', `HTTP ${unsafeEntry.record.status}`)

  // A well-formed id that has no directory: valid shape, nothing to move.
  const absent = await call('/dsh-session-delete/trash', {
    method: 'POST',
    body: { sessionId: '00000000-0000-4000-8000-000000000000' },
  })
  check(absent.record.status === 404, 'unknown session reported as 404', `HTTP ${absent.record.status}`)
  check(existsSync(keepDir) === true, 'the unrelated session is still untouched')

  const wrongMethod = await call('/dsh-session-delete/trash/purge', { method: 'GET' })
  check(wrongMethod.record.status === 405, 'wrong method answered 405', `HTTP ${wrongMethod.record.status}`)

  /* ---------------------------- 7. isolation ---------------------------- */
  console.log('\n[7] isolation and uninstall')
  check(resolve(process.env.DSH_HOME) === home, 'the run used the scratch home')
  check(existsSync(join(realHome, 'trash', NAME)) === realTrashBefore, 'the real trash directory was not created')
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
