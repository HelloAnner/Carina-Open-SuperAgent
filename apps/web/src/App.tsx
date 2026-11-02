import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'

interface Domain {
  id: string
  tenantId: string
  name: string
  policy: { version: string; paused: boolean }
}

interface Task {
  id: string
  title: string
  state: string
  scope: string
  acceptance: string
  mandate: { strength: string; allowedActions: string[] }
  updatedAt: string
}

interface Trigger {
  id: string
  sourceKind: string
  objectType: string
  objectId: string
  summary: string
  actor: { id: string; kind: string }
  receivedAt: string
}

interface Evaluation {
  id: string
  threadKey: string
  status: string
  decision?: { kind: string; reason?: string }
  startedAt: string
}

interface OutboxItem {
  id: string
  kind: string
  status: string
  text: string
  createdAt: string
}

interface Report {
  id: string
  kind: string
  body: string
  createdAt: string
}

const api = async <T,>(path: string, key: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-carina-key': key } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

const time = (value: string): string =>
  new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

export const App = (): ReactElement => {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('carina-key') ?? '')
  const [domains, setDomains] = useState<Domain[]>([])
  const [domainId, setDomainId] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [triggers, setTriggers] = useState<Trigger[]>([])
  const [evaluations, setEvaluations] = useState<Evaluation[]>([])
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const [selected, setSelected] = useState<Task | null>(null)
  const [reports, setReports] = useState<Report[]>([])
  const [text, setText] = useState('支付回调增加自动重试，需要检查幂等规则')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    localStorage.setItem('carina-key', apiKey)
  }, [apiKey])

  useEffect(() => {
    api<Domain[]>('/api/domains', apiKey)
      .then(items => {
        setDomains(items)
        setDomainId(current => current || items[0]?.id || '')
      })
      .catch(error => setError(String(error)))
  }, [apiKey])

  const load = useCallback(async () => {
    if (!domainId) return
    const [taskItems, triggerItems, evalItems, outboxItems] = await Promise.all([
      api<Task[]>(`/api/domains/${domainId}/tasks`, apiKey),
      api<Trigger[]>(`/api/domains/${domainId}/triggers`, apiKey),
      api<Evaluation[]>(`/api/domains/${domainId}/evaluations`, apiKey),
      api<OutboxItem[]>(`/api/domains/${domainId}/outbox`, apiKey),
    ])
    setTasks(taskItems)
    setTriggers(triggerItems)
    setEvaluations(evalItems)
    setOutbox(outboxItems)
  }, [domainId, apiKey])

  useEffect(() => {
    load().catch(error => setError(String(error)))
  }, [load])

  useEffect(() => {
    if (!domainId) return
    const query = new URLSearchParams({ domainId })
    if (apiKey) query.set('key', apiKey)
    const source = new EventSource(`/api/events?${query.toString()}`)
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = () => {
      void load()
    }
    const handler = (): void => {
      void load()
    }
    for (const type of ['trigger.received', 'decision.recorded', 'task.created', 'assignment.finished', 'outbox.sent']) {
      source.addEventListener(type, handler)
    }
    return () => source.close()
  }, [domainId, apiKey, load])

  const openTask = async (task: Task): Promise<void> => {
    setSelected(task)
    const detail = await api<{ task: Task; reports: Report[] }>(`/api/tasks/${task.id}`, apiKey)
    setReports(detail.reports)
  }

  const simulate = async (): Promise<void> => {
    if (!domainId || !text.trim()) return
    setBusy(true)
    setError('')
    try {
      await api('/api/dev/simulate', apiKey, {
        method: 'POST',
        body: JSON.stringify({ domainId, text }),
      })
      setText('')
      await load()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (task: Task): Promise<void> => {
    await api(`/api/tasks/${task.id}/cancel`, apiKey, { method: 'POST' })
    setSelected(null)
    await load()
  }

  const stats = useMemo(
    () => [
      { label: '任务', value: tasks.length },
      { label: '进行中', value: tasks.filter(task => ['running', 'open', 'blocked', 'awaiting_input'].includes(task.state)).length },
      { label: '触发', value: triggers.length },
      { label: '待发', value: outbox.filter(item => item.status !== 'sent').length },
    ],
    [tasks, triggers, outbox],
  )

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">Carina</div>
        <div className="side-title">协作域</div>
        {domains.map(domain => (
          <button
            key={domain.id}
            className={`domain ${domain.id === domainId ? 'active' : ''}`}
            onClick={() => {
              setDomainId(domain.id)
              setSelected(null)
            }}
          >
            <span>{domain.name}</span>
            <small>{domain.id}</small>
          </button>
        ))}
        <div className="side-foot">
          <span className={`dot ${connected ? 'on' : ''}`} />
          {connected ? '实时连接' : '未连接'}
        </div>
      </aside>

      <main className="main">
        <header className="top">
          <div>
            <h1>{domains.find(domain => domain.id === domainId)?.name ?? 'Carina'}</h1>
            <p className="muted">
              {evaluations.length} 次研判 · {outbox.filter(item => item.status === 'sent').length} 条已发送
            </p>
          </div>
          <input
            className="key"
            type="password"
            placeholder="API key"
            value={apiKey}
            onChange={event => setApiKey(event.target.value)}
          />
        </header>

        {error ? <div className="error">{error}</div> : null}

        <section className="stats">
          {stats.map(item => (
            <div key={item.label} className="stat">
              <strong>{item.value}</strong>
              <span>{item.label}</span>
            </div>
          ))}
        </section>

        <section className="compose">
          <input
            value={text}
            placeholder="模拟一条外部事件"
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void simulate()
            }}
          />
          <button disabled={busy || !text.trim()} onClick={() => void simulate()}>
            {busy ? '发送中' : '发送'}
          </button>
        </section>

        <div className="grid">
          <section className="panel">
            <div className="panel-head">
              <h2>任务</h2>
              <span className="muted">{tasks.length}</span>
            </div>
            <div className="list">
              {tasks.length === 0 ? <div className="empty">暂无任务</div> : null}
              {tasks.map(task => (
                <button
                  key={task.id}
                  className={`row ${selected?.id === task.id ? 'active' : ''}`}
                  onClick={() => void openTask(task)}
                >
                  <span className="row-main">
                    <span className="title">{task.title}</span>
                    <span className="muted">{task.scope}</span>
                  </span>
                  <span className={`state ${task.state}`}>{task.state}</span>
                  <span className="muted time">{time(task.updatedAt)}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>最近事件</h2>
              <span className="muted">{triggers.length}</span>
            </div>
            <div className="list">
              {triggers.slice(0, 20).map(trigger => (
                <div key={trigger.id} className="row static">
                  <span className="row-main">
                    <span className="title">{trigger.summary.slice(0, 120)}</span>
                    <span className="muted">
                      {trigger.sourceKind} · {trigger.actor.id} · {trigger.objectId}
                    </span>
                  </span>
                  <span className="muted time">{time(trigger.receivedAt)}</span>
                </div>
              ))}
              {triggers.length === 0 ? <div className="empty">暂无事件</div> : null}
            </div>
          </section>
        </div>

        <section className="panel">
          <div className="panel-head">
            <h2>研判</h2>
            <span className="muted">{evaluations.length}</span>
          </div>
          <div className="list compact">
            {evaluations.slice(0, 12).map(evaluation => (
              <div key={evaluation.id} className="row static">
                <span className="row-main">
                  <span className="title">{evaluation.decision?.kind ?? evaluation.status}</span>
                  <span className="muted">{evaluation.threadKey}</span>
                </span>
                <span className="muted time">{time(evaluation.startedAt)}</span>
              </div>
            ))}
            {evaluations.length === 0 ? <div className="empty">暂无研判</div> : null}
          </div>
        </section>
      </main>

      {selected ? (
        <aside className="drawer">
          <div className="drawer-head">
            <h2>{selected.title}</h2>
            <button className="ghost" onClick={() => setSelected(null)}>
              关闭
            </button>
          </div>
          <dl>
            <dt>状态</dt>
            <dd>{selected.state}</dd>
            <dt>范围</dt>
            <dd>{selected.scope}</dd>
            <dt>验收</dt>
            <dd>{selected.acceptance}</dd>
            <dt>授权</dt>
            <dd>
              {selected.mandate.strength} · {selected.mandate.allowedActions.join(', ') || 'read'}
            </dd>
          </dl>
          <div className="drawer-head">
            <h3>报告</h3>
            <span className="muted">{reports.length}</span>
          </div>
          <div className="reports">
            {reports.length === 0 ? <div className="empty">暂无报告</div> : null}
            {reports.map(report => (
              <div key={report.id} className="report">
                <span className={`state ${report.kind}`}>{report.kind}</span>
                <p>{report.body}</p>
              </div>
            ))}
          </div>
          {!['succeeded', 'failed', 'cancelled'].includes(selected.state) ? (
            <button className="danger" onClick={() => void cancel(selected)}>
              停止任务
            </button>
          ) : null}
        </aside>
      ) : null}
    </div>
  )
}
