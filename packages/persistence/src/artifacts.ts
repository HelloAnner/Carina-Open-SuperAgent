import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import type { ArtifactStore } from '@carina/contracts'
import type { Database } from './db.js'
import { artifacts } from './schema.js'

/** Local-volume artifact store. Replace with S3-compatible storage behind the same port. */
export class LocalArtifactStore implements ArtifactStore {
  constructor(
    private readonly db: Database,
    private readonly root: string,
  ) {}

  async put(input: {
    tenantId: string
    domainId: string
    taskId: string
    kind: string
    body: string | Uint8Array
    mime?: string
  }): Promise<{ id: string; storageKey: string; sha256: string; size: number }> {
    const id = randomUUID()
    const bytes = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : Buffer.from(input.body)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const extension = input.kind === 'json' ? 'json' : input.kind === 'diff' ? 'diff' : 'txt'
    const storageKey = normalize(join(input.tenantId, input.domainId, `${id}.${extension}`))
    const path = join(this.root, storageKey)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    await this.db.insert(artifacts).values({
      id,
      tenantId: input.tenantId,
      domainId: input.domainId,
      taskId: input.taskId || null,
      kind: input.kind,
      mime: input.mime ?? 'text/plain',
      size: bytes.byteLength,
      storageKey,
      sha256,
    })
    return { id, storageKey, sha256, size: bytes.byteLength }
  }

  async get(storageKey: string): Promise<Uint8Array> {
    const path = join(this.root, normalize(storageKey))
    return readFile(path)
  }
}
