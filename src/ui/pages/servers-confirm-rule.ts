import { CONFIRM_ANY_AGENT } from '../../policy/constants.js'
import type { Policy } from '../../policy/schema.js'
import { html, join, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'
import type { ToolRuleControls } from './servers-tool-rule.js'

/**
 * The per-tool CLIENT rule on the Servers card (ADR-0019): who must confirm a
 * tool call at their MCP client, shown beside the admin rule. A tool needs
 * confirmation for an agent when ANY matching `confirmInClient` entry — the
 * exact key and every matching `prefix*` key — names that agent or `"*"`, so
 * the effective rule is the UNION of those entries. The form edits only the
 * EXACT key (`policy/edit/set-confirm-in-client.ts`); what a pattern covers is
 * shown checked and disabled, with the pattern named, and is changed in
 * `policy.json`.
 *
 * Forms follow the admin rule's contract: the same full path in `action=` and
 * `data-action=` (the script fetches `data-action`; without JS the form posts
 * natively and the handler answers 303), a disabled control carries no
 * `data-action`, names are percent-encoded into the path and escaped into
 * markup.
 */

/** The `confirm` field's vocabulary. */
export const CONFIRM_FIELD_VALUES = ['off', 'all', 'agents'] as const
export type ConfirmField = (typeof CONFIRM_FIELD_VALUES)[number]

/** One matching `prefix*` entry and the agents it names. */
export interface ConfirmPatternEntry {
  readonly pattern: string
  readonly agents: readonly string[]
}

/** The `confirmInClient` entries that apply to one tool: its exact key (when set) and every matching pattern. */
export interface ConfirmRuleView {
  readonly exact?: readonly string[]
  /** Longest prefix first, then by name — a stable order for the label. */
  readonly patterns: readonly ConfirmPatternEntry[]
}

/** Which agents the per-tool form can offer. */
export type ConfirmAgents =
  /** A registry server: one checkbox per agent with a grant on it. */
  | { readonly kind: 'agents'; readonly granted: readonly string[]; readonly known: readonly string[] }
  /** A server run under `wrap` here: there is no agent name, only off / all. */
  | { readonly kind: 'wrap' }

const WILDCARD_SUFFIX = '*'
const ALL_LABEL = 'all'

/**
 * The per-tool view of `confirmInClient`: the exact entry's list plus the
 * matching pattern entries with their lists. Own helper — the policy's
 * matcher answers "most specific" for the admin rule, while this rule is a
 * union and the page must show every contributor.
 */
export function confirmRuleViewOf(policy: Policy, serverName: string, toolName: string): ConfirmRuleView {
  const servers = policy.servers
  const entries =
    servers !== undefined && Object.hasOwn(servers, serverName) ? servers[serverName]?.confirmInClient : undefined
  if (entries === undefined) return { patterns: [] }
  const patterns = Object.entries(entries)
    .filter(([key]) => key !== toolName && key.endsWith(WILDCARD_SUFFIX) && toolName.startsWith(key.slice(0, -1)))
    .map(([pattern, agents]) => ({ pattern, agents }))
    .sort((a, b) => b.pattern.length - a.pattern.length || (a.pattern < b.pattern ? -1 : 1))
  return Object.hasOwn(entries, toolName) ? { exact: entries[toolName] ?? [], patterns } : { patterns }
}

function listLabel(agents: readonly string[]): string {
  return agents.includes(CONFIRM_ANY_AGENT) ? ALL_LABEL : agents.join(', ')
}

/** `off`, or `laptop; all (rule write_*)`: the exact list first, then each pattern's list with its rule. */
export function confirmSummaryOf(view: ConfirmRuleView): string {
  const parts = [
    ...(view.exact !== undefined ? [listLabel(view.exact)] : []),
    ...view.patterns.map((entry) => `${listLabel(entry.agents)} (rule ${entry.pattern})`),
  ]
  return parts.length === 0 ? 'off' : parts.join('; ')
}

/** The client-rule pill: shown to every role. */
export function renderConfirmPill(view: ConfirmRuleView): Html {
  const isOff = view.exact === undefined && view.patterns.length === 0
  const pillClass = isOff ? 'pill srv-client srv-client-off' : 'pill pill-on srv-client'
  return html`<span class="${pillClass}">client: ${confirmSummaryOf(view)}</span>`
}

/** The action path of one tool's client-rule form; both names percent-encoded, so neither can add a segment. */
export function confirmActionPath(serverName: string, toolName: string): string {
  return `/servers/${encodeURIComponent(serverName)}/tools/${encodeURIComponent(toolName)}/confirm`
}

const PANEL_HINT =
  'Client confirmation: Accept / Decline in the client (checked in Claude Code). ' +
  'A client that cannot show it refuses the call; over HTTP (serve, connect --url, hosted) it is refused for now.'

/** The one hint line per tools panel. */
export function renderConfirmHint(): Html {
  return html`<div class="srv-tools-note faint small srv-client-hint">${PANEL_HINT}</div>`
}

export interface ConfirmControlsOptions {
  readonly serverName: string
  readonly toolName: string
  readonly csrfToken: string
  readonly view: ConfirmRuleView
  readonly controls: ToolRuleControls
  readonly agents: ConfirmAgents
  /** The admin rule's effective outcome is `deny`: nothing to confirm, so the control is off. */
  readonly isDenied: boolean
  /** An agent name to show in the `agent grant` next step; absent → a placeholder. */
  readonly grantExample?: string
}

type EditableControls = Exclude<ToolRuleControls, { mode: 'hidden' }>

const DENY_WINS_REASON = 'deny wins'

/** The controls' state after the deny check: a denied tool is disabled whatever the policy view says. */
function effectiveControls(controls: EditableControls, isDenied: boolean): EditableControls {
  return isDenied ? { mode: 'disabled', reason: DENY_WINS_REASON } : controls
}

function formHead(options: ConfirmControlsOptions, controls: EditableControls, confirm: ConfirmField): Html {
  const target = confirmActionPath(options.serverName, options.toolName)
  const scripted = controls.mode === 'enabled' ? html` data-action="${target}"` : html``
  const expectedHash = controls.mode === 'enabled' ? controls.expectedHash : ''
  return html`<form method="post" action="${target}"${scripted} class="inline srv-rule-form srv-client-form">
      ${csrfField(options.csrfToken)}
      <input type="hidden" name="confirm" value="${confirm}" />
      <input type="hidden" name="expected_hash" value="${expectedHash}" />`
}

function renderButton(controls: EditableControls, cls: string, label: string, pressed: boolean): Html {
  const aria = pressed ? 'true' : 'false'
  return controls.mode === 'enabled'
    ? html`<button type="submit" class="${cls}" aria-pressed="${aria}">${label}</button>`
    : html`<button type="submit" class="${cls}" aria-pressed="${aria}" disabled title="${controls.reason}">${label}</button>`
}

function renderChoice(options: ConfirmControlsOptions, controls: EditableControls, confirm: 'off' | 'all'): Html {
  const exact = options.view.exact
  const pressed = confirm === 'all' ? exact?.includes(CONFIRM_ANY_AGENT) === true : exact === undefined
  const cls = `secondary srv-rule-btn srv-client-btn${pressed ? ' is-on' : ''}`
  return html`${formHead(options, controls, confirm)}${renderButton(controls, cls, confirm, pressed)}</form>`
}

interface AgentChoice {
  readonly name: string
  readonly isChecked: boolean
  /** The pattern that covers this agent, when one does: the box is then fixed. */
  readonly viaPattern?: string
  /** Named by the policy but not in the agents store. */
  readonly isUnknown: boolean
  /** Also in the exact key while a pattern covers it: kept on re-save by a hidden field. */
  readonly isKeptExact: boolean
}

/** Pattern-covered agents win the label; `"*"` in a pattern covers every listed agent. */
function patternOf(view: ConfirmRuleView, name: string): string | undefined {
  return view.patterns.find((entry) => entry.agents.includes(CONFIRM_ANY_AGENT) || entry.agents.includes(name))?.pattern
}

function agentChoicesOf(view: ConfirmRuleView, agents: Extract<ConfirmAgents, { kind: 'agents' }>): readonly AgentChoice[] {
  const exact = (view.exact ?? []).filter((name) => name !== CONFIRM_ANY_AGENT)
  const fromPatterns = view.patterns.flatMap((entry) => entry.agents).filter((name) => name !== CONFIRM_ANY_AGENT)
  const names = [...new Set([...agents.granted, ...exact, ...fromPatterns])]
  return names.map((name) => {
    const viaPattern = patternOf(view, name)
    const inExact = exact.includes(name)
    return {
      name,
      isChecked: inExact || viaPattern !== undefined,
      ...(viaPattern !== undefined ? { viaPattern } : {}),
      isUnknown: !agents.known.includes(name),
      isKeptExact: viaPattern !== undefined && inExact,
    }
  })
}

function renderAgentChoice(choice: AgentChoice, controls: EditableControls): Html {
  const isFixed = choice.viaPattern !== undefined
  const checked = choice.isChecked ? html` checked` : html``
  const disabled = isFixed || controls.mode !== 'enabled' ? html` disabled` : html``
  const note = choice.viaPattern !== undefined ? html` <span class="faint">(rule ${choice.viaPattern})</span>` : html``
  const unknown = choice.isUnknown ? html` <span class="faint">(no such agent)</span>` : html``
  const kept = choice.isKeptExact ? html`<input type="hidden" name="agent" value="${choice.name}" />` : html``
  return html`<label class="srv-client-agent"><input type="checkbox" name="agent" value="${choice.name}"${checked}${disabled} /> ${choice.name}${note}${unknown}</label>${kept}`
}

function renderAgentsForm(options: ConfirmControlsOptions, controls: EditableControls, choices: readonly AgentChoice[]): Html {
  const isOn = options.view.exact !== undefined && !options.view.exact.includes(CONFIRM_ANY_AGENT)
  const cls = `secondary srv-rule-btn srv-client-btn${isOn ? ' is-on' : ''}`
  return html`${formHead(options, controls, 'agents')}
      <span class="srv-client-agents">${join(choices.map((choice) => renderAgentChoice(choice, controls)))}</span>
      ${renderButton(controls, cls, 'set agents', isOn)}</form>`
}

/** The one-line next step under the controls. */
function nextStepOf(options: ConfirmControlsOptions): Html {
  const { serverName, agents, view } = options
  if (agents.kind === 'wrap') {
    return html`<p class="srv-client-next faint small">Under wrap there is no agent name: only off / all apply. Run it with <code>--server &lt;name&gt;</code> for a readable name.</p>`
  }
  const pattern = view.patterns[0]?.pattern
  const patternLine = pattern !== undefined ? html` To change what rule ${pattern} covers, edit it in policy.json.` : html``
  if (agents.granted.length === 0) {
    const agent = options.grantExample ?? '<agent>'
    return html`<p class="srv-client-next faint small">No agent has a grant on ${serverName} yet — agents appear here once they do: <code>mcpcut agent grant ${agent} ${serverName}</code>.${patternLine}</p>`
  }
  return pattern === undefined ? html`` : html`<p class="srv-client-next faint small">${patternLine}</p>`
}

/** The owner's client control row: `off · all`, and the agents form when any agent has a grant. Nothing when hidden. */
export function renderConfirmControls(options: ConfirmControlsOptions): Html {
  if (options.controls.mode === 'hidden') return html``
  const controls = effectiveControls(options.controls, options.isDenied)
  const choices = options.agents.kind === 'agents' ? agentChoicesOf(options.view, options.agents) : []
  const form = options.agents.kind === 'agents' && choices.length > 0 ? renderAgentsForm(options, controls, choices) : html``
  const denied = options.isDenied ? html`<span class="faint small srv-client-deny">deny wins — the admin rule refuses this tool before any confirmation</span>` : html``
  return html`<div class="actions srv-rule-ctl srv-client-ctl">
    <span class="pixel upper srv-client-label">client</span>
    ${renderChoice(options, controls, 'off')}${renderChoice(options, controls, 'all')}${form}${denied}
  </div>${nextStepOf(options)}`
}
