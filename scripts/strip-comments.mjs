import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

// resolve o typescript do próprio projeto (funciona no repo, não só nesta máquina)
const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

function detectEol(text) {
  const m = text.match(/\r\n|\n|\r/);
  return m ? m[0] : '\n';
}

// devolve as linhas (sem terminador) e se o arquivo termina com quebra
function splitLines(text) {
  const eol = detectEol(text);
  const raw = text.split(eol);
  const trailing = raw.length > 1 && raw[raw.length - 1] === '';
  if (trailing) raw.pop();
  return { lines: raw, eol, trailing };
}

function offsets(lines, eol) {
  const res = [];
  let pos = 0;
  for (const l of lines) {
    res.push({ start: pos, end: pos + l.length });
    pos += l.length + eol.length;
  }
  return res;
}

function lineIndexAt(spans, offset) {
  let lo = 0;
  let hi = spans.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid].start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------- extração de comentários e strings ----------

function tsScan(text, fileName) {
  const kind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.js')
      ? ts.ScriptKind.JS
      : fileName.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const strings = [];
  const seen = new Set();
  const comments = [];

  const add = (ranges, keyOf) => {
    if (!ranges) return;
    for (const r of ranges) {
      const key = keyOf(r);
      if (seen.has(key)) continue;
      seen.add(key);
      comments.push([r.pos, r.end]);
    }
  };

  const LITERALS = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
    ts.SyntaxKind.RegularExpressionLiteral,
  ]);

  const walk = (node) => {
    const start = node.kind === ts.SyntaxKind.SourceFile ? 0 : node.pos;
    add(ts.getLeadingCommentRanges(text, start), (r) => 'L' + r.pos);
    add(ts.getTrailingCommentRanges(text, node.getEnd()), (r) => 'T' + r.pos);
    if (LITERALS.has(node.kind) && node.getStart(sf) !== node.getEnd()) {
      strings.push([node.getStart(sf), node.getEnd()]);
    }
    for (const k of node.getChildren(sf)) walk(k);
  };
  walk(sf);

  // dentro de template (CSS/script injetado) o parser não vê comentário
  for (const c of templateComments(text, fileName, strings)) {
    if (!seen.has('X' + c[0])) {
      seen.add('X' + c[0]);
      comments.push(c);
    }
  }

  return { comments, strings, errors: sf.parseDiagnostics ? sf.parseDiagnostics.length : 0 };
}

// comentários dentro de literal de template (CSS/JS injetado), só os que
// começam a linha — no meio do código são raros e não valem o risco.
function templateComments(text, fileName, ranges) {
  const found = [];
  for (const [s, e] of ranges) {
    const lit = text.slice(s, e);
    // TemplateHead começa com '`'; TemplateMiddle/Tail com '}'.
    if (!lit.startsWith('`') && !lit.startsWith('}')) continue;
    const re = /(^|\n)([ \t]*)(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;
    let m;
    while ((m = re.exec(lit))) {
      const start = s + m.index + m[1].length + m[2].length;
      found.push([start, start + m[3].length]);
    }
  }
  return found;
}

function lexC(text, { nestedBlocks, rawStrings, rust }) {
  const comments = [];
  const strings = [];
  const n = text.length;
  let i = 0;

  const readQuoted = (start, quote, multiline = false) => {
    let j = start + quote.length;
    while (j < n) {
      if (text[j] === '\\') {
        j += 2;
        continue;
      }
      if (text.startsWith(quote, j)) return j + quote.length;
      // Rust aceita string com quebra de linha (DDL SQL, por exemplo).
      if (!multiline && text[j] === '\n') return j;
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    if (c === '/' && c2 === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      comments.push([i, j]);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (nestedBlocks && text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      comments.push([i, j]);
      i = j;
      continue;
    }

    if (rust) {
      let k = i;
      if (text[k] === 'b' || text[k] === 'c') k++;
      if (text[k] === 'r') {
        let j = k + 1;
        let hashes = 0;
        while (text[j] === '#') {
          hashes++;
          j++;
        }
        if (text[j] === '"') {
          const close = '"' + '#'.repeat(hashes);
          const end = text.indexOf(close, j + 1);
          const stop = end < 0 ? n : end + close.length;
          strings.push([i, stop]);
          i = stop;
          continue;
        }
      }
      if ((c === 'b' || c === 'c') && text[i + 1] === '"') {
        const stop = readQuoted(i + 1, '"', true);
        strings.push([i, stop]);
        i = stop;
        continue;
      }
      if (c === "'") {
        let j = i + 1;
        if (text[j] === '\\') j += 2;
        else j += 1;
        if (text[j] === "'") {
          strings.push([i, j + 1]);
          i = j + 1;
          continue;
        }
        i++;
        continue;
      }
      if (c === '"') {
        const stop = readQuoted(i, '"', true);
        strings.push([i, stop]);
        i = stop;
        continue;
      }
    }

    if (rawStrings && text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      const stop = end < 0 ? n : end + 3;
      strings.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const stop = readQuoted(i, c);
      strings.push([i, stop]);
      i = stop;
      continue;
    }
    i++;
  }
  return { comments, strings, errors: 0 };
}

function scan(text, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return tsScan(text, fileName);
  if (ext === '.rs') return lexC(text, { nestedBlocks: true, rawStrings: false, rust: true });
  if (ext === '.kt') return lexC(text, { nestedBlocks: true, rawStrings: true, rust: false });
  if (ext === '.css') return lexC(text, { nestedBlocks: false, rawStrings: false, rust: false });
  return null;
}

// ---------- remoção ----------

// instruções para ferramenta (lint/tipos/bundler) e avisos de segurança:
// removê-las muda o build ou apaga a justificativa de um `unsafe`.
const KEEP =
  /eslint-disable|eslint-enable|eslint-env|@ts-ignore|@ts-expect-error|@ts-nocheck|prettier-ignore|biome-ignore|istanbul ignore|c8 ignore|oxlint-disable|deno-lint-ignore|@vite-ignore|webpackIgnore|sourceMappingURL|<reference\s|SAFETY:|allow\(dead_code\)/;

// Política: documentação de API (`///`, `//!`) fica. Sai o que denuncia código
// gerado: banner de separador, bloco `/** */` de 3+ linhas (prosa/história) e
// sequência de 2+ `//` (parágrafo). Comentário `//` isolado e curto fica.
const BANNER = /^(?:\/\/|\/\*|\*)[\s\-=*#─━_~]{3,}$/;
const MAX_COMMENT = 140;

function removableComments(text, spans, sorted) {
  const lineOf = (pos) => lineIndexAt(spans, pos);
  const isWholeLine = ([cs, ce]) => {
    const sp = spans[lineOf(cs)];
    return text.slice(sp.start, cs).trim() === '' && text.slice(ce, sp.end).trim() === '';
  };
  const drop = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && lineOf(sorted[j + 1][0]) <= lineOf(sorted[j][1]) + 1) j++;
    const run = sorted.slice(i, j + 1);
    i = j + 1;
    if (run.some(([cs, ce]) => KEEP.test(text.slice(cs, ce)))) continue;
    const body = run.map(([cs, ce]) => text.slice(cs, ce)).join(' ');
    if (/^\s*\/\/[/!]/.test(body)) continue;
    const compact = body.replace(/\s+/g, ' ').trim();
    const whole = run.every(isWholeLine);
    const docBlock = /^\s*\/\*\*/.test(compact);
    if (BANNER.test(compact)) {
      drop.push(...run);
      continue;
    }
    if (!whole) continue;
    if (docBlock && run.length >= 3) {
      drop.push(...run);
      continue;
    }
    if (!docBlock && (run.length >= 2 || compact.length > MAX_COMMENT)) drop.push(...run);
  }
  return drop;
}

function stripComments(text, scanRes) {
  const { lines, eol, trailing } = splitLines(text);
  const spans = offsets(lines, eol);
  const sorted = removableComments(text, spans, scanRes.comments.slice().sort((a, b) => a[0] - b[0]));

  const out = [];
  let ci = 0;
  let removed = 0;
  let removedLines = 0;

  for (let li = 0; li < lines.length; li++) {
    const span = spans[li];
    while (ci < sorted.length && sorted[ci][1] <= span.start) ci++;
    const overlaps = [];
    for (let idx = ci; idx < sorted.length && sorted[idx][0] < span.end; idx++) overlaps.push(sorted[idx]);

    if (overlaps.length === 0) {
      out.push({ text: lines[li], oi: li });
      continue;
    }
    if (overlaps.some(([cs, ce]) => KEEP.test(text.slice(cs, ce)))) {
      out.push({ text: lines[li], oi: li });
      continue;
    }

    let cursor = span.start;
    let rest = '';
    let hadCode = false;
    for (const [cs, ce] of overlaps) {
      if (cs > cursor) {
        const chunk = text.slice(cursor, Math.min(cs, span.end));
        rest += chunk;
        if (chunk.trim()) hadCode = true;
      }
      cursor = Math.max(cursor, ce);
    }
    if (cursor < span.end) {
      const chunk = text.slice(cursor, span.end);
      rest += chunk;
      if (chunk.trim()) hadCode = true;
    }
    removed++;
    if (!hadCode) {
      removedLines++;
      continue;
    }
    out.push({ text: rest.replace(/[ \t]+$/, ''), oi: li });
  }

  return { lines: tidy(out, spans, scanRes.strings), eol, trailing, removed, removedLines };
}

// colapsa brancos que sobraram da remoção, sem tocar em brancos dentro de strings
function tidy(out, spans, stringRanges) {
  const protect = new Set();
  for (const [s, e] of stringRanges) {
    const a = lineIndexAt(spans, s);
    const b = lineIndexAt(spans, Math.max(s, e - 1));
    for (let i = a; i <= b; i++) protect.add(i);
  }
  const res = [];
  for (const cur of out) {
    if (!cur.text.trim() && !protect.has(cur.oi)) {
      if (!res.length) continue;
      if (!res[res.length - 1].text.trim()) continue;
    }
    res.push(cur);
  }
  while (res.length && !res[res.length - 1].text.trim()) res.pop();
  return res.map((l) => l.text);
}

// ---------- main ----------

const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((f) => ['.ts', '.tsx', '.js', '.rs', '.kt', '.css'].includes(path.extname(f).toLowerCase()));

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const only = args.filter((a) => !a.startsWith('--'));
const targets = only.length ? files.filter((f) => only.some((o) => f.includes(o))) : files;

const report = [];
for (const rel of targets) {
  const abs = path.join(ROOT, rel);
  const original = fs.readFileSync(abs, 'utf8');
  const bom = original.charCodeAt(0) === 0xfeff;
  const text = bom ? original.slice(1) : original;

  const scanRes = scan(text, rel);
  if (!scanRes) continue;
  if (scanRes.errors > 0) {
    report.push({ rel, error: `parse diagnostics: ${scanRes.errors}` });
    continue;
  }
  const stripped = stripComments(text, scanRes);
  let finalText = stripped.lines.join(stripped.eol);
  if (stripped.trailing && !finalText.endsWith(stripped.eol)) finalText += stripped.eol;
  if (!stripped.trailing && finalText.endsWith(stripped.eol)) finalText = finalText.slice(0, -stripped.eol.length);
  if (bom) finalText = '\uFEFF' + finalText;

  if (finalText === original) {
    report.push({ rel, changed: false });
    continue;
  }
  if (WRITE) fs.writeFileSync(abs, finalText, 'utf8');
  report.push({ rel, changed: true, removed: stripped.removed, lines: stripped.removedLines });
}

for (const r of report) {
  if (r.error) console.log(`ERROR ${r.rel}: ${r.error}`);
  else if (r.changed) console.log(`${r.rel}: ${r.lines} linhas removidas`);
}
const changed = report.filter((r) => r.changed).length;
console.log(`\n${changed}/${report.length} arquivos ${WRITE ? 'gravados' : 'seriam alterados'}`);
