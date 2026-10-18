import { isAbsolute, join } from 'node:path'
import { buildApp } from './app.js'
import { providers } from './providers/index.js'
import { shippedPaths } from './paths.js'
import { DEFAULT_BACKGROUND } from './backgrounds/seed.js'
import { widgetDevDir } from './widgets/dev.js'
import { accessTokenPath, resolveAccessToken, writeAccessToken } from './http/access-file.js'

// A checkout's own folders, or the app bundle's when the helper sets `FREMKIT_ROOT`: see paths.ts.
let shipped: ReturnType<typeof shippedPaths>
try {
  shipped = shippedPaths()
} catch (error) {
  console.error(`fremkit: ${(error as Error).message}`)
  process.exit(1)
}
// A second checkout (a worktree, a test bench) can run beside the live server on another port.
// The helper passes its own configured port here; 4242 is what everything assumes otherwise.
const port = Number(process.env.FREMKIT_PORT) || 4242

/**
 * Where the config, the backgrounds and the caches live. `<checkout>/data` unless told otherwise;
 * the app always tells, because its bundle is replaced by every update.
 *
 * `FREMKIT_DATA_DIR` is what makes a from-scratch run possible on the live checkout without
 * moving anything: the dashboard, the connections list and the background library all come from
 * here, so pointing it elsewhere gives a brand-new install. The keychain is keyed by connection
 * id, so a fresh config never names the real items and they are left untouched.
 *
 * Absolute only: a relative path would be read against whatever directory the process happened
 * to start in, which for the helper's child is the checkout and for a shell is anywhere.
 */
const configured = process.env.FREMKIT_DATA_DIR
if (configured && !isAbsolute(configured)) {
  console.error(`fremkit: FREMKIT_DATA_DIR must be an absolute path, got ${configured}`)
  process.exit(1)
}
// Inside the app, `<root>/data` would be inside the signed bundle, which every update replaces:
// the helper always passes FREMKIT_DATA_DIR there, and a hand-run bundled server must too.
if (!configured && process.env.FREMKIT_ROOT) {
  console.error('fremkit: FREMKIT_ROOT is set but FREMKIT_DATA_DIR is not; refusing to write data inside the app')
  process.exit(1)
}
const dataDir = configured || `${shipped.root}/data`

/**
 * Writing a widget (`FREMKIT_WIDGET_DEV=1`, which `pnpm dev` exports): the author's folder is read
 * beside the built-ins and watched, and a save reloads the widget. See `widgets/dev.ts`.
 */
let devDir: string | undefined
try {
  devDir = widgetDevDir(process.env, dataDir)
} catch (error) {
  console.error(`fremkit: ${(error as Error).message}`)
  process.exit(1)
}

/**
 * A registry served from somewhere else, for development only.
 *
 * The production registry is a constant: one host, https, private addresses refused. That is
 * right, and it makes the install path untestable until something is actually published — so
 * `FREMKIT_REGISTRY_URL` can point at a locally built one, and is honoured **only** under
 * `FREMKIT_DEV=1`. Outside that it is ignored, loudly: an environment variable that silently
 * redirected where a Fremkit installs widgets from would be the worst kind of quiet.
 */
const dev = process.env.FREMKIT_DEV === '1'
const requestedRegistry = process.env.FREMKIT_REGISTRY_URL
let registryUrl: string | undefined
if (requestedRegistry && !dev) {
  console.error('fremkit: FREMKIT_REGISTRY_URL is ignored without FREMKIT_DEV=1; using the published registry')
} else if (requestedRegistry) {
  registryUrl = requestedRegistry
  console.error(`fremkit: FREMKIT_DEV=1, installing widgets from ${requestedRegistry}`)
}

// Not a top-level await: the app's bundled server is CommonJS (see server/scripts/bundle.mjs),
// which has none. A failure still ends the process with a non-zero status, as it did.
/**
 * The local access secret (see `http/access.ts`): the helper's, passed in the environment, or a
 * new one for a server started by hand. Read here, before anything else can spawn a child that
 * would inherit the variable. Never printed.
 */
const access = resolveAccessToken(process.env)
if (access.rejected) console.error('fremkit: FREMKIT_ACCESS_TOKEN is not a valid secret (base64url, 32 bytes or more); using a new one')
const tokenFile = accessTokenPath(port)

async function main(): Promise<void> {
  // Written before the server listens, so whoever sees the port answer can already read it.
  await writeAccessToken(tokenFile, access.token)
  const app = await buildApp({
    accessToken: access.token,
    dataDir,
    widgetsDir: shipped.widgetsDir,
    ...(devDir ? { widgetDevDir: devDir } : {}),
    ...(registryUrl ? { registryUrl, registryDev: true } : {}),
    themesDir: shipped.themesDir,
    uiDist: shipped.uiDist,
    bridgePath: shipped.bridgePath,
    wallpaperPath: join(shipped.wallpaperDir, DEFAULT_BACKGROUND),
    providers,
    logger: true,
    port,
  })
  installShutdown(app)
  await app.listen({ port, host: '127.0.0.1' })
  app.log.info({ tokenFile, source: access.source }, 'local access secret written')
}

/**
 * The helper stops the server with SIGTERM (and SIGKILL three seconds later); a terminal sends
 * SIGINT. Node's default for both is to die on the spot, which skips every `onClose` hook — the
 * remote listener, and the `dns-sd` child advertising it, among them. So the app is closed first,
 * with a deadline under the helper's, and the process exits either way: the helper restarts or
 * not on its own terms, whatever the exit status.
 */
function installShutdown(app: Awaited<ReturnType<typeof buildApp>>): void {
  let closing = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return
    closing = true
    const code = signal === 'SIGINT' ? 130 : 143
    setTimeout(() => process.exit(code), 2_000).unref()
    app.close()
      .catch((error: unknown) => console.error(error))
      .finally(() => process.exit(code))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
