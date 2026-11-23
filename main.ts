// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 5 helpers: a file's lines, its line break and whether it ends with one. */
interface FileText {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function normLine(l: string, tier: number): string {
  if (tier === 0) return l;
  if (tier === 1) return l.replace(/[ \t]+$/, '');
  return l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in the file's lines at a tier. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(file[i + k]!, tier) !== on[k]!) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..maxTier) at which O occurs at least once, with its positions. */
function findTier(file: string[], o: string[], maxTier: number): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

const leadWs = (l: string): string => {
  const m = /^[ \t]*/.exec(l);
  return m ? m[0] : '';
};

/** One line of N: its text, and its index into O when it is a context line. */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * Build the lines N writes: a context line is the file's own matched line,
 * every other line is re-indented at tier 2 and written as it is otherwise.
 */
function buildN(n: NLine[], file: string[], at: number, oFirst: string, tier: number): string[] {
  const fLead = leadWs(file[at] ?? '');
  const pLead = leadWs(oFirst);
  return n.map((nl) => {
    if (nl.ctx !== null) return file[at + nl.ctx]!;
    const t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(pLead)) return fLead + t.slice(pLead.length);
    return t;
  });
}

/** A file moved by a move edit that succeeded; run() turns the pair into an R line. */
const moves: Array<{ old: string; new: string }> = [];

/** Section 6: one hunk of a unified diff. */
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  noNL: boolean;
  /** a `\` line follows the hunk's last `+` line (false when it has none) */
  lastPlusNoNL: boolean;
}

interface Section {
  hdrOld: string | null;
  hdrNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed, a/ or b/ removed, /dev/null is no file. */
function diffPath(raw: string): string | null {
  const cut = raw.split('\t')[0]!.trim();
  if (cut === '/dev/null') return null;
  if (cut.startsWith('a/') || cut.startsWith('b/')) return cut.slice(2);
  return cut;
}

/** Parse one hunk body starting at the header line lines[i]; returns the hunk and the next index. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  type Entry = { kind: 'ctx' | 'old' | 'new' | 'mark'; text: string; empty: boolean };
  const entries: Entry[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    // The body ends at a `--- ` line followed by a `+++ ` line (a new section),
    // even though both start with body characters.
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1]!.startsWith('+++ ')) break;
    if (l === '') { entries.push({ kind: 'ctx', text: '', empty: true }); j++; continue; }
    const c = l[0]!;
    if (c === ' ') { entries.push({ kind: 'ctx', text: l.slice(1), empty: false }); j++; continue; }
    if (c === '-') { entries.push({ kind: 'old', text: l.slice(1), empty: false }); j++; continue; }
    if (c === '+') { entries.push({ kind: 'new', text: l.slice(1), empty: false }); j++; continue; }
    if (c === '\\') { entries.push({ kind: 'mark', text: '', empty: false }); j++; continue; }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (entries.length > 0) {
    const last = entries[entries.length - 1]!;
    if (last.kind === 'ctx' && last.empty) entries.pop();
    else break;
  }
  const followsMark = (idx: number): boolean => idx + 1 < entries.length && entries[idx + 1]!.kind === 'mark';
  let noNL = false;
  let lastPlusNoNL = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k]!.kind === 'ctx' || entries[k]!.kind === 'new') { noNL = followsMark(k); break; }
  }
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k]!.kind === 'new') { lastPlusNoNL = followsMark(k); break; }
  }
  const o: string[] = [];
  const n: NLine[] = [];
  for (const e of entries) {
    if (e.kind === 'ctx') { o.push(e.text); n.push({ text: e.text, ctx: o.length - 1 }); }
    else if (e.kind === 'old') o.push(e.text);
    else if (e.kind === 'new') n.push({ text: e.text, ctx: null });
  }
  return { hunk: { a, o, n, noNL, lastPlusNoNL }, next: j };
}

/** Apply a section's hunks in order to a file's text; the hunk's path names any failure. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      const atEnd = pos >= f.lines.length;
      if (atEnd) pos = f.lines.length;
      const ins = h.n.map((nl) => nl.text);
      f.lines.splice(pos, 0, ...ins);
      if (atEnd) f.final = !h.noNL;
      d += h.n.length;
      continue;
    }
    const found = findTier(f.lines, h.o, strict ? 0 : 2);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const at = best;
    const newLines = buildN(h.n, f.lines, at, h.o[0]!, found.tier);
    const touchesEnd = at + h.o.length === f.lines.length;
    f.lines.splice(at, h.o.length, ...newLines);
    if (touchesEnd) f.final = !h.noNL;
    d += h.n.length - h.o.length;
  }
  return joinFile(f);
}

/** One unified section is one edit. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.hdrOld ?? sec.renameFrom ?? sec.diffOld;
  const newP = sec.hdrNew ?? sec.renameTo ?? sec.diffNew;
  if (oldP === null || sec.newFile) {
    return (tree) => {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noNL = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const nl of h.n) if (nl.ctx === null) { plus.push(nl.text); hasPlus = true; }
        if (hasPlus) noNL = h.lastPlusNoNL;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
    };
  }
  if (newP === null || sec.deletedFile) {
    return (tree) => {
      if (oldP === null) return;
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldP !== newP) {
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(cur, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      moves.push({ old: oldP, new: newP });
    };
  }
  return (tree) => {
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(cur, sec.hunks, strict, oldP));
  };
}

/** Read a unified diff patch into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHunks = false;
  const blankSection = (): Section => ({
    hdrOld: null, hdrNew: null, renameFrom: null, renameTo: null,
    diffOld: null, diffNew: null, newFile: false, deletedFile: false, hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      sections.push(s);
      cur = s;
      inHunks = false;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      inHunks = true;
      i = r.next;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      if (cur === null) {
        const s = blankSection();
        s.hdrOld = diffPath(l.slice(4));
        s.hdrNew = diffPath(lines[i + 1]!.slice(4));
        sections.push(s);
        cur = s;
        inHunks = false;
        i += 2;
        continue;
      }
      if (!inHunks && cur.hdrOld === null && cur.hdrNew === null) {
        cur.hdrOld = diffPath(l.slice(4));
        cur.hdrNew = diffPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      // A further pair starts a new section; reprocess this line with no section open.
      cur = null;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && !inHunks) throw new Exit2(`error: parse ${i + 2}`);
    if (cur !== null && !inHunks && l.startsWith('+++ ')) { cur.hdrNew = diffPath(l.slice(4)); i++; continue; }
    if (cur !== null && !inHunks && l.startsWith('rename from ')) { cur.renameFrom = l.slice('rename from '.length).trim(); i++; continue; }
    if (cur !== null && !inHunks && l.startsWith('rename to ')) { cur.renameTo = l.slice('rename to '.length).trim(); i++; continue; }
    if (cur !== null && !inHunks && l.startsWith('new file mode')) { cur.newFile = true; i++; continue; }
    if (cur !== null && !inHunks && l.startsWith('deleted file mode')) { cur.deletedFile = true; i++; continue; }
    i++;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** Section 7: one SEARCH/REPLACE block is one edit. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(f.lines, oldLines, strict ? 0 : 2);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const outs = buildN(newLines.map((t) => ({ text: t, ctx: null })), f.lines, at, oldLines[0]!, found.tier);
    f.lines.splice(at, oldLines.length, ...outs);
    tree.now.set(path, joinFile(f));
  };
}

/** Read SEARCH/REPLACE blocks into edits. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** Section 8: one chunk of a V4A Update File section. */
interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  lineNo: number;
}

/** Apply one V4A Update File section's chunks to a file's text. */
function applyVChunks(text: string, chunks: VChunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let cursor = 0;
  const maxTier = strict ? 0 : 2;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundAt = -1;
      for (let t = 0; t <= maxTier && foundAt < 0; t++) {
        for (let k = cursor; k < f.lines.length; k++) {
          if (normLine(f.lines[k]!, t) === normLine(ch.anchor, t)) { foundAt = k; break; }
        }
      }
      if (foundAt < 0) throw new Fail('no-match', path);
      cursor = foundAt + 1;
    }
    if (ch.o.length === 0) {
      const pos = ch.eof ? f.lines.length : cursor;
      const ins = ch.n.map((nl) => nl.text);
      f.lines.splice(pos, 0, ...ins);
      cursor = pos + ins.length;
      continue;
    }
    let hit: { tier: number; at: number } | null = null;
    for (let t = 0; t <= maxTier; t++) {
      const occ = occurrences(f.lines, ch.o, t).filter((p) => p >= cursor && (!ch.eof || p + ch.o.length === f.lines.length));
      if (occ.length > 0) { hit = { tier: t, at: occ[0]! }; break; }
    }
    if (!hit) throw new Fail('no-match', path);
    const outs = buildN(ch.n, f.lines, hit.at, ch.o[0]!, hit.tier);
    f.lines.splice(hit.at, ch.o.length, ...outs);
    cursor = hit.at + outs.length;
  }
  return joinFile(f);
}

/** One V4A section is one edit. */
function vSectionEdit(sec: VSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const out = applyVChunks(cur, sec.chunks, strict, sec.path);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      moves.push({ old: sec.path, new: sec.moveTo });
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/** Read a V4A patch into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const isHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    let sec: VSection | null = null;
    if (l.startsWith('*** Add File: ')) sec = { kind: 'add', path: l.slice('*** Add File: '.length).trim(), moveTo: null, addLines: [], chunks: [], lineNo: i + 1 };
    else if (l.startsWith('*** Delete File: ')) sec = { kind: 'delete', path: l.slice('*** Delete File: '.length).trim(), moveTo: null, addLines: [], chunks: [], lineNo: i + 1 };
    else if (l.startsWith('*** Update File: ')) sec = { kind: 'update', path: l.slice('*** Update File: '.length).trim(), moveTo: null, addLines: [], chunks: [], lineNo: i + 1 };
    else throw new Exit2(`error: parse ${i + 1}`);
    sections.push(sec);
    i++;
    // Collect this section's raw lines (up to the next header or End Patch).
    const raw: Array<{ text: string; no: number }> = [];
    while (i < last) {
      const r = lines[i]!;
      if (isHeader(r)) break;
      raw.push({ text: r, no: i + 1 });
      i++;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (sec.kind === 'add') {
      for (const r of raw) {
        if (r.text === '') sec.addLines.push('');
        else if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
    } else if (sec.kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
    } else {
      // Update: optional `*** Move to:` first, then chunks.
      let k = 0;
      if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
        k++;
      }
      let chunk: VChunk | null = null;
      const closeChunk = (): void => {
        if (chunk !== null) { sec.chunks.push(chunk); chunk = null; }
      };
      let started = false;
      for (; k < raw.length; k++) {
        const r = raw[k]!;
        if (r.text.startsWith('@@')) {
          closeChunk();
          chunk = { anchor: r.text.slice(2).trim() === '' ? null : r.text.slice(2).trim(), o: [], n: [], eof: false };
          started = true;
          continue;
        }
        if (r.text === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.no}`);
          chunk.eof = true;
          closeChunk();
          continue;
        }
        if (r.text.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${r.no}`);
        const c = r.text === '' ? ' ' : r.text[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          if (chunk === null) {
            if (started) throw new Exit2(`error: parse ${r.no}`);
            chunk = { anchor: null, o: [], n: [], eof: false };
            started = true;
          }
          if (c === ' ') { const t = r.text === '' ? '' : r.text.slice(1); chunk.o.push(t); chunk.n.push({ text: t, ctx: chunk.o.length - 1 }); }
          else if (c === '-') chunk.o.push(r.text.slice(1));
          else chunk.n.push({ text: r.text.slice(1), ctx: null });
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      closeChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
  }
  return sections.map((s) => vSectionEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    moves.length = 0;
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Every path whose state changed, with the move pairs folded into R lines.
  const changed: Array<{ path: string; was: string | null; now: string | null }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ path: p, was, now });
  }
  const byPath = new Map(changed.map((c) => [c.path, c]));
  const used = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const m of moves) {
    const o = byPath.get(m.old);
    const nw = byPath.get(m.new);
    if (o !== undefined && nw !== undefined && o.was !== null && o.now === null && nw.was === null && nw.now !== null && !used.has(m.old) && !used.has(m.new)) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      used.add(m.old);
      used.add(m.new);
    }
  }
  for (const c of changed) {
    if (used.has(c.path)) continue;
    rows.push({ key: c.path, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.path}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
