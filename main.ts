// mend: the command-line tool SPEC.md specifies. Node 22, the standard library alone;
// run as `node main.ts [options] [PATCH]` with the working directory as the root of a
// tree of text files. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A patches, JSON edits), finds the lines each edit names at
// the first of three matching tiers, and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: exactly one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed per line, no empty piece
 *  after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** A file as lines plus its own line break and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest
 *  read from disk. `moves` records successful move edits, in order, for the `R` lines. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; next: string }> = [];
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
  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

type Edit = (tree: Tree) => void;

/** The format of a patch, per SPEC.md section 4. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines
// ---------------------------------------------------------------------------

type Tier = 0 | 1 | 2;

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineKey(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occursAt(lines: string[], o: string[], at: number, tier: Tier): boolean {
  for (let k = 0; k < o.length; k++) {
    if (lineKey(lines[at + k]!, tier) !== lineKey(o[k]!, tier)) return false;
  }
  return true;
}

/** Positions at or after `from` where O occurs at this tier. */
function occurrences(lines: string[], o: string[], tier: Tier, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    if (occursAt(lines, o, i, tier)) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions, or null
 *  when O occurs at no tier. With --strict only tier 0 is tried. */
function findTier(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
): { tier: Tier; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(lines, o, t as Tier, from);
    if (pos.length > 0) return { tier: t as Tier, pos };
  }
  return null;
}

/** One line of N: `ctx` is the index into O when the line is a context line (written
 *  as the file's own matched line), null for an added line. */
interface NItem {
  text: string;
  ctx: number | null;
}

/** The lines N writes when it replaces O at `pos`, per section 5. */
function buildN(
  fileLines: string[],
  pos: number,
  o: string[],
  n: NItem[],
  tier: Tier,
): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(fileLines[pos] ?? '');
    p = leadingWs(o[0]!);
  }
  return n.map((item) => {
    if (item.ctx !== null) return fileLines[pos + item.ctx]!;
    if (tier === 2) {
      const t = item.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    }
    return item.text;
  });
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

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
      tree.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
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
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const file = parseFile(before);
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      file.lines.splice(line, 0, ...add);
      tree.set(p, serializeFile(file));
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

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path a `--- `/`+++ ` line names: text after the four characters, up to the
 *  first tab, surrounding spaces removed, a leading `a/` or `b/` removed. */
function diffPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkHeader(line: string, i: number): number {
  const m = HUNK_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  return Number(m[1]);
}

/** A hunk's body: the lines after the header that start with ` `, `-`, `+` or `\`,
 *  or are empty; it ends at the first other line, at a `diff --git ` line, at a
 *  `--- ` line followed by a `+++ ` line, or at the end of the patch. Empty lines at
 *  the end of a body are not part of it. Returns the body and the next line index. */
function scanHunkBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: j };
}

/** O and N of a hunk body, in body order. */
function hunkON(body: string[]): { o: string[]; n: NItem[] } {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: null });
    }
    // `\` lines are not lines of O or N.
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(lines: string[]): boolean {
  let last = -1;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') last = k;
  }
  if (last < 0) return false;
  const next = lines[last + 1];
  return next !== undefined && next.startsWith('\\');
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let seenHunk = false;
  let i = 0;
  const startSection = (s: UniSection): void => {
    cur = s;
    seenHunk = false;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (cur === null) {
      if (line.startsWith('diff --git ')) {
        const m = DIFF_GIT_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection({
          pairOld: null,
          pairNew: null,
          renameFrom: null,
          renameTo: null,
          diffOld: m[1]!,
          diffNew: m[2]!,
          newFile: false,
          deletedFile: false,
          hunks: [],
        });
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection({
          pairOld: null,
          pairNew: null,
          renameFrom: null,
          renameTo: null,
          diffOld: null,
          diffNew: null,
          newFile: false,
          deletedFile: false,
          hunks: [],
        });
        // The pair itself is the section's header; the header loop below consumes it.
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
      continue;
    }
    if (!seenHunk) {
      if (line.startsWith('diff --git ')) {
        sections.push(cur);
        cur = null;
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = diffPath(line);
          cur.pairNew = diffPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('@@')) {
        const a = parseHunkHeader(line, i);
        const { body, next } = scanHunkBody(lines, i + 1);
        cur.hunks.push({ a, body });
        seenHunk = true;
        i = next;
        continue;
      }
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // `+++ ` lines, `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` lines and any other line are ignored.
      i++;
      continue;
    }
    // After the first hunk: a new section, a new hunk, or ignored prose.
    if (line.startsWith('diff --git ')) {
      sections.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sections.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line, i);
      const { body, next } = scanHunkBody(lines, i + 1);
      cur.hunks.push({ a, body });
      i = next;
      continue;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks in order to a file model, per section 6. */
function applyHunks(file: FileModel, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, file.lines.length);
      const ins = buildN(file.lines, at, o, n, 0);
      const atEnd = at === file.lines.length;
      file.lines = [...file.lines.slice(0, at), ...ins, ...file.lines.slice(at)];
      if (atEnd) file.finalBreak = !backslashAfterLast(h.body);
      d += n.length;
      continue;
    }
    const found = findTier(file.lines, o, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + o.length === file.lines.length;
    const out = buildN(file.lines, best, o, n, found.tier);
    file.lines = [...file.lines.slice(0, best), ...out, ...file.lines.slice(best + o.length)];
    if (runsToEnd) file.finalBreak = !backslashAfterLast(h.body);
    d += n.length - o.length;
  }
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldPath = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newPath = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
  const isCreate = oldPath === '/dev/null' || sec.newFile;
  const isDelete = newPath === '/dev/null' || sec.deletedFile;
  if (isCreate && newPath !== null && newPath !== '/dev/null') {
    const p = newPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const l of h.body) if (l.startsWith('+')) plus.push(l.slice(1));
      }
      let finalBreak = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const b = sec.hunks[hi]!.body;
        let idx = -1;
        for (let k = b.length - 1; k >= 0; k--) {
          if (b[k]!.startsWith('+')) {
            idx = k;
            break;
          }
        }
        if (idx >= 0) {
          finalBreak = !(b[idx + 1] !== undefined && b[idx + 1]!.startsWith('\\'));
          break;
        }
      }
      tree.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
    };
  }
  if (isDelete && oldPath !== null && oldPath !== '/dev/null') {
    const p = oldPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
    };
  }
  if (
    oldPath !== null &&
    newPath !== null &&
    oldPath !== newPath &&
    oldPath !== '/dev/null' &&
    newPath !== '/dev/null'
  ) {
    const o = oldPath;
    const n = newPath;
    return (tree) => {
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const text = tree.get(o);
      if (text === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const file = parseFile(text);
      applyHunks(file, sec.hunks, o, strict);
      tree.set(n, serializeFile(file));
      tree.set(o, null);
      tree.moves.push({ old: o, next: n });
    };
  }
  if (oldPath !== null && oldPath !== '/dev/null') {
    const p = oldPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const file = parseFile(text);
      applyHunks(file, sec.hunks, p, strict);
      tree.set(p, serializeFile(file));
    };
  }
  // A section naming no file at all: an edit that changes nothing.
  return () => {};
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let k = searchLine + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevReplaceEnd; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    prevPath = path;
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(
  path: string,
  oldLines: string[],
  newLines: string[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const file = parseFile(text);
    const found = findTier(file.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const out = buildN(
      file.lines,
      pos,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: null })),
      found.tier,
    );
    file.lines = [...file.lines.slice(0, pos), ...out, ...file.lines.slice(pos + oldLines.length)];
    tree.set(path, serializeFile(file));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NItem[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  startLine: number;
  content: Array<{ text: string; idx: number }>;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const start = i;
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (
        l.startsWith('*** Add File: ') ||
        l.startsWith('*** Delete File: ') ||
        l.startsWith('*** Update File: ')
      ) {
        break;
      }
      j++;
    }
    const content = lines.slice(start + 1, j).map((text, k) => ({ text, idx: start + 1 + k }));
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    sections.push({ kind, path, startLine: start, content });
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aChunks(sec: VSection): { moveTo: string | null; chunks: VChunk[] } {
  const content = sec.content;
  let k = 0;
  let moveTo: string | null = null;
  if (content.length > 0 && content[0]!.text.startsWith('*** Move to: ')) {
    moveTo = content[0]!.text.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const isBody = (t: string): boolean => t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+';
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
  const finish = (): void => {
    if (cur === null) return;
    const o: string[] = [];
    const n: NItem[] = [];
    for (const t of cur.body) {
      if (t === '' || t[0] === ' ') {
        const x = t.slice(1);
        o.push(x);
        n.push({ text: x, ctx: o.length - 1 });
      } else if (t[0] === '-') {
        o.push(t.slice(1));
      } else if (t[0] === '+') {
        n.push({ text: t.slice(1), ctx: null });
      }
    }
    chunks.push({ anchor: cur.anchor, eof: cur.eof, o, n });
    cur = null;
  };
  while (k < content.length) {
    const { text, idx } = content[k]!;
    if (text.startsWith('@@')) {
      finish();
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      k++;
    } else if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
      cur.eof = true;
      finish();
      k++;
    } else if (isBody(text)) {
      if (cur === null) {
        if (chunks.length === 0) cur = { anchor: null, eof: false, body: [] };
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      cur.body.push(text);
      k++;
    } else {
      throw new Exit2(`error: parse ${idx + 1}`);
    }
  }
  finish();
  if (chunks.length === 0 && moveTo === null) {
    throw new Exit2(`error: parse ${sec.startLine + 1}`);
  }
  return { moveTo, chunks };
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  const path = sec.path;
  if (sec.kind === 'add') {
    for (const { text, idx } of sec.content) {
      if (!(text.startsWith('+') || text === '')) throw new Exit2(`error: parse ${idx + 1}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const ls = sec.content.map((c) => (c.text === '' ? '' : c.text.slice(1)));
      tree.set(path, ls.length === 0 ? '' : ls.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    for (const { idx } of sec.content) throw new Exit2(`error: parse ${idx + 1}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.set(path, null);
    };
  }
  const { moveTo, chunks } = v4aChunks(sec);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const file = parseFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(file.lines, [ch.anchor], cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? file.lines.length : cursor;
        const ins = buildN(file.lines, at, ch.o, ch.n, 0);
        file.lines = [...file.lines.slice(0, at), ...ins, ...file.lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      const found = findTier(file.lines, ch.o, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      let pos: number | null = null;
      if (ch.eof) {
        for (const p of found.pos) {
          if (p + ch.o.length === file.lines.length) {
            pos = p;
            break;
          }
        }
        if (pos === null) throw new Fail('no-match', path);
      } else {
        pos = found.pos[0]!;
      }
      const out = buildN(file.lines, pos, ch.o, ch.n, found.tier);
      file.lines = [...file.lines.slice(0, pos), ...out, ...file.lines.slice(pos + ch.o.length)];
      cursor = pos + out.length;
    }
    const out = serializeFile(file);
    if (moveTo !== null) {
      tree.set(moveTo, out);
      tree.set(path, null);
      tree.moves.push({ old: path, next: moveTo });
    } else {
      tree.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: the command line, output, exit codes, order, atomicity
// ---------------------------------------------------------------------------

function parsePatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  switch (kind) {
    case 'json':
      return jsonEdits(text, lines);
    case 'unified':
      return parseUnified(lines, strict);
    case 'search-replace':
      return searchReplaceEdits(lines, strict);
    case 'v4a':
      return parseV4a(lines, strict);
    default:
      throw new Error(`unknown format ${kind}`);
  }
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
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) check = true;
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
    edits = parsePatch(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const suppressed = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.next);
    const nowNew = tree.get(m.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
      suppressed.add(m.old);
      suppressed.add(m.next);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    // Delete first, then write, so a deleted path never blocks a created one.
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now !== null) continue;
      rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
