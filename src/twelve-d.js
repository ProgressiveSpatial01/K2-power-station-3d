// twelve-d.js — parser for 12d Model's ".12da" ASCII archive export format
// (and its zipped ".12daz" wrapper), targeting the "string" primitive with
// 3D chainage data as used for underground services.
//
// Format notes, learned from a real sample export (Sample 12d Pipe.12daz,
// 12d Model 15.0C1v, K2 Power Station Services, 2026-08-24) rather than
// from any 12d format spec — treat as validated-against-one-example, not
// authoritative for every 12d export variant:
//
//  - File is UTF-16 text (with BOM), NOT UTF-8. A naive UTF-8 read
//    produces garbage (every char interleaved with a null byte).
//  - .12daz is a plain ZIP containing exactly one .12da entry in this
//    sample. Not assumed to generalise to multi-entry archives.
//  - Grammar is nested `key value` / `key { ... }` blocks, comments start
//    with `//`. A block key can carry a "subtype" tag before the brace,
//    e.g. `string super { ... }`.
//  - `data_3d { }` contains raw rows of 3 numbers (easting, northing,
//    elevation in GDA2020/MGA50 + AHD, matching the project CRS) — NOT
//    just two endpoint inverts. This is real per-vertex surveyed depth,
//    which is *better* than the brief's assumed "upstream/downstream IL"
//    model, not a fallback case of it.
//  - `pipe_value { diameter <m> }` gives pipe/conduit diameter.
//  - `justify top|centre|invert` tells you what the given Z represents:
//    the sample used `justify top`, i.e. Z is the TOP of the pipe, so
//    true centreline = Z - diameter/2. Get this wrong and every service
//    ends up half a diameter too deep or shallow — validate against a
//    known invert if Cameron has one to check against.
//
// This module deliberately only implements what's needed to reproduce
// the sample file's structure. If a real K2 export has richer pipe
// attributes (material, node IL, grade) not seen here, extend the
// generic block parser below rather than special-casing — it already
// captures arbitrary key/value pairs into plain objects.

// --- Tokenizer ------------------------------------------------------------

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "{" || c === "}") {
      tokens.push({ type: "BRACE", value: c });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < n && text[j] !== '"') {
        s += text[j];
        j++;
      }
      tokens.push({ type: "STRING", value: s });
      i = j + 1;
      continue;
    }
    // Bare atom: run until whitespace or brace or quote.
    let j = i;
    while (j < n && !/[\s{}"]/.test(text[j])) j++;
    tokens.push({ type: "ATOM", value: text.slice(i, j) });
    i = j;
  }
  return tokens;
}

// --- Generic block parser ---------------------------------------------

function setKey(obj, key, value) {
  if (!(key in obj)) {
    obj[key] = value;
  } else if (Array.isArray(obj[key])) {
    obj[key].push(value);
  } else {
    obj[key] = [obj[key], value];
  }
}

function parseBlock(tokens, pos) {
  const result = {};
  while (pos.i < tokens.length && tokens[pos.i].value !== "}") {
    const keyTok = tokens[pos.i++];
    if (keyTok.type !== "ATOM") {
      throw new Error(`12da parse error: expected key, got ${JSON.stringify(keyTok)}`);
    }
    const key = keyTok.value;

    if (key === "data_3d") {
      expectBrace(tokens, pos, "{");
      const rows = [];
      let row = [];
      while (pos.i < tokens.length && tokens[pos.i].value !== "}") {
        const t = tokens[pos.i++];
        const num = Number(t.value);
        if (Number.isNaN(num)) {
          throw new Error(`12da parse error: expected number in data_3d, got "${t.value}"`);
        }
        row.push(num);
        if (row.length === 3) {
          rows.push(row);
          row = [];
        }
      }
      expectBrace(tokens, pos, "}");
      setKey(result, key, rows);
      continue;
    }

    const t1 = tokens[pos.i];
    if (t1 && t1.type === "BRACE" && t1.value === "{") {
      pos.i++;
      const value = parseBlock(tokens, pos);
      expectBrace(tokens, pos, "}");
      setKey(result, key, value);
      continue;
    }
    if (
      t1 &&
      t1.type === "ATOM" &&
      tokens[pos.i + 1] &&
      tokens[pos.i + 1].type === "BRACE" &&
      tokens[pos.i + 1].value === "{"
    ) {
      const subtype = t1.value;
      pos.i += 2;
      const value = parseBlock(tokens, pos);
      expectBrace(tokens, pos, "}");
      value.__subtype = subtype;
      setKey(result, key, value);
      continue;
    }
    // Scalar value.
    const valTok = tokens[pos.i++];
    setKey(result, key, valTok.value);
  }
  return result;
}

function expectBrace(tokens, pos, value) {
  const t = tokens[pos.i];
  if (!t || t.type !== "BRACE" || t.value !== value) {
    throw new Error(`12da parse error: expected "${value}", got ${JSON.stringify(t)}`);
  }
  pos.i++;
}

function ensureArray(x) {
  if (x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

/** justify -> fraction of diameter to ADD to the given Z to reach centreline. */
const JUSTIFY_TO_CENTRE_OFFSET = {
  top: (d) => -d / 2,
  crown: (d) => -d / 2,
  centre: () => 0,
  center: () => 0,
  invert: (d) => d / 2,
  bottom: (d) => d / 2,
};

/**
 * Parse decoded 12da text into a flat list of service-string records.
 * @param {string} text - UTF-8 text (already decoded from UTF-16)
 * @returns {Array<{
 *   name: string, style: string|null, colour: string|null, closed: boolean,
 *   justify: string|null, diameter: number|null,
 *   points: Array<[number, number, number]>,   // raw [E, N, Z] as given
 *   centrelinePoints: Array<[number, number, number]>, // justify-corrected
 *   raw: object
 * }>}
 */
export function parse12da(text) {
  const tokens = tokenize(text);
  const pos = { i: 0 };
  const top = parseBlock(tokens, pos);

  const strings = ensureArray(top.string);
  return strings.map((s) => {
    const diameter = s.pipe_value ? Number(s.pipe_value.diameter) : null;
    const justify = s.justify ?? null;
    const points = (s.data_3d ?? []).map(([e, n, z]) => [e, n, z]);

    let centrelinePoints = points;
    if (diameter != null && justify && JUSTIFY_TO_CENTRE_OFFSET[justify]) {
      const dz = JUSTIFY_TO_CENTRE_OFFSET[justify](diameter);
      centrelinePoints = points.map(([e, n, z]) => [e, n, z + dz]);
    } else if (diameter != null && justify) {
      console.warn(`[12da] Unknown justify "${justify}" — treating Z as centreline as-is.`);
    }

    return {
      name: s.name ?? null,
      style: s.style ?? null,
      colour: s.colour ?? null,
      closed: s.closed === "1" || s.closed === 1,
      justify,
      diameter,
      points,
      centrelinePoints,
      raw: s,
    };
  });
}

// --- File loading (.12da direct, .12daz zipped) --------------------------

/**
 * Load a File (.12da or .12daz) from a file input and return parsed records.
 * @param {File} file
 */
export async function loadTwelveDaFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b; // "PK"
  const twelveDaBytes = isZip ? await extractFirstZipEntry(buf) : buf;
  const text = decodeUtf16(twelveDaBytes);
  return parse12da(text);
}

function decodeUtf16(bytes) {
  // TextDecoder("utf-16le") auto-detects and strips a matching BOM per
  // the WHATWG Encoding spec; if a real export ever comes through as
  // UTF-16BE this will visibly produce garbage (not silently wrong
  // numbers), since tokenize() will then fail to find recognisable
  // ATOM/BRACE structure.
  return new TextDecoder("utf-16le").decode(bytes);
}

/**
 * Minimal ZIP reader: extracts the bytes of the first local file entry.
 * Supports only "stored" (method 0) and "deflate" (method 8) — enough
 * for 12d's own single-entry .12daz exports. Not a general-purpose ZIP
 * implementation; throws rather than guessing on anything else.
 */
async function extractFirstZipEntry(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const SIG = 0x04034b50;
  if (dv.getUint32(0, true) !== SIG) {
    throw new Error("Not a valid ZIP local file header at offset 0.");
  }
  const method = dv.getUint16(8, true);
  const compSize = dv.getUint32(18, true);
  const nameLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const dataStart = 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + compSize);

  if (method === 0) return compressed;
  if (method === 8) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([compressed]).stream().pipeThrough(ds);
    const arrayBuf = await new Response(stream).arrayBuffer();
    return new Uint8Array(arrayBuf);
  }
  throw new Error(
    `Unsupported ZIP compression method ${method} — only stored(0)/deflate(8) handled.`
  );
}
