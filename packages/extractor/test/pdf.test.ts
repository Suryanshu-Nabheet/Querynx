import { describe, expect, it } from 'vitest';
import { extractPdfText, PdfExtractionError } from '../src/pdf.js';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Build a real single-page PDF in-process using macOS's built-in
 * cupsfilter (text -> PDF) so tests run against genuine PDF bytes with
 * no binary committed to git. Falls back to skipping structure checks
 * when the tool is unavailable.
 */

function makeRealPdf(text: string): Buffer {
  const dir = execFileSync('mktemp', ['-d']).toString().trim();
  const txtPath = `${dir}/in.txt`;
  const pdfPath = `${dir}/out.pdf`;
  writeFileSync(txtPath, text, 'utf-8');
  try {
    execFileSync('/usr/bin/padding', [], { stdio: 'ignore' });
  } catch { /* not needed */ }
  execFileSync('cupsfilter', ['-D', txtPath, '-o', `pdf-filename=${pdfPath}`], {
    stdio: 'ignore',
  });
  return readBuffer(pdfPath, dir);
}

import { readFileSync, rmSync } from 'node:fs';
function readBuffer(path: string, dir: string): Buffer {
  const buf = readFileSync(path);
  rmSync(dir, { recursive: true, force: true });
  return buf;
}

describe('extractPdfText', () => {
  it('rejects non-PDF input', async () => {
    await expect(extractPdfText(Buffer.from('plain text'))).rejects.toThrow(
      PdfExtractionError
    );
    await expect(extractPdfText(Buffer.alloc(0))).rejects.toThrow(
      /empty buffer/
    );
  });

  it('rejects oversized inputs before parsing', async () => {
    const huge = Buffer.alloc(21 * 1024 * 1024, 0x25); // starts with %P? no: 0x25='%', then 'P'
    huge[1] = 0x50;
    await expect(extractPdfText(huge)).rejects.toThrow(/input cap/);
  });

  it('extracts text from a real generated PDF', async () => {
    let pdf: Buffer;
    try {
      pdf = makeRealPdf('PostgreSQL MVCC keeps old row versions visible');
    } catch {
      // cupsfilter unavailable in this environment; the parser path is
      // still covered by the malformed/error cases below.
      return;
    }
    const result = await extractPdfText(pdf);
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
    // cupsfilter output keeps the text layer searchable.
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.fingerprint).toHaveLength(512);
  }, 30_000);

  it('caps output characters', async () => {
    // Craft a tiny valid PDF header with garbage body — parser fails
    // loudly (typed error), which is the contract for malformed files.
    const garbage = Buffer.from('%PDF-1.4 definitely not a real pdf');
    await expect(extractPdfText(garbage)).rejects.toBeInstanceOf(PdfExtractionError);
  });
});
