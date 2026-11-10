import { describe, expect, it } from 'vitest';
import { preserveUnchangedText } from './formValues';

describe('historical identity preservation', () => {
  it('preserves multi-container identifiers, casing, whitespace, and line endings unchanged', () => {
    const source = '  mscu1234567 / TCLU7654321\r\n';
    expect(preserveUnchangedText(source, source, value => value.trim().toUpperCase())).toBe(source);
    const reference = '  HBL/001 · HBL/002\t';
    expect(preserveUnchangedText(reference, reference)).toBe(reference);
  });
  it('preserves an existing source when a field is not present in the form result', () => {
    expect(preserveUnchangedText(undefined, ' historical value ')).toBe(' historical value ');
  });
  it('normalizes only explicitly changed or newly created values', () => {
    expect(preserveUnchangedText('  mscu1234567 ', undefined, value => value.trim().toUpperCase())).toBe('MSCU1234567');
    expect(preserveUnchangedText(' new-reference ', ' old-reference ')).toBe('new-reference');
    expect(preserveUnchangedText('', ' historical value ')).toBe('');
  });
});
