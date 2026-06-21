import katex from "katex";

// Renders text that may contain LaTeX math. Handles $…$, $$…$$, \(…\), \[…\],
// and bare LaTeX (e.g. \boxed{\frac{2}{3}}) with no delimiters. Failures fall
// back to the raw text rather than throwing.

function renderTeX(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode, output: "html" });
  } catch {
    return escapeHtml(tex);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

const SPLIT_RE = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$\n]+?\$|\\\([\s\S]*?\\\))/g;
const HAS_DELIM = /\$|\\\(|\\\[/;
const LOOKS_LATEX = /\\(frac|boxed|sqrt|cdot|times|div|sum|int|binom|begin|approx|le|ge|ne|pi|theta)/;

export default function MathText({ text, className }: { text: string; className?: string }) {
  if (!text) return null;

  // whole string is bare LaTeX (common in <answer>, e.g. \boxed{\frac{2}{3}})
  if (!HAS_DELIM.test(text) && LOOKS_LATEX.test(text)) {
    return <span className={className} dangerouslySetInnerHTML={{ __html: renderTeX(text, false) }} />;
  }

  const parts = text.split(SPLIT_RE);
  return (
    <span className={className}>
      {parts.map((p, i) => {
        if (!p) return null;
        let tex: string | null = null;
        let display = false;
        if (p.startsWith("$$") && p.endsWith("$$")) {
          tex = p.slice(2, -2);
          display = true;
        } else if (p.startsWith("\\[") && p.endsWith("\\]")) {
          tex = p.slice(2, -2);
          display = true;
        } else if (p.startsWith("\\(") && p.endsWith("\\)")) {
          tex = p.slice(2, -2);
        } else if (p.startsWith("$") && p.endsWith("$") && p.length > 2) {
          tex = p.slice(1, -1);
        }
        if (tex !== null) {
          return <span key={i} dangerouslySetInnerHTML={{ __html: renderTeX(tex, display) }} />;
        }
        return <span key={i}>{p}</span>;
      })}
    </span>
  );
}
