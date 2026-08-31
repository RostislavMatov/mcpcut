/**
 * "N nouns" — the one place the admin UI turns a count into a phrase.
 *
 * It existed three times over (`pages/agents.ts`, `pages/groups.ts`,
 * `pages/groups-parts.ts`) and each copy silently produced "1 groups" in the
 * one place a reader is most likely to be counting: a confirmation
 * interstitial. One helper, one behaviour.
 *
 * `pluralNoun` is for the nouns `-s` gets wrong; every regular caller omits it.
 */
export function plural(count: number, noun: string, pluralNoun?: string): string {
  const word = count === 1 ? noun : (pluralNoun ?? `${noun}s`)
  return `${String(count)} ${word}`
}
