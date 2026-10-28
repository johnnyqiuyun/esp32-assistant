/**
 * The mod's own text, one JSON file per language under `locales/`: the
 * person's tag, then its language, then English. A missing file or key falls
 * through; a key no table has reads as itself. Never throws.
 *
 * Adapted from the Nebius mod (nebius@velloc 1.2.1, hooks/sandbox/texts.js, MIT).
 */

export function candidateTags(locale) {
  const tag = typeof locale === 'string' && locale.trim() !== '' ? locale.trim() : 'en'
  const language = tag.split('-')[0]
  return [...new Set([tag, language, 'en'])]
}

/** `{name}` placeholders filled from `vars`. */
export function fill(text, vars) {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole))
}

/** A translator over the tables already read, first match wins. */
export function translator(tables) {
  return (key, vars) => {
    for (const table of tables) {
      if (table && typeof table[key] === 'string') return fill(table[key], vars)
    }
    return key
  }
}

/** Reads the tables for `locale` (default `$.plugin.locale`) and answers a synchronous translator. */
export async function loadTexts($, locale = $.plugin.locale) {
  const read = async tag => {
    try {
      return JSON.parse(await $.fs.read(`${$.plugin.root}/locales/${tag}.json`))
    } catch {
      return undefined
    }
  }
  const tables = await Promise.all(candidateTags(locale).map(read))
  return translator(tables)
}
