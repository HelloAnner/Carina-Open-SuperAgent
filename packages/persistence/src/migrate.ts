import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, 'migrations')

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })

const run = async (): Promise<void> => {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map(row => row.name))
  const files = (await readdir(migrationsDir)).filter(file => file.endsWith('.sql')).sort()
  for (const file of files) {
    if (applied.has(file)) continue
    const body = await readFile(join(migrationsDir, file), 'utf8')
    const statements = body
      .split(/;\s*\n/)
      .map(statement => statement.trim())
      .filter(Boolean)
    await sql.begin(async tx => {
      for (const statement of statements) await tx.unsafe(statement)
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`
    })
    console.log(`applied ${file}`)
  }
  await sql.end()
}

run().catch(async error => {
  console.error(error)
  await sql.end()
  process.exit(1)
})
