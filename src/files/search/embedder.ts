import type { Embedder } from './types.js'

/** Placeholder with the final signature (phase 5 shared definitions); part A implements it. */

export interface LocalEmbedderOptions {
  /** `<data dir>/modules` — the search runtime and model live under its `search` folder. */
  readonly modulesDir: string
  readonly threads?: number
}

export async function createLocalEmbedder(opts: LocalEmbedderOptions): Promise<Embedder> {
  throw new Error(`search by meaning is not implemented yet (modules in ${opts.modulesDir})`)
}
