/** Do not normalize historical source text while saving an unrelated field. */
export function preserveUnchangedText(value: string | undefined, previous: string | undefined, normalize: (value: string) => string = value => value.trim()): string {
  if (previous !== undefined && (value === undefined || value === previous)) return previous;
  return normalize(value ?? '');
}
