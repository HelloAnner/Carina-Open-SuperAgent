import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Database = PostgresJsDatabase<typeof schema>

export interface DbHandle {
  db: Database
  sql: postgres.Sql
  close(): Promise<void>
}

export const createDb = (url: string, options: { max?: number } = {}): DbHandle => {
  const sql = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
  })
  const db = drizzle(sql, { schema })
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 })
    },
  }
}
