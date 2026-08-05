#!/usr/bin/env node
// Local M2 dogfood dashboard: reads ~/.mcp-journal (session journals, tool
// inventory, approvals queue) plus the project policy and renders one fully
// static dashboard.html next to the repo root. No server, no client JS.
//
//   node tools/dashboard.mjs && open dashboard.html
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const JOURNAL_DIR = join(homedir(), '.mcp-journal')
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const POLICY_PATH = join(REPO_ROOT, '.mcp-journal', 'policy.json')
const OUT_PATH = join(REPO_ROOT, 'dashboard.html')
const RECENT_DECISIONS_LIMIT = 40
const RESOLVED_APPROVALS_LIMIT = 20

// -- collect ------------------------------------------------------------

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function readApprovals(subdir) {
  const dir = join(JOURNAL_DIR, 'approvals', subdir)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const entries = await Promise.all(
    names.filter((n) => n.endsWith('.json')).map((n) => readJson(join(dir, n), null)),
  )
  return entries.filter(Boolean)
}

async function collect() {
  const files = (await readdir(JOURNAL_DIR)).filter((n) => n.endsWith('.jsonl')).sort()
  const sessions = []
  const outcomeCounts = {}
  const recentDecisions = []

  for (const file of files) {
    const lines = (await readFile(join(JOURNAL_DIR, file), 'utf8')).split('\n').filter(Boolean)
    const records = lines.flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    if (records.length === 0) continue
    const decisions = records.filter((r) => r.kind === 'decision')
    const byOutcome = {}
    for (const d of decisions) {
      const outcome = d.decision?.outcome ?? 'unknown'
      byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1
      outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1
      recentDecisions.push({
        ts: d.ts,
        server: d.decision?.serverName ?? '',
        tool: d.decision?.toolName ?? '',
        outcome,
        rule: d.decision?.rule ?? '',
      })
    }
    sessions.push({
      id: file.replace('.jsonl', ''),
      firstTs: records[0]?.ts ?? null,
      messages: records.length,
      decisions: decisions.length,
      byOutcome,
    })
  }

  recentDecisions.sort((a, b) => (a.ts < b.ts ? 1 : -1))

  const inventoryRaw = await readJson(join(JOURNAL_DIR, 'tool-inventory.json'), { servers: {} })
  const inventory = Object.fromEntries(
    Object.entries(inventoryRaw.servers ?? {}).map(([server, entry]) => [
      server,
      {
        approved: Object.entries(entry.approved ?? {}).map(([name, r]) => ({
          name,
          approvedAt: r.approvedAt ?? null,
          hash: (r.schemaHash ?? '').slice(0, 12),
        })),
        quarantined: Object.entries(entry.quarantined ?? {}).map(([name, r]) => ({
          name,
          state: r.state ?? 'new',
        })),
      },
    ]),
  )

  return {
    generatedAt: new Date().toISOString(),
    policy: await readJson(POLICY_PATH, null),
    policySource: POLICY_PATH,
    sessions: sessions.sort((a, b) => (a.firstTs < b.firstTs ? 1 : -1)),
    outcomeCounts,
    recentDecisions: recentDecisions.slice(0, RECENT_DECISIONS_LIMIT),
    inventory,
    approvals: {
      pending: await readApprovals('pending'),
      resolved: (await readApprovals('resolved')).slice(-RESOLVED_APPROVALS_LIMIT),
    },
  }
}

// -- render -------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const fmtTs = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const OUTCOME_META = {
  allow: { label: 'разрешён', tone: 'good' },
  approved: { label: 'одобрен оператором', tone: 'good' },
  'require-approval-pending': { label: 'ждал одобрения', tone: 'warn' },
  timeout: { label: 'таймаут одобрения', tone: 'serious' },
  deny: { label: 'запрещён', tone: 'serious' },
  'denied-by-operator': { label: 'отклонён оператором', tone: 'serious' },
  quarantined: { label: 'карантин', tone: 'warn' },
  expired: { label: 'истекла', tone: 'muted' },
}
const meta = (o) => OUTCOME_META[o] ?? { label: o, tone: 'muted' }
const pill = (o) => `<span class="pill pill--${meta(o).tone}"><code>${esc(o)}</code></span>`

function render(data) {
  const totalMessages = data.sessions.reduce((n, s) => n + s.messages, 0)
  const totalDecisions = data.sessions.reduce((n, s) => n + s.decisions, 0)
  const approvedTools = Object.values(data.inventory).reduce((n, s) => n + s.approved.length, 0)
  const quarantinedTools = Object.values(data.inventory).reduce((n, s) => n + s.quarantined.length, 0)

  const tilesHtml = [
    ['Сессий в журнале', data.sessions.length],
    ['Сообщений записано', totalMessages],
    ['Решений гейта', totalDecisions],
    ['Ждут одобрения', data.approvals.pending.length],
    ['Тулзов одобрено', approvedTools],
    ['В карантине', quarantinedTools],
  ]
    .map(([label, value]) => `<div class="tile"><div class="tile__value">${value}</div><div class="tile__label">${label}</div></div>`)
    .join('\n')

  const outcomes = Object.entries(data.outcomeCounts).sort((a, b) => b[1] - a[1])
  const maxOutcome = Math.max(...outcomes.map(([, n]) => n), 1)
  const outcomesHtml = outcomes
    .map(
      ([o, n]) => `<div class="bar-row">
      <div class="bar-row__label"><code>${esc(o)}</code><span class="bar-row__ru">${meta(o).label}</span></div>
      <div class="bar-row__track"><div class="bar-row__fill bar-row__fill--${meta(o).tone}" style="width:${Math.max((n / maxOutcome) * 100, 3).toFixed(1)}%"></div></div>
      <div class="bar-row__count">${n}</div>
    </div>`,
    )
    .join('\n')

  const p = data.policy ?? {}
  const policyRows = [
    ['defaultDecision', p.defaultDecision],
    ['classDefaults', JSON.stringify(p.classDefaults ?? {})],
    ['quarantine', p.quarantine ? `${p.quarantine.enabled ? 'on' : 'off'} → ${p.quarantine.onQuarantined ?? 'require-approval'}` : '—'],
    ['toolsList.filter', p.toolsList?.filter ?? 'hide-denied'],
    ['approval', p.approval ? `timeout ${p.approval.timeoutMs ?? 60000} мс · грант ${p.approval.grantTtlMs ?? 300000} мс` : 'timeout 60000 мс · грант 300000 мс (дефолты)'],
    ['journal.failClosed', String(p.journal?.failClosed ?? false)],
  ]
    .map(([k, v]) => `<div class="kv"><div class="kv__k"><code>${esc(k)}</code></div><div class="kv__v"><code>${esc(v)}</code></div></div>`)
    .join('\n')

  const inventoryHtml = Object.entries(data.inventory)
    .map(([server, entry]) => {
      const chips = entry.approved
        .map((t) => `<span class="chip" title="одобрен ${esc(fmtTs(t.approvedAt))} · схема ${esc(t.hash)}"><code>${esc(t.name)}</code></span>`)
        .join('')
      const qchips = entry.quarantined.map((t) => `<span class="chip chip--warn"><code>${esc(t.name)}</code></span>`).join('')
      return `<div class="panel">
      <div class="panel__head"><h3><code>${esc(server)}</code></h3><span class="panel__meta">${entry.approved.length} одобрено${entry.quarantined.length ? ` · ${entry.quarantined.length} в карантине` : ''}</span></div>
      <div class="chips">${chips}${qchips}</div>
    </div>`
    })
    .join('\n')

  const approvalRow = (a, resolved) => `<tr>
    <td><code>${esc(a.approvalId.slice(-8))}</code></td>
    <td><code>${esc(a.serverName)}</code> / <code>${esc(a.toolName)}</code></td>
    <td><code>${esc(a.toolClass)}</code></td>
    <td>${pill(a.status?.outcome ?? 'pending')}</td>
    <td>${esc(a.status?.reason ?? '')}</td>
    <td class="num">${esc(fmtTs(resolved ? a.resolvedAt ?? a.requestedAt : a.requestedAt))}</td>
  </tr>`
  const approvalsRows = [
    ...data.approvals.pending.map((a) => approvalRow(a, false)),
    ...[...data.approvals.resolved].reverse().map((a) => approvalRow(a, true)),
  ].join('\n')

  const sessionsRows = data.sessions
    .map((s) => {
      const mix = Object.entries(s.byOutcome)
        .map(([o, n]) => `<span class="pill pill--${meta(o).tone}"><code>${esc(o)}</code>&nbsp;${n}</span>`)
        .join(' ')
      return `<tr>
      <td><code>${esc(s.id.slice(-8))}</code></td>
      <td class="num">${esc(fmtTs(s.firstTs))}</td>
      <td class="num">${s.messages}</td>
      <td class="num">${s.decisions}</td>
      <td>${mix || '<span class="muted">только трафик</span>'}</td>
    </tr>`
    })
    .join('\n')

  const feedRows = data.recentDecisions
    .map(
      (d) => `<tr>
      <td class="num">${esc(fmtTs(d.ts))}</td>
      <td><code>${esc(d.server)}</code></td>
      <td><code>${esc(d.tool)}</code></td>
      <td>${pill(d.outcome)}</td>
      <td><code>${esc(d.rule)}</code></td>
    </tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP Control Plane — снапшот журнала</title>
<style>
:root {
  --bg: #f2f5f5; --surface: #ffffff; --line: #dbe4e5;
  --ink: #16262b; --muted: #5a7078; --accent: #0e7b87; --accent-ink: #0a5b64;
  --good: #2f7d45; --warn: #a8730f; --serious: #bf3f3f; --tone-muted: #7d9096;
  --good-bg: #e4f2e8; --warn-bg: #f7ecd8; --serious-bg: #f9e5e5; --muted-bg: #e8eeef;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1518; --surface: #172024; --line: #26343a;
    --ink: #e2ebed; --muted: #8ba1a8; --accent: #41c0cc; --accent-ink: #6cd2dc;
    --good: #57c07a; --warn: #d9a13c; --serious: #e07070; --tone-muted: #8ba1a8;
    --good-bg: #1b3324; --warn-bg: #38300f; --serious-bg: #3d2020; --muted-bg: #223035;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
}
code, .num {
  font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.num { font-variant-numeric: tabular-nums; }
.wrap { max-width: 1140px; margin: 0 auto; padding: 40px 24px 64px; display: flex; flex-direction: column; gap: 28px; }
header .eyebrow {
  text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px; font-weight: 600;
  color: var(--accent-ink);
}
header h1 { margin: 6px 0 4px; font-size: 26px; letter-spacing: -0.01em; text-wrap: balance; }
header .sub { color: var(--muted); font-size: 14px; }
.mode {
  display: inline-flex; align-items: center; gap: 7px; margin-top: 12px;
  border: 1px solid var(--line); background: var(--surface); border-radius: 999px;
  padding: 5px 14px 5px 10px; font-size: 13px; color: var(--muted);
}
.mode::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--good); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
.tile__value { font-size: 27px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.1; }
.tile__label { margin-top: 4px; color: var(--muted); font-size: 12.5px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; }
.panel__head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.panel h2, .panel h3 { margin: 0; font-size: 15.5px; }
.panel__meta { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.bar-row { display: grid; grid-template-columns: minmax(150px, 220px) 1fr 44px; gap: 10px; align-items: center; padding: 6px 0; }
.bar-row__label { display: flex; flex-direction: column; line-height: 1.25; }
.bar-row__ru { color: var(--muted); font-size: 11.5px; }
.bar-row__track { background: var(--muted-bg); border-radius: 4px; height: 14px; overflow: hidden; }
.bar-row__fill { height: 100%; border-radius: 0 4px 4px 0; }
.bar-row__fill--good { background: var(--good); }
.bar-row__fill--warn { background: var(--warn); }
.bar-row__fill--serious { background: var(--serious); }
.bar-row__fill--muted { background: var(--tone-muted); }
.bar-row__count { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.kv { display: grid; grid-template-columns: 160px 1fr; gap: 10px; padding: 6px 0; border-bottom: 1px dashed var(--line); }
.kv:last-child { border-bottom: none; }
.kv__k { color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  border: 1px solid var(--line); background: var(--bg); border-radius: 6px;
  padding: 2.5px 8px; font-size: 12.5px;
}
.chip--warn { border-color: var(--warn); background: var(--warn-bg); }
.pill {
  display: inline-flex; align-items: center; border-radius: 999px; padding: 1.5px 9px;
  font-size: 11.5px; white-space: nowrap;
}
.pill--good { background: var(--good-bg); color: var(--good); }
.pill--warn { background: var(--warn-bg); color: var(--warn); }
.pill--serious { background: var(--serious-bg); color: var(--serious); }
.pill--muted { background: var(--muted-bg); color: var(--muted); }
.table-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th {
  text-align: left; text-transform: uppercase; letter-spacing: 0.09em; font-size: 10.5px;
  color: var(--muted); font-weight: 600; padding: 6px 12px 8px 0; border-bottom: 1px solid var(--line);
}
td { padding: 7px 12px 7px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: none; }
.muted { color: var(--muted); }
footer { color: var(--muted); font-size: 12.5px; border-top: 1px solid var(--line); padding-top: 16px; }
footer code { font-size: 11.5px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">MCP Control Plane · M2 dogfood</div>
    <h1>Журнал, политики и одобрения — статический снапшот</h1>
    <div class="sub">Снят ${esc(fmtTs(data.generatedAt))} из <code>~/.mcp-journal</code>. Пересобрать: <code>node tools/dashboard.mjs</code>. Живой Admin UI — milestone 4.</div>
    <div class="mode">enforcement включён: <code>&nbsp;${esc(p.defaultDecision ?? 'require-approval')}</code>&nbsp;по умолчанию, read → allow</div>
  </header>

  <section class="tiles">
${tilesHtml}
  </section>

  <div class="cols">
    <section class="panel">
      <div class="panel__head"><h2>Решения гейта по исходам</h2><span class="panel__meta">${totalDecisions} всего</span></div>
${outcomesHtml}
    </section>
    <section class="panel">
      <div class="panel__head"><h2>Действующая политика</h2><span class="panel__meta">проектная</span></div>
${policyRows}
    </section>
  </div>

  <div class="cols">
${inventoryHtml}
  </div>

  <section class="panel">
    <div class="panel__head"><h2>Одобрения</h2><span class="panel__meta">${data.approvals.pending.length} в очереди · ${data.approvals.resolved.length} разрешено</span></div>
    <div class="table-scroll"><table>
      <thead><tr><th>ID</th><th>Сервер / тулза</th><th>Класс</th><th>Исход</th><th>Причина</th><th>Когда</th></tr></thead>
      <tbody>${approvalsRows || '<tr><td colspan="6" class="muted">очередь пуста</td></tr>'}</tbody>
    </table></div>
  </section>

  <section class="panel">
    <div class="panel__head"><h2>Сессии</h2><span class="panel__meta">${totalMessages} сообщений</span></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Сессия</th><th>Начало</th><th>Сообщ.</th><th>Решений</th><th>Исходы</th></tr></thead>
      <tbody>${sessionsRows}</tbody>
    </table></div>
  </section>

  <section class="panel">
    <div class="panel__head"><h2>Последние решения</h2><span class="panel__meta">${data.recentDecisions.length} записей</span></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Время</th><th>Сервер</th><th>Тулза</th><th>Исход</th><th>Правило</th></tr></thead>
      <tbody>${feedRows}</tbody>
    </table></div>
  </section>

  <footer>
    Источники: <code>~/.mcp-journal/*.jsonl</code> · <code>tool-inventory.json</code> · <code>approvals/</code> · политика <code>${esc(data.policySource)}</code>.
    Секреты редактируются до записи в журнал — на этой странице их нет по построению.
  </footer>
</div>
</body>
</html>
`
}

const data = await collect()
await writeFile(OUT_PATH, render(data), 'utf8')
process.stdout.write(`written: ${OUT_PATH}\n`)
