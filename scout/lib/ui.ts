// ui.ts — scout terminal identity, matched to Thoth's Rust output
// ("Feather Spine" + "Ink & Gold"). Mirror of src/brand.rs so the JS/TS scout
// layer and the Rust pipeline read as one family.
//
// Color is gated on an interactive stderr (no NO_COLOR, TERM != dumb): piped
// output degrades to clean plain text — only ANSI is stripped, glyphs stay.

const COLOR = !!process.stderr.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const C = {
  gold: '\x1b[38;5;179m', // brand + success
  violet: '\x1b[38;5;141m', // accent / spine
  cyan: '\x1b[36m', // info
  amber: '\x1b[33m', // warn
  red: '\x1b[31m', // error
  dim: '\x1b[90m', // chrome
  reset: '\x1b[0m',
};

const paint = (code: string, s: string): string => (COLOR ? `${code}${s}${C.reset}` : s);

// Glyphs (always emitted; UTF-8 safe when piped)
const FEATHER = '🪶';
const SPINE = '▏';
const BLOCK = '█';
const OK = '✓';
const WARN = '⚠';
const ERR = '✗';
const DOT = '·';

/** Head banner → stderr, interactive-only. Ties scout to Thoth (same 🪶). */
function banner(): void {
  if (!COLOR) return;
  process.stderr.write('\n');
  process.stderr.write(`  ${paint(C.gold, FEATHER)}  ${paint(C.gold, 'T H O T H')}  ${paint(C.dim, `${DOT} scout`)}\n`);
  process.stderr.write(`  ${paint(C.violet, SPINE)} ${paint(C.dim, 'content sourcing untuk Thoth')}\n`);
  process.stderr.write(`  ${paint(C.violet, SPINE)}\n`);
}

/** Heavy block stage header → stderr:  █ label */
function stage(label: string): void {
  process.stderr.write(`\n  ${paint(C.gold, BLOCK)} ${paint(C.violet, label)}\n`);
}

/** Stage completion → stderr:  ▏ ✓ label · 1.2s */
function done(label: string, secs: number): void {
  process.stderr.write(
    `  ${paint(C.violet, SPINE)} ${paint(C.gold, OK)} ${label} ${paint(C.dim, DOT)} ${paint(C.gold, `${secs.toFixed(1)}s`)}\n`,
  );
}

/** A section rule as a string (drop-in for the old `'='.repeat(60)` pattern). */
function rule(kind: 'heavy' | 'thin' = 'heavy'): string {
  const line = (kind === 'thin' ? '╌' : '─').repeat(52);
  return paint(kind === 'thin' ? C.dim : C.violet, line);
}

export const ui = {
  banner,
  stage,
  done,
  rule,
  gold: (s: string) => paint(C.gold, s),
  violet: (s: string) => paint(C.violet, s),
  cyan: (s: string) => paint(C.cyan, s),
  amber: (s: string) => paint(C.amber, s),
  red: (s: string) => paint(C.red, s),
  dim: (s: string) => paint(C.dim, s),
  FEATHER,
  SPINE,
  BLOCK,
  OK,
  WARN,
  ERR,
  DOT,
};
