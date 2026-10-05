// SPDX-License-Identifier: GPL-2.0-or-later
// Entity lump parser. Tokens are quoted strings, bare words, braces, and `//` line
// comments, as in Quake 2's COM_Parse, except that a brace or quote also ends a bare
// word (COM_Parse splits only on whitespace). Compiler output parses identically.
// Braces are tested as SpawnEntities and ED_ParseEdict test them, by a token's first
// character, quoted or not: a "{..." token opens an entity, a "}..." key closes it, a
// "}..." value is an error, and a key "{" is an ordinary key.

export class EntityParseError extends Error {
  override name = "EntityParseError";
}

/**
 * One entity: key/value pairs. Keys are folded with `asciiLower`, since the game matches
 * them to its fields with Q_stricmp (ED_ParseField); values keep their case. A repeated
 * key (in any case) overwrites the earlier one, and non-numeric keys enumerate in the
 * order of each key's last assignment, so whichever of two keys came later in the file
 * is also later here (JS lists array-index keys such as "10" first, in ascending order).
 */
export type BspEntity = Readonly<Record<string, string>>;

interface Token {
  readonly text: string;
  readonly line: number;
}

function* tokenize(src: string): Generator<Token> {
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
    } else if (c <= " ") {
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === '"') {
      const start = line;
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new EntityParseError(`unterminated quoted string at line ${start}`);
      const text = src.slice(i + 1, end);
      for (const ch of text) if (ch === "\n") line++;
      yield { text, line: start };
      i = end + 1;
    } else if (c === "{" || c === "}") {
      yield { text: c, line };
      i++;
    } else {
      const start = i;
      while (i < src.length && src[i]! > " " && src[i] !== '"' && src[i] !== "{" && src[i] !== "}") i++;
      yield { text: src.slice(start, i), line };
    }
  }
}

const startsWith = (t: Token, b: "{" | "}") => t.text[0] === b;

/**
 * Case fold for keys and Q_stricmp compares: A-Z only. Q_stricmp is the C library's
 * strcasecmp/_stricmp, and the game never sets a locale, so other bytes never fold.
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function parseEntities(src: string): BspEntity[] {
  const entities: BspEntity[] = [];
  const tokens = tokenize(src);
  for (;;) {
    const open = tokens.next();
    if (open.done) break;
    if (!startsWith(open.value, "{")) {
      throw new EntityParseError(`expected "{" at line ${open.value.line}, found "${open.value.text}"`);
    }
    // Null prototype: keys come from map files, and "__proto__" must stay a plain key.
    const ent: Record<string, string> = Object.create(null) as Record<string, string>;
    for (;;) {
      const key = tokens.next();
      if (key.done) throw new EntityParseError(`unexpected end of entity string inside entity ${entities.length}`);
      if (startsWith(key.value, "}")) break;
      const value = tokens.next();
      if (value.done) throw new EntityParseError(`key "${key.value.text}" has no value`);
      if (startsWith(value.value, "}")) {
        throw new EntityParseError(`key "${key.value.text}" has no value at line ${value.value.line}`);
      }
      const name = asciiLower(key.value.text);
      delete ent[name];
      ent[name] = value.value.text;
    }
    entities.push(ent);
  }
  return entities;
}

/** Parse a "x y z" vector field. Returns undefined if absent or malformed. */
export function entityVec3(ent: BspEntity, key: string): [number, number, number] | undefined {
  const raw = ent[key];
  if (raw === undefined) return undefined;
  const parts = raw.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!];
}
