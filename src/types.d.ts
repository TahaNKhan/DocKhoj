declare module 'pdf-parse' {
  interface PDFData {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    text: string;
    version: string;
  }
  function pdfParse(data: Buffer): Promise<PDFData>;
  export = pdfParse;
}

declare module 'mammoth' {
  export function extractRawText(options: { path: string }): Promise<{ value: string }>;
}
