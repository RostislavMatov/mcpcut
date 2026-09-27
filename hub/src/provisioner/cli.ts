import { describeOrchestratorError } from '../orchestrator.js'
import { loadProvisionerConfig, type ProvisionerConfig } from './config.js'
import { createDockerClient } from './docker.js'
import { createProvisionerServer } from './server.js'
import { createProvisionerService, type ProvisionerService } from './service.js'

/**
 * The provisioner's commands (plan `tenant-orchestrator`, Task 4), reached
 * through the hub's entry point (`hub/src/cli.ts`):
 *
 *   provision                        run the HTTP API for the hub
 *   provision-create <sub> <login>   create an install now (a smoke, an operator's fix)
 *   provision-remove <sub>           remove an install and everything in it
 *   provision-status <sub>           the container's state and the volume's size
 *
 * All four read the same `PROVISIONER_*` environment and talk to Docker
 * directly, so they run where the socket is: inside the provisioner's
 * container. `provision-create` prints the owner token ONCE, on stdout, with
 * a warning on stderr; nothing keeps a copy.
 */

export const PROVISIONER_COMMANDS: ReadonlySet<string> = new Set([
  'provision',
  'provision-create',
  'provision-remove',
  'provision-status',
])

export const PROVISIONER_USAGE =
  '  provision                  run the provisioner (PROVISIONER_* environment)\n' +
  '  provision-create <sub> <login>  create an install; prints its owner token once\n' +
  '  provision-remove <sub>     remove an install, its volume and its network\n' +
  '  provision-status <sub>     an install’s state and volume size\n'

export interface ProvisionerCliIo {
  readonly env: NodeJS.ProcessEnv
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** Called only by `provision`: resolves when the server should stop. */
  readonly shutdown: () => Promise<void>
}

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2
const ARITY: Readonly<Record<string, number>> = {
  provision: 0,
  'provision-create': 2,
  'provision-remove': 1,
  'provision-status': 1,
}

const TOKEN_ONCE_WARNING =
  'provisioner: the owner token above is shown once and stored nowhere — hand it to its owner now; `provision-create` cannot show it again (the hub’s /account mints a new one)\n'

export async function runProvisionerCommand(command: string, args: readonly string[], io: ProvisionerCliIo): Promise<number> {
  if (args.length !== ARITY[command]) {
    io.stderr(`usage:\n${PROVISIONER_USAGE}`)
    return EXIT_USAGE
  }
  const loaded = loadProvisionerConfig({ env: io.env })
  if (loaded.kind === 'invalid') {
    for (const problem of loaded.problems) io.stderr(`provisioner: ${problem}\n`)
    return EXIT_FAILED
  }
  const { config } = loaded
  const docker = createDockerClient({ socketPath: config.dockerSocket })
  const service = createProvisionerService({
    docker,
    image: config.image,
    publicDomain: config.publicDomain,
    maxTenants: config.maxTenants,
    ...(config.caddyContainer === undefined ? {} : { caddyContainer: config.caddyContainer }),
    log: (line) => io.stderr(`${line}\n`),
  })
  try {
    if (command === 'provision') return await serve(io, config, service)
    return await operate(command, args, io, service)
  } finally {
    docker.close()
  }
}

async function serve(io: ProvisionerCliIo, config: ProvisionerConfig, service: ProvisionerService): Promise<number> {
  const server = createProvisionerServer({ service, token: config.token, log: (line) => io.stderr(`${line}\n`) })
  try {
    const { port } = await server.listen(config.port, config.host)
    io.stdout(`[provisioner] listening on http://${config.host}:${port}; Docker at ${config.dockerSocket}; image ${config.image}\n`)
    if (config.caddyContainer === undefined) {
      io.stderr('[provisioner] warning: PROVISIONER_CADDY_CONTAINER is not set — installs are created but nothing routes to them\n')
    }
    await io.shutdown()
    return EXIT_OK
  } finally {
    await server.close()
  }
}

async function operate(command: string, args: readonly string[], io: ProvisionerCliIo, service: ProvisionerService): Promise<number> {
  const [subdomain = '', login = ''] = args
  try {
    if (command === 'provision-create') {
      const { ownerToken } = await service.create({ subdomain, login })
      io.stdout(`owner token for ${subdomain}: ${ownerToken}\n`)
      io.stderr(TOKEN_ONCE_WARNING)
    } else if (command === 'provision-remove') {
      await service.remove(subdomain)
      io.stdout(`removed ${subdomain}\n`)
    } else {
      const status = await service.status(subdomain)
      io.stdout(`${subdomain}  ${status.state}  ${status.sizeBytes === null ? '-' : `${status.sizeBytes} bytes`}\n`)
    }
    return EXIT_OK
  } catch (error: unknown) {
    io.stderr(`provisioner: ${describeOrchestratorError(error)}\n`)
    return EXIT_FAILED
  }
}
