// main.ts is mend, the command-line patch tool specified in SPEC.md (MIT).

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

function parseFile(text: string | null): { lines: string[]; crlf: boolean; endsWithBreak: boolean } {
  if (text === null || text === '') return { lines: [], crlf: false, endsWithBreak: false };
  const firstLf = text.indexOf('\n');
  const crlf = firstLf > 0 && text[firstLf - 1] === '\r';
  const br = crlf ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(br);
  const rawParts = text.split(br);
  if (endsWithBreak) {
    rawParts.pop();
  }
  return { lines: rawParts, crlf, endsWithBreak };
}

function serializeFile(lines: string[], crlf: boolean, endsWithBreak: boolean): string {
  if (lines.length === 0 && !endsWithBreak) return '';
  const br = crlf ? '\r\n' : '\n';
  return lines.join(br) + (endsWithBreak ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();

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

function lineMatch(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) return fileLine.replace(/[ \t]+$/, '') === patchLine.replace(/[ \t]+$/, '');
  if (tier === 2) return fileLine.trim() === patchLine.trim();
  return false;
}

function findMatches(fileLines: string[], oLines: string[], strict: boolean): { tier: number; indices: number[] } | null {
  if (oLines.length === 0) return null;
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const indices: number[] = [];
    for (let i = 0; i <= fileLines.length - oLines.length; i++) {
      let match = true;
      for (let j = 0; j < oLines.length; j++) {
        if (!lineMatch(fileLines[i + j]!, oLines[j]!, t)) {
          match = false;
          break;
        }
      }
      if (match) indices.push(i);
    }
    if (indices.length > 0) {
      return { tier: t, indices };
    }
  }
  return null;
}

function reindentLines(oFirstLine: string, fileFirstMatchedLine: string, nLines: string[]): string[] {
  const pMatch = oFirstLine.match(/^[ \t]*/);
  const fMatch = fileFirstMatchedLine.match(/^[ \t]*/);
  const p = pMatch ? pMatch[0] : '';
  const f = fMatch ? fMatch[0] : '';
  return nLines.map((l) => {
    if (l === '' || l.trim() === '') return l;
    if (l.startsWith(p)) {
      return f + l.slice(p.length);
    }
    return l;
  });
}

function reindentLine(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) {
    return f + line.slice(p.length);
  }
  return line;
}

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

// JSON Edits (Section 9)
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

// Unified Diffs (Section 6)
interface UnifiedHunk {
  a: number;
  b: number;
  c: number;
  d: number;
  oLines: string[];
  nLines: string[];
  bodyLines: { op: string; text: string; lineNo: number }[];
  noeolO: boolean;
  noeolN: boolean;
  headerLine: number;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
  lineNo: number;
}

function cleanDiffPath(raw: string): string | null {
  let s = raw.trim();
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  let currentSec: UnifiedSection | null = null;

  while (i < lines.length) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const parts = l.slice(11).trim();
      const sp = parts.split(/\s+/);
      if (sp.length < 2) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const oP = cleanDiffPath(sp[0]!);
      const nP = cleanDiffPath(sp[1]!);
      currentSec = { oldPath: oP, newPath: nP, isCreate: false, isDelete: false, hunks: [], lineNo: i + 1 };
      sections.push(currentSec);
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith('+++ ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      const oP = cleanDiffPath(l.slice(4));
      const nP = cleanDiffPath(next.slice(4));

      if (currentSec === null || currentSec.hunks.length > 0) {
        currentSec = { oldPath: oP, newPath: nP, isCreate: false, isDelete: false, hunks: [], lineNo: i + 1 };
        sections.push(currentSec);
      } else {
        currentSec.oldPath = oP;
        currentSec.newPath = nP;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('rename from ')) {
      if (currentSec === null || currentSec.hunks.length > 0) {
        currentSec = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [], lineNo: i + 1 };
        sections.push(currentSec);
      }
      currentSec.oldPath = cleanDiffPath(l.slice(12));
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (currentSec === null || currentSec.hunks.length > 0) {
        currentSec = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [], lineNo: i + 1 };
        sections.push(currentSec);
      }
      currentSec.newPath = cleanDiffPath(l.slice(10));
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      if (currentSec === null || currentSec.hunks.length > 0) {
        currentSec = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [], lineNo: i + 1 };
        sections.push(currentSec);
      }
      currentSec.isCreate = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      if (currentSec === null || currentSec.hunks.length > 0) {
        currentSec = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [], lineNo: i + 1 };
        sections.push(currentSec);
      }
      currentSec.isDelete = true;
      i++;
      continue;
    }
    if (l.startsWith('@@ ')) {
      if (!currentSec) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const m = l.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (!m) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const a = parseInt(m[1]!, 10);
      const c = parseInt(m[2]!, 10);
      const hLineNo = i + 1;
      i++;
      const bodyLines: { op: string; text: string; lineNo: number }[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
          break;
        }
        if (bl.startsWith('@@ ')) {
          break;
        }
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          const op = bl === '' ? ' ' : bl[0]!;
          const text = bl === '' ? '' : bl.slice(1);
          bodyLines.push({ op, text, lineNo: i + 1 });
          i++;
        } else {
          break;
        }
      }
      while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.op === ' ' && bodyLines[bodyLines.length - 1]!.text === '') {
        bodyLines.pop();
      }

      const oLines: string[] = [];
      const nLines: string[] = [];
      let noeolO = false;
      let noeolN = false;
      for (let k = 0; k < bodyLines.length; k++) {
        const bl = bodyLines[k]!;
        if (bl.op === ' ') {
          oLines.push(bl.text);
          nLines.push(bl.text);
        } else if (bl.op === '-') {
          oLines.push(bl.text);
          if (bodyLines[k + 1]?.op === '\\') {
            noeolO = true;
            k++;
          }
        } else if (bl.op === '+') {
          nLines.push(bl.text);
          if (bodyLines[k + 1]?.op === '\\') {
            noeolN = true;
            k++;
          }
        }
      }
      currentSec.hunks.push({
        a,
        b: 0,
        c,
        d: 0,
        oLines,
        nLines,
        bodyLines,
        noeolO,
        noeolN,
        headerLine: hLineNo,
      });
      continue;
    }
    if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    i++;
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = sec.isDelete || newP === null;
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const targetPath = newP !== null ? newP : oldP;
    if (targetPath === null) throw new Exit2(`error: parse ${sec.lineNo}`);

    edits.push((tree) => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);

      if (isMove && oldP !== null && newP !== null) {
        tree.moves.set(oldP, newP);
      }

      if (isCreate) {
        if (tree.get(targetPath!) !== null) throw new Fail('exists', targetPath!);
        let combinedLines: string[] = [];
        let lastNoeol = false;
        for (const h of sec.hunks) {
          combinedLines.push(...h.nLines);
          if (h.noeolN) lastNoeol = true;
          else lastNoeol = false;
        }
        tree.now.set(targetPath!, serializeFile(combinedLines, false, !lastNoeol));
        return;
      }

      if (isDelete) {
        if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
        tree.now.set(oldP!, null);
        return;
      }

      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);

      const origText = tree.get(oldP!);
      const parsed = parseFile(origText);
      let fileLines = [...parsed.lines];
      const crlf = parsed.crlf;
      let endsWithBreak = parsed.endsWithBreak;

      let dTotal = 0;
      for (const h of sec.hunks) {
        const oLen = h.oLines.length;
        const nLen = h.nLines.length;
        const targetPos = h.a - 1 + dTotal;

        if (oLen > 0) {
          const matchResult = findMatches(fileLines, h.oLines, strict);
          if (!matchResult) throw new Fail('no-match', oldP!);
          let bestIdx = matchResult.indices[0]!;
          let bestDist = Math.abs(bestIdx - targetPos);
          for (let idx = 1; idx < matchResult.indices.length; idx++) {
            const pos = matchResult.indices[idx]!;
            const dist = Math.abs(pos - targetPos);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = pos;
            }
          }

          const matchedTier = matchResult.tier;
          const pMatch = matchedTier === 2 && h.oLines.length > 0 ? h.oLines[0]!.match(/^[ \t]*/) : null;
          const fMatch = matchedTier === 2 && h.oLines.length > 0 ? fileLines[bestIdx]!.match(/^[ \t]*/) : null;
          const p = pMatch ? pMatch[0] : '';
          const f = fMatch ? fMatch[0] : '';

          let newLinesToAdd: string[] = [];
          let oCursor = 0;
          for (const bl of h.bodyLines) {
            if (bl.op === ' ') {
              newLinesToAdd.push(fileLines[bestIdx + oCursor]!);
              oCursor++;
            } else if (bl.op === '-') {
              oCursor++;
            } else if (bl.op === '+') {
              let tLine = bl.text;
              if (matchedTier === 2) {
                tLine = reindentLine(tLine, p, f);
              }
              newLinesToAdd.push(tLine);
            }
          }

          fileLines.splice(bestIdx, oLen, ...newLinesToAdd);

          if (bestIdx + oLen >= fileLines.length) {
            if (h.noeolN) endsWithBreak = false;
          }

          dTotal += nLen - oLen;
        } else {
          const insPos = Math.min(Math.max(0, h.a + dTotal), fileLines.length);
          fileLines.splice(insPos, 0, ...h.nLines);
          if (insPos >= fileLines.length && h.noeolN) {
            endsWithBreak = false;
          }
          dTotal += nLen - oLen;
        }
      }

      const resText = serializeFile(fileLines, crlf, endsWithBreak);
      if (isMove && oldP !== null && newP !== null) {
        tree.now.set(oldP, null);
        tree.now.set(newP, resText);
      } else {
        tree.now.set(oldP!, resText);
      }
    });
  }
  return edits;
}

// SEARCH/REPLACE Blocks (Section 7)
interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  searchLineNo: number;
}

function searchReplaceEdits(text: string, lines: string[], strict: boolean): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.trimEnd() === '<<<<<<< SEARCH') {
      const searchLineNo = i + 1;
      let prevReplaceIdx = blocks.length > 0 ? (blocks[blocks.length - 1] as any).replaceLineNo || 0 : -1;
      let foundPath: string | null = null;
      for (let lIdx = searchLineNo - 2; lIdx > prevReplaceIdx - 1; lIdx--) {
        if (lIdx < 0) break;
        const textLine = lines[lIdx]!;
        if (blank(textLine)) continue;
        const trimmed = textLine.trim();
        if (trimmed.startsWith('```')) continue;
        foundPath = trimmed;
        break;
      }
      if (foundPath === null) {
        if (blocks.length > 0) {
          foundPath = blocks[blocks.length - 1]!.path;
        } else {
          throw new Exit2(`error: parse ${searchLineNo}`);
        }
      }

      i++;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      let foundEqual = false;
      let foundReplace = false;
      let replaceLineNo = -1;

      while (i < lines.length) {
        const bl = lines[i]!;
        const trimmed = bl.trimEnd();
        if (trimmed === '=======') {
          foundEqual = true;
          i++;
          break;
        }
        if (trimmed === '>>>>>>> REPLACE') {
          throw new Exit2(`error: parse ${searchLineNo}`);
        }
        oldLines.push(bl);
        i++;
      }

      if (!foundEqual) throw new Exit2(`error: parse ${searchLineNo}`);

      while (i < lines.length) {
        const bl = lines[i]!;
        const trimmed = bl.trimEnd();
        if (trimmed === '>>>>>>> REPLACE') {
          foundReplace = true;
          replaceLineNo = i + 1;
          i++;
          break;
        }
        newLines.push(bl);
        i++;
      }

      if (!foundReplace) throw new Exit2(`error: parse ${searchLineNo}`);

      blocks.push({
        path: foundPath,
        oldLines,
        newLines,
        searchLineNo,
        ...({ replaceLineNo } as any),
      });
      continue;
    }
    i++;
  }

  if (blocks.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const b of blocks) {
    const p = b.path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);

      if (b.oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, b.newLines.join('\n') + (b.newLines.length > 0 ? '\n' : ''));
        return;
      }

      const origText = tree.get(p);
      if (origText === null) throw new Fail('missing', p);
      const parsed = parseFile(origText);
      const matchResult = findMatches(parsed.lines, b.oldLines, strict);
      if (!matchResult || matchResult.indices.length === 0) throw new Fail('no-match', p);
      if (matchResult.indices.length > 1) throw new Fail('ambiguous', p);

      const bestIdx = matchResult.indices[0]!;
      const matchedTier = matchResult.tier;
      let actualNew = b.newLines;
      if (matchedTier === 2) {
        actualNew = reindentLines(b.oldLines[0]!, parsed.lines[bestIdx]!, b.newLines);
      }

      parsed.lines.splice(bestIdx, b.oldLines.length, ...actualNew);
      tree.now.set(p, serializeFile(parsed.lines, parsed.crlf, parsed.endsWithBreak));
    });
  }
  return edits;
}

// V4A Patches (Section 8)
interface V4AChunk {
  anchor: string | null;
  oLines: string[];
  nLines: string[];
  bodyLines: { op: string; text: string; lineNo: number }[];
  isEof: boolean;
}

interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  newPath: string | null;
  lines: string[];
  chunks: V4AChunk[];
  lineNo: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0 || lines[firstNonBlank]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank >= 0 ? firstNonBlank + 1 : 1}`);
  }

  let lastNonBlank = lines.length - 1;
  while (lastNonBlank >= 0 && blank(lines[lastNonBlank]!)) {
    lastNonBlank--;
  }
  if (lastNonBlank < 0 || lines[lastNonBlank]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const sections: V4ASection[] = [];
  let i = firstNonBlank + 1;
  while (i < lastNonBlank) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const trimmed = l.trim();
    if (trimmed.startsWith('*** Add File:')) {
      const p = trimmed.slice(13).trim();
      const secLine = i + 1;
      i++;
      const fileLines: string[] = [];
      while (i < lastNonBlank) {
        const bl = lines[i]!;
        if (bl.trim().startsWith('*** ')) {
          break;
        }
        if (bl.startsWith('+')) {
          fileLines.push(bl.slice(1));
        } else if (bl === '') {
          fileLines.push('');
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        i++;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') {
        fileLines.pop();
      }
      sections.push({ type: 'add', path: p, newPath: null, lines: fileLines, chunks: [], lineNo: secLine });
      continue;
    }
    if (trimmed.startsWith('*** Delete File:')) {
      const p = trimmed.slice(16).trim();
      const secLine = i + 1;
      i++;
      sections.push({ type: 'delete', path: p, newPath: null, lines: [], chunks: [], lineNo: secLine });
      continue;
    }
    if (trimmed.startsWith('*** Update File:')) {
      const p = trimmed.slice(16).trim();
      const secLine = i + 1;
      i++;
      let newPath: string | null = null;
      if (i < lastNonBlank && lines[i]!.trim().startsWith('*** Move to:')) {
        newPath = lines[i]!.trim().slice(12).trim();
        i++;
      }

      const chunks: V4AChunk[] = [];
      while (i < lastNonBlank) {
        const bl = lines[i]!;
        if (blank(bl)) {
          i++;
          continue;
        }
        if (bl.trim().startsWith('*** ')) {
          break;
        }
        let anchor: string | null = null;
        if (bl.startsWith('@@ ')) {
          anchor = bl.trim().slice(3).trim();
          if (anchor === '') anchor = null;
          i++;
        }

        const bodyLines: { op: string; text: string; lineNo: number }[] = [];
        let isEof = false;
        while (i < lastNonBlank) {
          const cl = lines[i]!;
          if (blank(cl) || cl.trim().startsWith('*** ') || cl.startsWith('@@ ')) {
            if (cl.trim() === '*** End of File') {
              isEof = true;
              i++;
            }
            break;
          }
          if (cl === '' || cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+')) {
            const op = cl === '' ? ' ' : cl[0]!;
            const text = cl === '' ? '' : cl.slice(1);
            bodyLines.push({ op, text, lineNo: i + 1 });
            i++;
          } else if (cl.trim() === '*** End of File') {
            isEof = true;
            i++;
            break;
          } else {
            throw new Exit2(`error: parse ${i + 1}`);
          }
        }

        const oLines: string[] = [];
        const nLines: string[] = [];
        for (const bline of bodyLines) {
          if (bline.op === ' ') {
            oLines.push(bline.text);
            nLines.push(bline.text);
          } else if (bline.op === '-') {
            oLines.push(bline.text);
          } else if (bline.op === '+') {
            nLines.push(bline.text);
          }
        }

        chunks.push({ anchor, oLines, nLines, bodyLines, isEof });
      }

      if (chunks.length === 0 && newPath === null) {
        throw new Exit2(`error: parse ${secLine}`);
      }

      sections.push({ type: 'update', path: p, newPath, lines: [], chunks, lineNo: secLine });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const sec of sections) {
    edits.push((tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.newPath !== null && !safe(sec.newPath)) throw new Fail('unsafe', sec.newPath);

      if (sec.newPath !== null) {
        tree.moves.set(sec.path, sec.newPath);
      }

      if (sec.type === 'add') {
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.lines.join('\n') + (sec.lines.length > 0 ? '\n' : ''));
        return;
      }

      if (sec.type === 'delete') {
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }

      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      if (sec.newPath !== null && tree.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);

      const origText = tree.get(sec.path);
      const parsed = parseFile(origText);
      let fileLines = [...parsed.lines];
      const crlf = parsed.crlf;
      const endsWithBreak = parsed.endsWithBreak;

      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          let foundAnchorIdx = -1;
          const maxTier = strict ? 0 : 2;
          for (let t = 0; t <= maxTier; t++) {
            let found = -1;
            for (let idx = cursor; idx < fileLines.length; idx++) {
              if (lineMatch(fileLines[idx]!, ch.anchor, t)) {
                found = idx;
                break;
              }
            }
            if (found >= 0) {
              foundAnchorIdx = found;
              break;
            }
          }
          if (foundAnchorIdx < 0) throw new Fail('no-match', sec.path);
          cursor = foundAnchorIdx + 1;
        }

        if (ch.oLines.length > 0) {
          if (ch.isEof) {
            const startIdx = fileLines.length - ch.oLines.length;
            if (startIdx < cursor) throw new Fail('no-match', sec.path);
            const matchRes = findMatches(fileLines.slice(startIdx), ch.oLines, strict);
            if (!matchRes || matchRes.indices.length === 0 || matchRes.indices[0] !== 0) {
              throw new Fail('no-match', sec.path);
            }

            let newToAdd: string[] = [];
            let oCursor = 0;
            const matchedTier = matchRes.tier;
            const pMatch = matchedTier === 2 && ch.oLines.length > 0 ? ch.oLines[0]!.match(/^[ \t]*/) : null;
            const fMatch = matchedTier === 2 && ch.oLines.length > 0 ? fileLines[startIdx]!.match(/^[ \t]*/) : null;
            const p = pMatch ? pMatch[0] : '';
            const f = fMatch ? fMatch[0] : '';

            for (const bline of ch.bodyLines) {
              if (bline.op === ' ') {
                newToAdd.push(fileLines[startIdx + oCursor]!);
                oCursor++;
              } else if (bline.op === '-') {
                oCursor++;
              } else if (bline.op === '+') {
                let tLine = bline.text;
                if (matchedTier === 2) {
                  tLine = reindentLine(tLine, p, f);
                }
                newToAdd.push(tLine);
              }
            }
            fileLines.splice(startIdx, ch.oLines.length, ...newToAdd);
            cursor = fileLines.length;
          } else {
            let matchIdx = -1;
            let matchedTier = 0;
            const maxTier = strict ? 0 : 2;
            for (let t = 0; t <= maxTier; t++) {
              let found = -1;
              for (let idx = cursor; idx <= fileLines.length - ch.oLines.length; idx++) {
                let m = true;
                for (let j = 0; j < ch.oLines.length; j++) {
                  if (!lineMatch(fileLines[idx + j]!, ch.oLines[j]!, t)) {
                    m = false;
                    break;
                  }
                }
                if (m) {
                  found = idx;
                  break;
                }
              }
              if (found >= 0) {
                matchIdx = found;
                matchedTier = t;
                break;
              }
            }
            if (matchIdx < 0) throw new Fail('no-match', sec.path);

            let newToAdd: string[] = [];
            let oCursor = 0;
            const pMatch = matchedTier === 2 && ch.oLines.length > 0 ? ch.oLines[0]!.match(/^[ \t]*/) : null;
            const fMatch = matchedTier === 2 && ch.oLines.length > 0 ? fileLines[matchIdx]!.match(/^[ \t]*/) : null;
            const p = pMatch ? pMatch[0] : '';
            const f = fMatch ? fMatch[0] : '';

            for (const bline of ch.bodyLines) {
              if (bline.op === ' ') {
                newToAdd.push(fileLines[matchIdx + oCursor]!);
                oCursor++;
              } else if (bline.op === '-') {
                oCursor++;
              } else if (bline.op === '+') {
                let tLine = bline.text;
                if (matchedTier === 2) {
                  tLine = reindentLine(tLine, p, f);
                }
                newToAdd.push(tLine);
              }
            }
            fileLines.splice(matchIdx, ch.oLines.length, ...newToAdd);
            cursor = matchIdx + newToAdd.length;
          }
        } else {
          if (ch.isEof) {
            fileLines.push(...ch.nLines);
            cursor = fileLines.length;
          } else {
            fileLines.splice(cursor, 0, ...ch.nLines);
            cursor += ch.nLines.length;
          }
        }
      }

      const resText = serializeFile(fileLines, crlf, endsWithBreak);
      if (sec.newPath !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.newPath, resText);
      } else {
        tree.now.set(sec.path, resText);
      }
    });
  }
  return edits;
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(text, lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else throw new Exit2('error: format');
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

  const rows: { type: 'A' | 'D' | 'M' | 'R'; path: string; sortKey: string }[] = [];
  const handledPaths = new Set<string>();

  for (const [oldP, newP] of tree.moves.entries()) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ type: 'R', path: `${oldP} -> ${newP}`, sortKey: newP });
      handledPaths.add(oldP);
      handledPaths.add(newP);
    }
  }

  const modifiedPaths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of modifiedPaths) {
    if (handledPaths.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const type = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ type, path: p, sortKey: p });
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));

  const outputLines = rows.map((r) => `${r.type} ${r.path}`);
  for (const p of modifiedPaths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }

  return { code: 0, out: [...outputLines, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
