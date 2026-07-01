// Document attachment + RAG — fully client-side, fully local.
//
// Flow (mirrors jacoblee93/fully-local-pdf-chatbot, minus the WASM vector store):
//   file -> extract text -> chunk -> keyword-retrieve top chunks per query.
// Retrieval is TF keyword overlap (no embedding model needed, works offline). The
// contract is identical to a vector store, so an embedder can drop in later.
//
// PDF is parsed with pdfjs-dist (browser, no server). Text/markdown/code/csv are
// read directly.

import { rankByKeyword } from "./search";

export interface DocChunk {
  docId: string;
  docName: string;
  index: number;
  text: string;
}

export interface AttachedDoc {
  id: string;
  name: string;
  chars: number;
  chunks: DocChunk[];
}

// ~900-char chunks with 150-char overlap, split on paragraph/sentence boundaries.
export function chunkText(text: string, size = 900, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length);
    if (end < clean.length) {
      // prefer to break on a paragraph, then sentence, then space
      const slice = clean.slice(i, end);
      const br = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(". "));
      if (br > size * 0.5) end = i + br + 1;
    }
    const piece = clean.slice(i, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    i = end - overlap;
  }
  return chunks;
}

async function extractPdf(file: File): Promise<string> {
  // dynamic import so pdfjs only loads when a PDF is attached
  const pdfjs = await import("pdfjs-dist");
  // worker via Vite ?url import
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  let text = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n\n";
  }
  return text;
}

export async function ingestFile(file: File): Promise<AttachedDoc> {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  const raw = isPdf ? await extractPdf(file) : await file.text();
  const id = "doc_" + Date.now().toString(36);
  const chunks = chunkText(raw).map((text, index) => ({ docId: id, docName: file.name, index, text }));
  return { id, name: file.name, chars: raw.length, chunks };
}

// Retrieve the most relevant chunks across all attached docs for a query.
export function retrieveChunks(query: string, docs: AttachedDoc[], k = 4): DocChunk[] {
  const all = docs.flatMap((d) => d.chunks);
  return rankByKeyword(query, all, (c) => c.text, k).map((s) => s.item);
}

// Render retrieved chunks as a grounding block for the prompt.
export function chunksToContext(chunks: DocChunk[]): string {
  if (!chunks.length) return "";
  return chunks.map((c) => `- [${c.docName} #${c.index}] ${c.text.replace(/\s+/g, " ").slice(0, 500)}`).join("\n");
}
