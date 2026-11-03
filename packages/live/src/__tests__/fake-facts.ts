/**
 * What the combined facts script answers for a batch, for fake clients: one row per
 * entry carrying no facts. The read fails on an entry it does not answer, so a fake that
 * returns nothing for this script would fail every refresh.
 */
export function factsScriptOutput(code: unknown): string | null {
  const text = String(code ?? '');
  if (!text.includes('getCCodeMarkup')) return null;
  const items = text.match(/for \(String a : "([^"]*)"\.split/);
  if (!items) return null;
  return items[1].split(';').filter(Boolean).map(a => `F\t${a}\tself\t-\t0\t0\nD\t\n`).join('');
}
