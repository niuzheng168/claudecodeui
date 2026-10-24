/**
 * The search filter of chat's model and directory pickers.
 *
 * cmdk's default filter is fuzzy (loose character-subsequence scoring), which
 * surfaces unrelated entries — e.g. searching "chatgpt" also matched "Fable".
 * Require every whitespace-separated search token to appear as a literal
 * substring instead, so "claude 4.5" still matches "Anthropic Claude Haiku 4.5"
 * but "chatgpt" only matches models that actually contain it.
 */
export function tokenSearchFilter(value: string, search: string): number {
  const haystack = value.toLowerCase();
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token)) ? 1 : 0;
}
