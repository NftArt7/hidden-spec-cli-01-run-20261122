// mend: one patch tool for every AI edit format.
//
// Applies edits in four formats -- unified diffs, SEARCH/REPLACE blocks,
// V4A patches and JSON tool calls -- to a tree of text files, following
// SPEC.md v1. Node 22, standard library only; run as
// `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// Matching works at three tiers: exact lines, lines equal once trailing
// spaces and tabs are removed, and lines equal once leading and trailing
// spaces and tabs are removed. The first tier where the old lines occur
// decides, and every edit either applies or fails cleanly; when any edit
// fails nothing is written at all.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and the last lines below hand over to runner.ts: keep that hand-over
// and runner.ts as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse failure: exit 2 with `error: parse <line>`. */
class ParseFail extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`error: parse ${line}`);
    this.line = line;
  }
}

/** One failed edit: exit 1 with `error: <code> <path>`. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed, and the empty
 *  piece after a final `\n` dropped. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** Byte order of paths, as UTF-8. */
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A line compared at a matching tier. */
function normLine(s: string, tier: number): string {
  if (tier === 1) return trimTrail(s);
  if (tier === 2) return trimBoth(s);
  return s;
}

/** A file as lines, its line break, and whether it ends with one. */
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

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/** Every position where `old` occurs in `lines` at one tier. */
function occurrences(
  lines: string[],
  old: string[],
  tier: number,
  from = 0,
  mustEndAtLast = false,
): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i++) {
    if (mustEndAtLast && i + old.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < old.length; k++) {
      if (normLine(lines[i + k]!, tier) !== normLine(old[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `old` occurs, with its positions. */
function firstTier(
  lines: string[],
  old: string[],
  strict: boolean,
  from = 0,
  mustEndAtLast = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, old, t, from, mustEndAtLast);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor. */
function firstAnchor(
  lines: string[],
  anchor: string,
  strict: boolean,
  from: number,
): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

/** One line of the replacement text: a context line taken from the file
 *  at the matching old-line index, or a new line from the patch. */
interface NewItem {
  ctx: boolean;
  oIdx: number;
  text: string;
}

/** Build the replacement lines for a match at `pos` and `tier`.
 *  Context lines are written as the file's own matched lines. At tier 2
 *  every other line that starts with the old first line's leading
 *  whitespace has that prefix replaced by the file first matched line's
 *  leading whitespace; when that prefix is empty nothing is re-indented. */
function buildNew(
  items: NewItem[],
  fileLines: string[],
  pos: number,
  oldFirst: string,
  tier: number,
): string[] {
  const p = leadingWs(oldFirst);
  const f = leadingWs(fileLines[pos] ?? '');
  const out: string[] = [];
  for (const it of items) {
    if (it.ctx) {
      out.push(fileLines[pos + it.oIdx]!);
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) {
      t = f + t.slice(p.length);
    }
    out.push(t);
  }
  return out;
}

/** The tree as the edits leave it: pending changes in `now` (null means
 *  deleted), everything else read from disk as it was. */
class Tree {
  private kindCache = new Map<string, 'file' | 'dir' | 'absent'>();
  private textCache = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  diskKind(p: string): 'file' | 'dir' | 'absent' {
    if (!this.kindCache.has(p)) {
      try {
        const st = statSync(p);
        this.kindCache.set(p, st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'absent');
      } catch {
        this.kindCache.set(p, 'absent');
      }
    }
    return this.kindCache.get(p)!;
  }

  /** The file's bytes before the patch, or null when it was no file. */
  original(p: string): string | null {
    if (!this.textCache.has(p)) {
      if (this.diskKind(p) !== 'file') this.textCache.set(p, null);
      else {
        try {
          this.textCache.set(p, readFileSync(p, 'utf8'));
        } catch {
          this.textCache.set(p, null);
        }
      }
    }
    return this.textCache.get(p)!;
  }

  /** Whether the path is a file as the edits have left it. */
  kind(p: string): 'file' | 'dir' | 'absent' {
    if (this.now.has(p)) return this.now.get(p) === null ? 'absent' : 'file';
    return this.diskKind(p);
  }

  /** The file's text as the edits have left it, or null when no file. */
  text(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p)!;
    return this.original(p);
  }
}

type Move = { old: string; new: string };
type EditFn = (tree: Tree) => Move | null;

/** Detect the patch format (SPEC.md section 4). */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
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

/* ------------------------------------------------------------------ */
/* Shared body lines (unified hunks and V4A chunks)                    */
/* ------------------------------------------------------------------ */

/** One body line: context (in old and new), old-only, new-only, or a
 *  backslash line. `empty` marks a line that was bare in the patch. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
  empty: boolean;
}

/** Split body items into the old lines and the replacement items. */
function splitItems(items: BodyItem[]): { oTexts: string[]; nItems: NewItem[] } {
  const oTexts: string[] = [];
  const nItems: NewItem[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      nItems.push({ ctx: true, oIdx: oTexts.length, text: '' });
      oTexts.push(it.text);
    } else if (it.kind === 'old') {
      oTexts.push(it.text);
    } else if (it.kind === 'new') {
      nItems.push({ ctx: false, oIdx: -1, text: it.text });
    }
  }
  return { oTexts, nItems };
}

/** Whether a `\` line follows the last body line of one of `kinds`. */
function backslashAfter(items: BodyItem[], kinds: Array<'ctx' | 'new'>): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i++) {
    if (kinds.includes(items[i]!.kind as 'ctx' | 'new')) last = i;
  }
  if (last < 0) return false;
  return items[last + 1]?.kind === 'back';
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface Section {
  oldP: string | null;
  newP: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` header line. */
function headerPath(line: string): string {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  return (tab >= 0 ? raw.slice(0, tab) : raw).trim();
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse `diff --git a/<X> b/<Y>`, or null when it is not of that form. */
function parseDiffGit(line: string): [string, string] | null {
  if (!line.startsWith('diff --git a/')) return null;
  const sep = line.lastIndexOf(' b/');
  if (sep < 0) return null;
  const x = line.slice('diff --git a/'.length, sep);
  const y = line.slice(sep + 3).replace(/[ \t]+$/, '');
  if (x === '' || y === '') return null;
  return [x, y];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/;

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let git: [string, string] | null = null;
    if (line.startsWith('diff --git ')) {
      git = parseDiffGit(line);
      if (git === null) throw new ParseFail(i + 1);
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A section starting at its ---/+++ pair; the header reads it.
    } else if (line.startsWith('@@')) {
      throw new ParseFail(i + 1);
    } else {
      i++;
      continue;
    }

    let oldP: string | null = null;
    let newP: string | null = null;
    let hasPair = false;
    let createFlag = false;
    let delFlag = false;
    let renOld: string | null = null;
    let renNew: string | null = null;
    const hunks: Hunk[] = [];

    // Header: everything before the first hunk.
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('@@')) break;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          oldP = headerPath(h);
          newP = headerPath(lines[i + 1]!);
          hasPair = true;
          i += 2;
          continue;
        }
        throw new ParseFail(i + 2);
      }
      if (h.startsWith('rename from ')) {
        renOld = h.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (h.startsWith('rename to ')) {
        renNew = h.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (h.startsWith('new file mode')) {
        createFlag = true;
        i++;
        continue;
      }
      if (h.startsWith('deleted file mode')) {
        delFlag = true;
        i++;
        continue;
      }
      i++;
    }

    // Hunks.
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const m = HUNK_HEAD.exec(lines[i]!);
      if (m === null) throw new ParseFail(i + 1);
      const a = parseInt(m[1]!, 10);
      i++;
      const items: BodyItem[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '') {
          items.push({ kind: 'ctx', text: '', empty: true });
          i++;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') {
          items.push({ kind: 'ctx', text: b.slice(1), empty: false });
          i++;
          continue;
        }
        if (c === '-') {
          items.push({ kind: 'old', text: b.slice(1), empty: false });
          i++;
          continue;
        }
        if (c === '+') {
          items.push({ kind: 'new', text: b.slice(1), empty: false });
          i++;
          continue;
        }
        if (c === '\\') {
          items.push({ kind: 'back', text: b.slice(1), empty: false });
          i++;
          continue;
        }
        break;
      }
      while (
        items.length > 0 &&
        items[items.length - 1]!.kind === 'ctx' &&
        items[items.length - 1]!.empty
      ) {
        items.pop();
      }
      hunks.push({ a, items });
    }

    let oldPath: string | null;
    let newPath: string | null;
    if (hasPair) {
      oldPath = oldP === '/dev/null' ? null : stripAB(oldP!);
      newPath = newP === '/dev/null' ? null : stripAB(newP!);
    } else if (renOld !== null || renNew !== null) {
      oldPath = renOld ?? renNew;
      newPath = renNew ?? renOld;
    } else if (git !== null) {
      oldPath = git[0];
      newPath = git[1];
    } else {
      oldPath = null;
      newPath = null;
    }
    const create = createFlag || (hasPair && oldP === '/dev/null');
    const del = delFlag || (hasPair && newP === '/dev/null');
    edits.push(makeUnifiedEdit({ oldP: oldPath, newP: newPath, create, del, hunks }, strict));
  }
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

function makeUnifiedEdit(sec: Section, strict: boolean): EditFn {
  return (tree) => {
    if (sec.create) {
      const np = sec.newP;
      if (np === null) return null;
      if (!safePath(np)) throw new EditFail('unsafe', np);
      if (tree.kind(np) !== 'absent') throw new EditFail('exists', np);
      const out: string[] = [];
      let finalBreak = true;
      for (const h of sec.hunks) {
        for (const it of h.items) if (it.kind === 'new') out.push(it.text);
        if (h.items.some((it) => it.kind === 'new')) {
          finalBreak = !backslashAfter(h.items, ['new']);
        }
      }
      tree.now.set(np, out.length === 0 ? '' : out.join('\n') + (finalBreak ? '\n' : ''));
      return null;
    }
    if (sec.del) {
      const op = sec.oldP;
      if (op === null) return null;
      if (!safePath(op)) throw new EditFail('unsafe', op);
      if (tree.kind(op) !== 'file') throw new EditFail('missing', op);
      tree.now.set(op, null);
      return null;
    }
    const op = sec.oldP;
    const np = sec.newP;
    if (op === null || np === null) return null;
    const isMove = op !== np;
    if (!safePath(op)) throw new EditFail('unsafe', op);
    if (!safePath(np)) throw new EditFail('unsafe', np);
    if (tree.kind(op) !== 'file') throw new EditFail('missing', op);
    if (isMove && tree.kind(np) !== 'absent') throw new EditFail('exists', np);
    const model = parseFile(tree.text(op)!);
    const lines = [...model.lines];
    let curFinal = model.finalBreak;
    let d = 0;
    for (const h of sec.hunks) {
      const { oTexts, nItems } = splitItems(h.items);
      if (oTexts.length === 0) {
        const at = Math.min(Math.max(h.a + d, 0), lines.length);
        const ins = nItems.map((it) => it.text);
        const atEnd = at === lines.length;
        lines.splice(at, 0, ...ins);
        if (atEnd) curFinal = !backslashAfter(h.items, ['ctx', 'new']);
        d += ins.length;
      } else {
        const found = firstTier(lines, oTexts, strict);
        if (found === null) throw new EditFail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.positions) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const touchesEnd = best + oTexts.length === lines.length;
        const rep = buildNew(nItems, lines, best, oTexts[0]!, found.tier);
        lines.splice(best, oTexts.length, ...rep);
        if (touchesEnd) curFinal = !backslashAfter(h.items, ['ctx', 'new']);
        d += nItems.length - oTexts.length;
      }
    }
    const out = renderFile({ lines, br: model.br, finalBreak: curFinal });
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, out);
      return { old: op, new: np };
    }
    tree.now.set(op, out);
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isEq = (l: string): boolean => l.trimEnd() === '=======';
  const isEnd = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (!isSearch(lines[i]!)) {
      i++;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isEq(lines[j]!)) {
        eq = j;
        break;
      }
      if (isEnd(lines[j]!)) break;
    }
    if (eq < 0) throw new ParseFail(sIdx + 1);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (isEnd(lines[j]!)) {
        end = j;
        break;
      }
    }
    if (end < 0) throw new ParseFail(sIdx + 1);
    let path: string | null = null;
    for (let k = sIdx - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseFail(sIdx + 1);
    }
    const old = lines.slice(sIdx + 1, eq);
    const nw = lines.slice(eq + 1, end);
    edits.push(makeSearchReplaceEdit(path, old, nw, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

function makeSearchReplaceEdit(
  path: string,
  old: string[],
  nw: string[],
  strict: boolean,
): EditFn {
  return (tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (old.length === 0) {
      if (tree.kind(path) !== 'absent') throw new EditFail('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return null;
    }
    if (tree.kind(path) !== 'file') throw new EditFail('missing', path);
    const model = parseFile(tree.text(path)!);
    const lines = [...model.lines];
    const found = firstTier(lines, old, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.positions.length > 1) throw new EditFail('ambiguous', path);
    const pos = found.positions[0]!;
    const rep = buildNew(
      nw.map((t) => ({ ctx: false, oIdx: -1, text: t })),
      lines,
      pos,
      old[0]!,
      found.tier,
    );
    lines.splice(pos, old.length, ...rep);
    tree.now.set(path, renderFile({ lines, br: model.br, finalBreak: model.finalBreak }));
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface RawLine {
  text: string;
  no: number;
}

const isSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File:') ||
  l.startsWith('*** Delete File:') ||
  l.startsWith('*** Update File:');

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFail(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') {
    throw new ParseFail(lines.length + 1);
  }
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (!isSectionStart(line)) throw new ParseFail(i + 1);
    const headerLine = i + 1;
    let kind: 'add' | 'del' | 'update';
    if (line.startsWith('*** Add File:')) kind = 'add';
    else if (line.startsWith('*** Delete File:')) kind = 'del';
    else kind = 'update';
    const path = line.slice(line.indexOf(':') + 1).trim();
    const raw: RawLine[] = [];
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) {
      raw.push({ text: lines[j]!, no: j + 1 });
      j++;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(buildV4aEdit(kind, path, raw, headerLine, strict));
    i = j;
  }
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

function buildV4aEdit(
  kind: 'add' | 'del' | 'update',
  path: string,
  raw: RawLine[],
  headerLine: number,
  strict: boolean,
): EditFn {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text === '') fileLines.push('');
      else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else throw new ParseFail(r.no);
    }
    return (tree) => {
      if (!safePath(path)) throw new EditFail('unsafe', path);
      if (tree.kind(path) !== 'absent') throw new EditFail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      return null;
    };
  }
  if (kind === 'del') {
    for (const r of raw) throw new ParseFail(r.no);
    return (tree) => {
      if (!safePath(path)) throw new EditFail('unsafe', path);
      if (tree.kind(path) !== 'file') throw new EditFail('missing', path);
      tree.now.set(path, null);
      return null;
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
    moveTo = raw[0]!.text.slice(raw[0]!.text.indexOf(':') + 1).trim();
    idx = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (let k = idx; k < raw.length; k++) {
    const r = raw[k]!;
    if (r.text.startsWith('@@')) {
      cur = { anchor: r.text.slice(2).trim(), eof: false, items: [] };
      chunks.push(cur);
    } else if (r.text.trim() === '*** End of File') {
      if (cur === null) throw new ParseFail(r.no);
      cur.eof = true;
      cur = null;
    } else if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: null, eof: false, items: [] };
          chunks.push(cur);
        } else {
          throw new ParseFail(r.no);
        }
      }
      if (r.text === '') cur.items.push({ kind: 'ctx', text: '', empty: true });
      else if (r.text[0] === ' ') cur.items.push({ kind: 'ctx', text: r.text.slice(1), empty: false });
      else if (r.text[0] === '-') cur.items.push({ kind: 'old', text: r.text.slice(1), empty: false });
      else cur.items.push({ kind: 'new', text: r.text.slice(1), empty: false });
    } else {
      throw new ParseFail(r.no);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseFail(headerLine);
  return (tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new EditFail('unsafe', moveTo);
    if (tree.kind(path) !== 'file') throw new EditFail('missing', path);
    if (moveTo !== null && tree.kind(moveTo) !== 'absent') throw new EditFail('exists', moveTo);
    const model = parseFile(tree.text(path)!);
    const lines = [...model.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = firstAnchor(lines, ch.anchor, strict, cursor);
        if (at === null) throw new EditFail('no-match', path);
        cursor = at + 1;
      }
      const { oTexts, nItems } = splitItems(ch.items);
      if (oTexts.length === 0) {
        const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
        const ins = nItems.map((it) => it.text);
        lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = firstTier(lines, oTexts, strict, cursor, ch.eof);
        if (found === null) throw new EditFail('no-match', path);
        const pos = found.positions[0]!;
        const rep = buildNew(nItems, lines, pos, oTexts[0]!, found.tier);
        lines.splice(pos, oTexts.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = renderFile({ lines, br: model.br, finalBreak: model.finalBreak });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      return { old: path, new: moveTo };
    }
    tree.now.set(path, out);
    return null;
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.kind(p) !== 'absent') throw new EditFail('exists', p);
      tree.now.set(p, text);
      return null;
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
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.kind(p) !== 'file') throw new EditFail('missing', p);
      const before = tree.text(p)!;
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      const nw = norm(newStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + nw + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return null;
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.kind(p) !== 'file') throw new EditFail('missing', p);
      const model = parseFile(tree.text(p)!);
      if (lineNo < 0 || lineNo > model.lines.length) throw new EditFail('no-match', p);
      const lines = [...model.lines];
      lines.splice(lineNo, 0, ...add);
      tree.now.set(p, renderFile({ lines, br: model.br, finalBreak: model.finalBreak }));
      return null;
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail(1);
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFail(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFail(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFail(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseFail(1);
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFail(idx + 1);
    edits.push(e);
  });
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)    */
/* ------------------------------------------------------------------ */

function runCli(args: string[]): { code: number; out: string[] } {
  const usage = { code: 2, out: ['error: usage'] };
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usage;
        format = v;
      } else if (a === '--check') {
        if (check) return usage;
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage;
        strict = true;
      } else {
        return usage;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage;
  const patchArg = pos.length === 0 ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg === null || patchArg === '-' ? 0 : patchArg, 'utf8');
  } catch {
    if (patchArg !== null && patchArg !== '-') return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(text, lines);
    if (edits.length === 0) throw new ParseFail(1);
  } catch (e) {
    if (e instanceof ParseFail) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  const tree = new Tree();
  const fails: EditFail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== null) moves.push(mv);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
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

  const rows: { key: string; text: string }[] = [];
  const used = new Set<string>();
  for (const mv of moves) {
    if (
      tree.original(mv.old) !== null &&
      tree.text(mv.old) === null &&
      tree.original(mv.new) === null &&
      tree.text(mv.new) !== null
    ) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      used.add(mv.old);
      used.add(mv.new);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const cur = tree.now.get(p)!;
    if (was === cur) continue;
    rows.push({
      key: p,
      text: was === null ? `A ${p}` : cur === null ? `D ${p}` : `M ${p}`,
    });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));

  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const cur = tree.now.get(p)!;
      if (was === cur) continue;
      if (cur === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, cur);
      }
    }
  }
  return {
    code: 0,
    out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
