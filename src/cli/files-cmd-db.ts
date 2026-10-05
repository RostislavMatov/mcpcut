import { FILES_PG_URL_SECRET, DB_NAME, DB_USER, DOCKER_CONTAINER_NAME, DOCKER_DATA_MOUNT, DOCKER_HOST_PORT, DOCKER_IMAGE, DOCKER_VOLUME_NAME } from '../files/db/constants.js'
import { describeDbUrl } from '../files/db/db-url.js'
import { modulesDirOf } from '../files/db/pg-loader.js'
import { ensurePostgresEnv } from '../files/db/postgres-env.js'
import { formatReadableField } from '../journal/format.js'
import { createVaultStore } from '../vault/store.js'
import type { AgentCliIo } from './agent-cmd.js'
import { journalDirOf, openTarget, resolveTarget, type DbTarget } from './files-cmd-db-shared.js'
import { runDbStatus } from './files-cmd-db-status.js'
import { FILES_DB_USAGE } from './files-cmd-format.js'
import type { FilesCliOptions } from './files-cmd.js'
import { requireOwner } from './files-cmd-write.js'
import { cliCommand, shellArg } from './next-step.js'
import { recordChange } from './vault-cmd-write.js'
import type { VaultCmdDeps } from './vault-cmd.js'

/**
 * `mcpcut files db init|status` (ADR-0020 §6). The order of steps is always
 * `files setup` → `files db init` (writes the URL, prints the docker command)
 * → docker → `files db init` (connects, migrates). `status` and the second
 * `init` change nothing of mcpcut's own state, so no token; the first `init`
 * writes the vault and goes through the owner gate.
 */

export async function runDb(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const [action, ...rest] = args
  if (rest.length === 0 && action === 'init') return runDbInit(io, opts)
  if (rest.length === 0 && action === 'status') return runDbStatus(io, opts)
  io.stderr.write(FILES_DB_USAGE)
  return 1
}

/** The docker command that starts the bundled Postgres from the env file. */
export function dockerRunCommand(envFile: string): string {
  return (
    `docker run -d --name ${DOCKER_CONTAINER_NAME} --restart unless-stopped ` +
    `-p 127.0.0.1:${DOCKER_HOST_PORT}:5432 --env-file ${shellArg(envFile)} ` +
    `-v ${DOCKER_VOLUME_NAME}:${DOCKER_DATA_MOUNT} ${DOCKER_IMAGE}`
  )
}

async function runDbInit(io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const resolved = await resolveTarget(opts)
  if (resolved.kind === 'refused') {
    io.stderr.write(`${resolved.line}\n`)
    return 1
  }
  if (resolved.kind === 'ready') return connectAndReport(resolved.target, io, opts)
  return prepareContainer(io, opts)
}

async function connectAndReport(target: DbTarget, io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const db = await openTarget(target, opts)
  try {
    io.stdout.write(`Postgres ready: ${formatReadableField(describeDbUrl(target.url))} (schema ${db.schema}, version ${db.schemaVersion})\n`)
  } finally {
    await db.close()
  }
  io.stderr.write(`Next: ${target.cli} files db sync\n`)
  return 0
}

/** The secret is absent: write the URL into the vault and print the command that starts the container. */
async function prepareContainer(io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const cli = cliCommand(opts.env)
  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1
  const env = await ensurePostgresEnv(modulesDirOf(journalDirOf(opts)))
  if (!env.ok) {
    io.stderr.write(`${formatReadableField(env.path)} is malformed: fix its POSTGRES_PASSWORD line or delete the file (a container made from the old one must be removed too: \`docker rm -f ${DOCKER_CONTAINER_NAME}\`), then run \`${cli} files db init\` again\n`)
    return 1
  }
  const url = `postgres://${DB_USER}:${env.password}@127.0.0.1:${DOCKER_HOST_PORT}/${DB_NAME}`
  const stored = await createVaultStore({ journalDir: journalDirOf(opts) }).setSecret(FILES_PG_URL_SECRET, url)
  if (stored.status !== 'set') {
    io.stderr.write(`the vault cannot take the URL (${stored.status}): check it with \`${cli} vault list\`\n`)
    return 1
  }
  io.stdout.write(`${dockerRunCommand(env.path)}\n`)
  io.stderr.write(`When it is running (a few seconds): ${cli} files db init\n`)
  io.stderr.write(`Own Postgres instead? printf '%s' 'postgres://user:pass@host:5432/db' | ${cli} vault set ${FILES_PG_URL_SECRET}\n`)
  return recordChange(io, vaultDepsOf(opts), actor, 'set', FILES_PG_URL_SECRET, {
    action: 'vault.set',
    vaultEntry: FILES_PG_URL_SECRET,
  })
}

/** The files options in the vault command's terms (same journal dir, token env and clock). */
function vaultDepsOf(opts: FilesCliOptions): VaultCmdDeps {
  const clock = opts.clock
  return {
    ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(clock !== undefined ? { now: () => clock().getTime() } : {}),
    ...(opts.deps !== undefined ? { deps: opts.deps } : {}),
  }
}
