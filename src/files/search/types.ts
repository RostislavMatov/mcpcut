/**
 * A text embedder (ADR-0020 §6): the local model in production, a
 * deterministic fake in tests. Vectors are L2-normalized and `dims` long, so
 * cosine distance ranks them. A query and a passage are embedded differently
 * (e5 prefixes), which is why there are two methods.
 */
export interface Embedder {
  /** Stored with every vector; a file embedded by another model is embedded again. */
  readonly model: string
  readonly dims: number
  embedPassage(text: string): Promise<Float32Array>
  embedQuery(text: string): Promise<Float32Array>
  /** Frees the native session; idempotent. */
  close(): Promise<void>
}
