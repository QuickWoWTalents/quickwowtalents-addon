const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
  'true', 'until', 'while'
]);
const PARSED_LUA_KEY_KINDS = new WeakMap();

function rememberLuaKeyKinds(table, entries) {
  PARSED_LUA_KEY_KINDS.set(
    table,
    new Map(entries.map((entry) => [String(entry.key), entry.keyKind]))
  );
  return table;
}

class LuaParseError extends Error {
  constructor(message, token) {
    super(`${message} at ${token.line}:${token.column}.`);
    this.name = 'LuaParseError';
  }
}

function isIdentifierStart(character) {
  return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character) {
  return /[A-Za-z0-9_]/.test(character);
}

function tokenize(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Addon Lua must be a string.');
  }

  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const position = () => ({ line, column });
  const advance = () => {
    const character = text[index++];
    if (character === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return character;
  };
  const add = (type, value, start) => tokens.push({ type, value, ...start });

  while (index < text.length) {
    const character = text[index];
    if (/\s/.test(character)) {
      advance();
      continue;
    }

    if (character === '-' && text[index + 1] === '-') {
      while (index < text.length && text[index] !== '\n') advance();
      continue;
    }

    const start = position();
    if ('{}[]=,'.includes(character)) {
      add(character, character, start);
      advance();
      continue;
    }

    if (character === '"') {
      advance();
      let value = '';
      let closed = false;
      while (index < text.length) {
        const current = advance();
        if (current === '"') {
          closed = true;
          break;
        }
        if (current === '\n' || current === '\r') {
          throw new LuaParseError('Unterminated string', { ...start });
        }
        if (current !== '\\') {
          value += current;
          continue;
        }

        if (index >= text.length) {
          throw new LuaParseError('Unterminated string escape', { ...start });
        }
        const escaped = advance();
        const escapes = { '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' };
        if (!Object.hasOwn(escapes, escaped)) {
          throw new LuaParseError(`Unsupported string escape \\${escaped}`, { ...start });
        }
        value += escapes[escaped];
      }
      if (!closed) throw new LuaParseError('Unterminated string', { ...start });
      add('string', value, start);
      continue;
    }

    const numberMatch = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d+)?/);
    if (numberMatch && (/[0-9]/.test(character) || (character === '-' && /[0-9]/.test(text[index + 1])))) {
      const raw = numberMatch[0];
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new LuaParseError('Numbers must be finite', { ...start });
      }
      for (let consumed = 0; consumed < raw.length; consumed += 1) advance();
      add('number', value, start);
      continue;
    }

    if (isIdentifierStart(character)) {
      let value = advance();
      while (index < text.length && isIdentifierPart(text[index])) value += advance();
      add('identifier', value, start);
      continue;
    }

    throw new LuaParseError(`Unexpected character ${JSON.stringify(character)}`, start);
  }

  tokens.push({ type: 'eof', value: null, line, column });
  return tokens;
}

class Parser {
  constructor(text) {
    this.tokens = tokenize(text);
    this.index = 0;
  }

  current() {
    return this.tokens[this.index];
  }

  next() {
    return this.tokens[this.index + 1];
  }

  take(type, message) {
    const token = this.current();
    if (token.type !== type) throw new LuaParseError(message ?? `Expected ${type}`, token);
    this.index += 1;
    return token;
  }

  parse() {
    const root = this.take('identifier', 'Expected QuickWoWTalentsData root assignment');
    if (root.value !== 'QuickWoWTalentsData') {
      throw new LuaParseError('Expected QuickWoWTalentsData root assignment', root);
    }
    this.take('=', 'Expected = after QuickWoWTalentsData');
    if (this.current().type !== '{') {
      throw new LuaParseError('QuickWoWTalentsData root must be a table', this.current());
    }
    const data = this.parseTable(true);
    if (this.current().type !== 'eof') {
      throw new LuaParseError('Unexpected trailing content', this.current());
    }
    return data;
  }

  parseTable(forceObject = false) {
    this.take('{');
    const entries = [];
    const luaKeys = new Set();
    const objectKeys = new Set();
    let implicitIndex = 1;

    const addEntry = (key, value, keyKind, token) => {
      const luaKey = `${typeof key}:${String(key)}`;
      if (luaKeys.has(luaKey)) throw new LuaParseError(`Duplicate key ${JSON.stringify(key)}`, token);
      luaKeys.add(luaKey);

      const objectKey = String(key);
      if (objectKeys.has(objectKey)) {
        throw new LuaParseError(`Ambiguous table keys cannot share ${JSON.stringify(objectKey)}`, token);
      }
      objectKeys.add(objectKey);
      entries.push({ key, value, keyKind, implicit: keyKind === 'implicit' });
    };

    if (this.current().type === '}') {
      this.index += 1;
      return rememberLuaKeyKinds(forceObject ? {} : [], []);
    }

    while (true) {
      const token = this.current();
      let key;
      let keyKind;

      if (token.type === 'identifier' && this.next().type === '=') {
        if (LUA_KEYWORDS.has(token.value)) {
          throw new LuaParseError(`Lua keyword ${JSON.stringify(token.value)} cannot be a bare table key`, token);
        }
        key = token.value;
        keyKind = 'identifier';
        this.index += 2;
      } else if (token.type === '[') {
        this.index += 1;
        const keyToken = this.current();
        if (keyToken.type !== 'string' && keyToken.type !== 'number') {
          throw new LuaParseError('Table keys must be strings or finite numbers', keyToken);
        }
        key = keyToken.value;
        keyKind = keyToken.type;
        this.index += 1;
        this.take(']', 'Expected ] after table key');
        this.take('=', 'Expected = after table key');
      } else {
        key = implicitIndex;
        implicitIndex += 1;
        keyKind = 'implicit';
      }

      addEntry(key, this.parseValue(), keyKind, token);

      if (this.current().type === '}') {
        this.index += 1;
        break;
      }
      if (this.current().type !== ',') {
        throw new LuaParseError('Expected comma separator or } after table entry', this.current());
      }
      this.index += 1;
      if (this.current().type === '}') {
        throw new LuaParseError('Trailing table separator is not allowed', this.current());
      }
    }

    if (!forceObject && entries.every((entry) => entry.implicit)) {
      return rememberLuaKeyKinds(entries.map((entry) => entry.value), entries);
    }

    const result = {};
    for (const entry of entries) {
      Object.defineProperty(result, String(entry.key), {
        configurable: true,
        enumerable: true,
        value: entry.value,
        writable: true
      });
    }
    return rememberLuaKeyKinds(result, entries);
  }

  parseValue() {
    const token = this.current();
    if (token.type === '{') return this.parseTable();
    if (token.type === 'string' || token.type === 'number') {
      this.index += 1;
      return token.value;
    }
    if (token.type === 'identifier') {
      this.index += 1;
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'nil') return null;
    }
    throw new LuaParseError('Expected a generated Lua value', token);
  }
}

/**
 * Parses generated QuickWoWTalents Lua without evaluating it.
 *
 * The generated subset cannot distinguish an empty array-like table from an
 * empty keyed table. This API returns {} for the root table and [] for every
 * nested empty table; later schema validation supplies the field context.
 */
export function parseAddonLua(text) {
  return new Parser(text).parse();
}

/**
 * Returns the original Lua key token kind without changing parsed values.
 * Parsed table metadata is held weakly and is not enumerable at runtime.
 */
export function getParsedLuaKeyKind(table, key) {
  if ((typeof table !== 'object' && typeof table !== 'function') || table === null) return null;
  return PARSED_LUA_KEY_KINDS.get(table)?.get(String(key)) ?? null;
}
