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

export async function enrichPdf(pdfPath: string): Promise<PdfEnrichOutcome> {
  if (!fs.existsSync(pdfPath)) {
    return { ok: false, error: `file not found: ${pdfPath}`, errorCode: 'file_missing' };
  }
  try {
    const buf = fs.readFileSync(pdfPath);
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const result = await parser.getText();
    const numPages = result.total;
    const text = (result.text ?? '').slice(0, 10000);
    await parser.destroy();
    return { ok: true, text, numPages };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, pdfPath }, 'Processor: pdf enrichment failed');
    if (/encrypted|password/i.test(msg)) {
      return { ok: false, error: 'PDF is encrypted or password-protected', errorCode: 'pdf_encrypted' };
    }
    return { ok: false, error: msg, errorCode: 'pdf_parse_error' };
  }
}
