import { describe, expect, it } from 'vitest';
import {
  formatSummaryProse,
  simplifySummaryProse,
} from '../../src/pipeline/pass3-synthesis.js';

const SAMPLE =
  'Fixes development-expenditure spreadsheet validation and re-upload handling so generated error workbooks can be validated from their data sheet, blank/whitespace rows are safely normalized, and Excel numeric codes with a trailing .0 match valid options. It also improves user-facing processing error feedback and updates pending-job copy. This group only changes the wording and formatting of the pending job log emitted before database persistence in VOT reuploads and national stores. It does not alter validation, upload, database, or control-flow behavior. This change makes error-workbook reuploads select the named data sheet and normalizes whitespace-only rows before validation. It also normalizes integral Excel float codes and improves frontend rendering of task-level error payloads.';

function sentenceWordCounts(text: string): number[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => sentence.split(/\s+/).length);
}

describe('simplifySummaryProse', () => {
  it('splits the long sample sentence at a safe clause boundary', () => {
    const result = simplifySummaryProse(SAMPLE);

    expect(result).toContain('data sheet, blank/whitespace rows are safely normalized. Excel numeric codes');
  });

  it('removes repeated sentences without changing distinct facts', () => {
    const result = simplifySummaryProse(
      'The tool normalizes blank rows. The tool normalizes blank rows. It keeps the rest.',
    );

    expect(result).toBe('The tool normalizes blank rows. It keeps the rest.');
  });

  it('keeps distinct qualifiers in shared-prefix sentences', () => {
    const result = simplifySummaryProse(
      'The client retries failed requests. The client retries failed requests after a timeout.',
    );

    expect(result).toBe(
      'The client retries failed requests. The client retries failed requests after a timeout.',
    );
  });

  it('protects URLs and inline code from prose substitutions', () => {
    const result = simplifySummaryProse(
      'Use utilize in https://host/utilize and `utilize` prior to upload.',
    );

    expect(result).toBe('Use use in https://host/utilize and `utilize` before upload.');
  });

  it('puts multiple summary sentences on separate Markdown lines', () => {
    const result = formatSummaryProse('The tool validates the file. The tool reports errors.');

    expect(result).toBe('- The tool validates the file.\n- The tool reports errors.');
  });

  it('uses plain words and removes empty note openers', () => {
    const result = simplifySummaryProse(
      'In order to utilize the API, the batch stops prior to the upload. It is important to note that this is safe.',
    );

    expect(result).toBe('To use the API, the batch stops before the upload. This is safe.');
  });

  it('keeps markdown list items intact', () => {
    const result = simplifySummaryProse('- Fixes the upload path.\n- Keeps the database state safe.');

    expect(result).toBe('- Fixes the upload path.\n- Keeps the database state safe.');
  });
});
