/**
 * The shapes the provisioner's Docker client speaks (plan
 * `tenant-orchestrator`, Task 3). `ContainerSpec` is Docker's own
 * `POST /containers/create` body, spelled in Docker's field names so a
 * template reads like the API reference — narrowed to the fields the tenant
 * templates use. The `*Info` types are what the client returns: a small,
 * validated projection of Docker's answers, never the raw JSON.
 */

export type Labels = Readonly<Record<string, string>>

/** Driver options for `POST /networks/create` (`Options` in Docker's own body), e.g. a fixed bridge interface name. */
export type NetworkOptions = Readonly<Record<string, string>>

export interface MountSpec {
  readonly Type: 'volume' | 'tmpfs'
  readonly Source?: string
  readonly Target: string
  readonly ReadOnly?: boolean
}

export interface HostConfigSpec {
  /** Bytes. */
  readonly Memory?: number
  readonly MemorySwap?: number
  /** Billionths of a CPU. */
  readonly NanoCpus?: number
  readonly PidsLimit?: number
  readonly CapDrop?: readonly string[]
  readonly CapAdd?: readonly string[]
  readonly SecurityOpt?: readonly string[]
  readonly ReadonlyRootfs?: boolean
  /** Mount point → mount options, e.g. `{ '/tmp': 'rw,noexec,nosuid,size=16m' }`. */
  readonly Tmpfs?: Readonly<Record<string, string>>
  readonly Mounts?: readonly MountSpec[]
  readonly RestartPolicy?: { readonly Name: 'no' | 'always' | 'unless-stopped' | 'on-failure'; readonly MaximumRetryCount?: number }
  readonly NetworkMode?: string
  readonly Init?: boolean
  readonly LogConfig?: { readonly Type: string; readonly Config?: Readonly<Record<string, string>> }
}

export interface ContainerSpec {
  readonly Image: string
  readonly Cmd?: readonly string[]
  readonly Entrypoint?: readonly string[]
  /** `NAME=value` entries. Values are redacted from any error Docker echoes them in. */
  readonly Env?: readonly string[]
  readonly User?: string
  readonly WorkingDir?: string
  readonly Labels?: Labels
  readonly ExposedPorts?: Readonly<Record<string, Readonly<Record<string, never>>>>
  readonly StopSignal?: string
  readonly StopTimeout?: number
  readonly HostConfig?: HostConfigSpec
}

export interface NetworkInfo {
  readonly name: string
  readonly labels: Labels
}

export interface VolumeInfo {
  readonly name: string
  readonly labels: Labels
  /** `UsageData.Size` when the daemon reported one (it does so only in `/system/df`). */
  readonly sizeBytes: number | undefined
}

export interface ContainerInfo {
  readonly id: string
  /** Without Docker's leading `/`. */
  readonly name: string
  /** `created`, `running`, `paused`, `restarting`, `removing`, `exited` or `dead`. */
  readonly status: string
  readonly running: boolean
  readonly exitCode: number
  readonly image: string
  readonly labels: Labels
  /** Names of the networks the container is attached to. */
  readonly networks: readonly string[]
}

export interface ContainerSummary {
  readonly id: string
  /** The first name, without Docker's leading `/`. */
  readonly name: string
  readonly state: string
  readonly labels: Labels
}

export interface ListContainersFilter {
  /** `key` or `key=value`; several must all match. */
  readonly label: string | readonly string[]
}
