import type { QuarantineState } from '../../journal/decision-info.js'
import { effectiveToolRule, hasExplicitRule, type EffectiveRuleSource } from '../../policy/effective.js'
import type { InventoryStoreData } from '../../policy/inventory-store.js'
import type { Policy, PolicyOutcome, ToolClass } from '../../policy/schema.js'
import { html, join, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'

/**
 * The per-tool policy rule on the Servers card (plan policy-tool-rules-ui
 * §6, ADR-0009): the effective outcome pill, its source label, and the
 * owner's three button-forms plus reset. The outcome/source projection is
 * `effectiveToolRule` — the one interpretation of the policy in this
 * codebase (finding 2); this module only maps it to markup.
 *
 * Every form carries the SAME full path in `action=` and `data-action=`
 * (the client script fetches `data-action` verbatim; without JS the form
 * posts natively and the handler answers 303). Names are percent-encoded
 * into the path and escaped into markup: a hostile inventory name can
 * neither add a path segment nor break out of an attribute.
 */

/** The `rule` field's vocabulary: the three outcomes plus the explicit-rule reset. */
export const TOOL_RULE_FIELD_VALUES = ['allow', 'require-approval', 'deny', 'clear'] as const
export type ToolRuleField = (typeof TOOL_RULE_FIELD_VALUES)[number]

/** The projection the card renders for one tool. */
export interface ToolRuleView {
  readonly outcome: PolicyOutcome
  readonly source: EffectiveRuleSource
  /** The `servers.<name>.tools` key that matched (explicit / wildcard only). */
  readonly pattern?: string
  readonly toolClass: ToolClass
  /** True when an exact rule exists — what "reset" removes. */
  readonly explicit: boolean
}

/** Whether and how the rule controls render for this page view. */
export type ToolRuleControls =
  | { readonly mode: 'hidden' }
  | { readonly mode: 'enabled'; readonly expectedHash: string }
  | { readonly mode: 'disabled'; readonly reason: string }

/** Short labels beside the pill; the source vocabulary of `effectiveToolRule`. */
const SOURCE_LABELS: Readonly<Record<EffectiveRuleSource, string>> = {
  explicit: 'rule',
  wildcard: 'rule',
  'server-default': 'server default',
  'class-default': 'class',
  'global-default': 'default',
  quarantine: 'quarantine',
  'shadow-tool': 'shadow',
  'surface-changed': 'surface changed',
}

const BUTTONS: ReadonlyArray<{ readonly rule: PolicyOutcome; readonly label: string }> = [
  { rule: 'allow', label: 'allow' },
  { rule: 'require-approval', label: 'approval' },
  { rule: 'deny', label: 'deny' },
]

/** The action path of one tool's rule form; both names percent-encoded, so neither can add a segment. */
export function toolRuleActionPath(serverName: string, toolName: string): string {
  return `/servers/${encodeURIComponent(serverName)}/tools/${encodeURIComponent(toolName)}/rule`
}

/** The `data-live-region` key of one server's tools panel (settle-only; no SSE topic). */
export function serverToolsRegionKey(serverName: string): string {
  return `server-tools:${serverName}`
}

/** The inventory's view of a tool, in the gate's vocabulary (`inventory.stateOf`). */
export function quarantineStateOf(
  inventory: InventoryStoreData,
  serverName: string,
  toolName: string,
): QuarantineState {
  const entry = Object.hasOwn(inventory.servers, serverName) ? inventory.servers[serverName] : undefined
  if (entry === undefined) return 'unknown'
  const quarantined = Object.hasOwn(entry.quarantined, toolName) ? entry.quarantined[toolName] : undefined
  if (quarantined !== undefined) return quarantined.state
  return Object.hasOwn(entry.approved, toolName) ? 'known' : 'unknown'
}

/** The rule view for one inventory tool under `policy`. */
export function toolRuleViewOf(
  policy: Policy,
  inventory: InventoryStoreData,
  serverName: string,
  toolName: string,
): ToolRuleView {
  const entry = Object.hasOwn(inventory.servers, serverName) ? inventory.servers[serverName] : undefined
  const quarantined = entry !== undefined && Object.hasOwn(entry.quarantined, toolName) ? entry.quarantined[toolName] : undefined
  const approved = entry !== undefined && Object.hasOwn(entry.approved, toolName) ? entry.approved[toolName] : undefined
  const descriptor = quarantined?.descriptor ?? approved?.descriptor
  const effective = effectiveToolRule({
    policy,
    serverName,
    tool: {
      name: toolName,
      quarantineState: quarantineStateOf(inventory, serverName, toolName),
      ...(descriptor !== undefined ? { descriptor } : {}),
      ...(quarantined?.surfaceDelta !== undefined ? { surfaceDelta: quarantined.surfaceDelta } : {}),
    },
  })
  return {
    outcome: effective.outcome,
    source: effective.source,
    ...(effective.pattern !== undefined ? { pattern: effective.pattern } : {}),
    toolClass: effective.toolClass,
    explicit: hasExplicitRule(policy, serverName, toolName),
  }
}

function pillClassOf(outcome: PolicyOutcome): string {
  if (outcome === 'deny') return 'pill pill-alert srv-rule srv-rule-deny'
  if (outcome === 'require-approval') return 'pill pill-on srv-rule srv-rule-approval'
  return 'pill srv-rule srv-rule-allow'
}

function sourceTextOf(view: ToolRuleView): string {
  if (view.source === 'wildcard') return `rule ${view.pattern ?? '*'}`
  if (view.source === 'class-default') return `class ${view.toolClass}`
  return SOURCE_LABELS[view.source]
}

/** The outcome pill + source label; shown to every role. */
export function renderToolRulePill(view: ToolRuleView): Html {
  const label = view.outcome === 'require-approval' ? 'approval' : view.outcome
  return html`<span class="${pillClassOf(view.outcome)}">${label}</span><span class="srv-rule-src faint small">${sourceTextOf(view)}</span>`
}

interface RuleFormOptions {
  readonly serverName: string
  readonly toolName: string
  readonly csrfToken: string
  readonly controls: Exclude<ToolRuleControls, { mode: 'hidden' }>
  readonly rule: ToolRuleField
  readonly label: string
  readonly pressed: boolean
}

/**
 * One rule button-form. A disabled control carries no `data-action` at all,
 * so the script cannot submit it either — the disabled button is the whole
 * story, with the reason as its tooltip.
 */
function renderRuleForm(options: RuleFormOptions): Html {
  const { controls, pressed } = options
  const target = toolRuleActionPath(options.serverName, options.toolName)
  const buttonClass = `secondary srv-rule-btn srv-rule-btn-${options.rule}${pressed ? ' is-on' : ''}`
  const button =
    controls.mode === 'enabled'
      ? html`<button type="submit" class="${buttonClass}" aria-pressed="${pressed ? 'true' : 'false'}">${options.label}</button>`
      : html`<button type="submit" class="${buttonClass}" aria-pressed="${pressed ? 'true' : 'false'}" disabled title="${controls.reason}">${options.label}</button>`
  const scripted = controls.mode === 'enabled' ? html`data-action="${target}"` : html``
  const expectedHash = controls.mode === 'enabled' ? controls.expectedHash : ''
  return html`<form method="post" action="${target}" ${scripted} class="inline srv-rule-form">
      ${csrfField(options.csrfToken)}
      <input type="hidden" name="rule" value="${options.rule}" />
      <input type="hidden" name="expected_hash" value="${expectedHash}" />
      ${button}
    </form>`
}

export interface ToolRuleControlsOptions {
  readonly serverName: string
  readonly toolName: string
  readonly csrfToken: string
  readonly view: ToolRuleView
  readonly controls: ToolRuleControls
}

/** The owner's control row: `allow · approval · deny` and, with an exact rule, `reset`. Nothing when hidden. */
export function renderToolRuleControls(options: ToolRuleControlsOptions): Html {
  const { controls, view } = options
  if (controls.mode === 'hidden') return html``
  const base = { serverName: options.serverName, toolName: options.toolName, csrfToken: options.csrfToken, controls }
  const forms = BUTTONS.map((button) =>
    renderRuleForm({ ...base, rule: button.rule, label: button.label, pressed: view.explicit && view.outcome === button.rule }),
  )
  const reset = view.explicit ? [renderRuleForm({ ...base, rule: 'clear', label: 'reset', pressed: false })] : []
  return html`<div class="actions srv-rule-ctl">${join([...forms, ...reset])}</div>`
}
