// pdf-parse v2 ships a named class API (PDFParse) with getText(); the v1 default-function API
// (`import pdfParse from 'pdf-parse'`) does not exist in v2. npm resolves ^1.1.1 to v2 today.

import fs from 'fs';
import { logger } from '../logger.js';
import { PDFParse } from 'pdf-parse';

export interface PdfEnrichOutcome {
  ok: boolean;
  text?: string;
  numPages?: number;
  error?: string;
  errorCode?: string;
}

const MAX_PAGES_TO_PARSE = 10;  // bounds worst-case work on very large PDFs
const MAX_TEXT_CHARS = 10000;

export async function enrichPdf(pdfPath: string): Promise<PdfEnrichOutcome> {
  if (!fs.existsSync(pdfPath)) {
    return { ok: false, error: `file not found: ${pdfPath}`, errorCode: 'file_missing' };
  }

  let parser: PDFParse | undefined;
  try {
    const buf = fs.readFileSync(pdfPath);
    parser = new PDFParse({ data: buf });
    const result = await parser.getText({ first: MAX_PAGES_TO_PARSE });
    return {
      ok: true,
      text: (result.text ?? '').slice(0, MAX_TEXT_CHARS),
      numPages: result.total,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, pdfPath }, 'Processor: pdf enrichment failed');
    if (/encrypted|password/i.test(msg)) {
      return { ok: false, error: 'PDF is encrypted or password-protected', errorCode: 'pdf_encrypted' };
    }
    return { ok: false, error: msg, errorCode: 'pdf_parse_error' };
  } finally {
    if (parser) await parser.destroy().catch(() => {});  // never throws; free pdfjs doc
  }
}
