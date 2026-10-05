/**
 * The slice of `pg` the file module uses, typed locally: the package is not a
 * dependency of mcpcut (ADR-0020 §7), it is loaded at run time from the
 * modules folder (`pg-loader.ts`), so nothing here may import it.
 */
export interface PgQueryResult<Row> {
  readonly rows: Row[]
  readonly rowCount: number | null
}

export interface PgQueryable {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>>
}

export interface PgPoolClient extends PgQueryable {
  release(error?: Error | boolean): void
}

export interface PgPool extends PgQueryable {
  connect(): Promise<PgPoolClient>
  end(): Promise<void>
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface PgPoolConfig {
  readonly connectionString: string
  readonly max?: number
  readonly connectionTimeoutMillis?: number
  readonly idleTimeoutMillis?: number
  readonly statement_timeout?: number
  readonly application_name?: string
  readonly options?: string
}

export interface PgModule {
  readonly Pool: new (config: PgPoolConfig) => PgPool
}
