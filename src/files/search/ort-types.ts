/**
 * The slice of `onnxruntime-node` and `@huggingface/tokenizers` the embedder
 * calls, typed locally: neither package is a dependency of mcpcut (ADR-0020
 * §7), both are loaded at run time from the search folder, so nothing here may
 * import them.
 */
export interface OrtTensor {
  readonly data: ArrayLike<number | bigint>
  readonly dims: readonly number[]
}

export interface OrtSession {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
  release(): Promise<void>
}

export interface OrtSessionOptions {
  readonly intraOpNumThreads: number
  readonly interOpNumThreads: number
  readonly graphOptimizationLevel: 'all'
}

export interface OrtModule {
  readonly InferenceSession: {
    create(path: string, options: OrtSessionOptions): Promise<OrtSession>
  }
  readonly Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => OrtTensor
}

export interface TokenizerInstance {
  encode(text: string): { readonly ids: readonly number[] }
}

export interface TokenizerConstructor {
  new (tokenizerJson: unknown, tokenizerConfig: unknown): TokenizerInstance
}

export interface SearchRuntime {
  readonly ort: OrtModule
  readonly Tokenizer: TokenizerConstructor
}
