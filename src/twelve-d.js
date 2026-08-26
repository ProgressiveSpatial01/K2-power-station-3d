// twelve-d.js — parser for 12d Model's ".12da" ASCII archive export format
// (and its zipped ".12daz" wrapper). Handles two structurally different
// top-level primitives: `string` (3D chainage data, used for underground
// services and design linework) and `full_tin` (a triangulated surface —
// see parse12da()'s full_tin notes for its very different point-encoding
// and structure).
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

/**
 * Parse one `key value` / `key { ... }` / `key subtype { ... }` statement
 * at the current position. Shared by parseBlock() (unordered accumulation
 * into an object, used for a string's own body) and parse12da()'s
 * top-level loop (which needs document ORDER preserved — see the
 * `model "..."` tracking note below, lost by naive accumulation).
 * @returns {{ key: string, value: * }}
 */
// Known 12d "typed attribute" tags: `text "name" "value"` / `real "name" 0` /
// `integer "name" 5` — a 3-token statement (type tag, quoted name, value),
// found 2026-08-26 inside `attributes { ... }` / `group { ... }` blocks in a
// real 800-string weekly export (not present in the earlier small sample).
// Distinguished from the normal 2-token `key value` form by keyTok being one
// of these specific tags AND the immediately following token being a quoted
// name — a real `key` is never itself one of these words followed by a
// second value token. We don't currently read any of these attributes
// (asset owner, survey type, SDR setup, etc. — all several layers deep in
// `attributes`/`group` nesting parse12da() never looks inside), so the
// attribute's type is discarded and only {name: value} is kept — enough to
// parse correctly without crashing, not enough to claim we use this data.
const TYPED_ATTRIBUTE_TAGS = new Set(["text", "real", "integer"]);

function parseStrictNumber(str) {
  const num = Number(str);
  if (Number.isNaN(num)) {
    throw new Error(`12da parse error: expected number, got "${str}"`);
  }
  return num;
}

// C99 hex-float literal, e.g. "0x1.7593eff21e508p+18" or "0x0.0p+0" — the
// encoding a real `full_tin { points { ... } } }` block uses for its
// coordinates when the export has `output_tin_hex_floats true` set (found
// 2026-08-26, "FL Surface.12daz" — a real 12d surface/TIN sample, the
// first one seen; see parse12da()'s full_tin notes below). This is C's
// `%a` printf format (exact base-2 float representation, no decimal
// rounding), NOT JavaScript's `0x` hex-INTEGER syntax — Number() silently
// mis-parses it (stops at the first non-hex-digit, i.e. the ".", giving a
// truncated integer), so it needs its own decoder rather than reusing
// parseStrictNumber. Falls back to a plain decimal parse for anything that
// doesn't match, in case a differently-configured export ever gives plain
// decimal points instead (untested — no such sample seen yet).
function parseHexOrDecimalNumber(str) {
  const m = /^(-)?0x([0-9a-fA-F]+)\.([0-9a-fA-F]+)p([+-]?\d+)$/i.exec(str);
  if (!m) return parseStrictNumber(str);
  const [, sign, intHex, fracHex, expStr] = m;
  const intPart = parseInt(intHex, 16);
  const fracPart = parseInt(fracHex, 16) / Math.pow(16, fracHex.length);
  const value = (intPart + fracPart) * Math.pow(2, parseInt(expStr, 10));
  return sign ? -value : value;
}

function readNumberRow(tokens, pos, rowLength, parseNum = parseStrictNumber) {
  expectBrace(tokens, pos, "{");
  const rows = [];
  let row = [];
  while (pos.i < tokens.length && tokens[pos.i].value !== "}") {
    const t = tokens[pos.i++];
    row.push(parseNum(t.value));
    if (row.length === rowLength) {
      rows.push(row);
      row = [];
    }
  }
  expectBrace(tokens, pos, "}");
  return rows;
}

// Same idea as readNumberRow but for blocks that are one bare flat list of
// numbers with no row grouping, e.g. `full_tin`'s `nulling { 2 1 1 ... }`
// (one flag per triangle, not grouped in triples like `triangles`/`points`).
function readFlatNumberList(tokens, pos, parseNum = parseStrictNumber) {
  expectBrace(tokens, pos, "{");
  const list = [];
  while (pos.i < tokens.length && tokens[pos.i].value !== "}") {
    list.push(parseNum(tokens[pos.i++].value));
  }
  expectBrace(tokens, pos, "}");
  return list;
}

function parseStatement(tokens, pos) {
  const keyTok = tokens[pos.i++];
  if (keyTok.type !== "ATOM") {
    throw new Error(`12da parse error: expected key, got ${JSON.stringify(keyTok)}`);
  }
  const key = keyTok.value;

  if (key === "data_3d") {
    return { key, value: readNumberRow(tokens, pos, 3) };
  }
  if (key === "data_2d") {
    // 2D-only points (symbol pickups etc. with no elevation) — not used by
    // parse12da()'s output today, kept only so parsing doesn't corrupt on it.
    return { key, value: readNumberRow(tokens, pos, 2) };
  }
  // `full_tin { ... }` sub-blocks (see parse12da()'s full_tin notes below).
  // "points" needs the hex-float decoder; "triangles"/"neighbours" (vertex
  // indices, 1-based) and "nulling" (a flag per triangle) are plain decimal
  // ints, same as everywhere else in the format.
  if (key === "points") {
    return { key, value: readNumberRow(tokens, pos, 3, parseHexOrDecimalNumber) };
  }
  if (key === "triangles" || key === "neighbours") {
    return { key, value: readNumberRow(tokens, pos, 3) };
  }
  if (key === "nulling") {
    return { key, value: readFlatNumberList(tokens, pos) };
  }

  if (TYPED_ATTRIBUTE_TAGS.has(key) && tokens[pos.i]?.type === "STRING") {
    const nameTok = tokens[pos.i++];
    const valTok = tokens[pos.i++];
    return { key: nameTok.value, value: valTok.value };
  }

  const t1 = tokens[pos.i];
  if (t1 && t1.type === "BRACE" && t1.value === "{") {
    pos.i++;
    const value = parseBlock(tokens, pos);
    expectBrace(tokens, pos, "}");
    return { key, value };
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
    return { key, value };
  }
  // Scalar value.
  const valTok = tokens[pos.i++];
  return { key, value: valTok.value };
}

function parseBlock(tokens, pos) {
  // Some blocks (e.g. `point_data { "0013" "0014" ... }`, a flat list of
  // vertex/point ids — found 2026-08-26 in a real weekly export) are NOT
  // key/value pairs at all, just a bare sequence of quoted strings. Detect
  // this by peeking: a real key is always an ATOM: if the first token in
  // the block is a STRING instead, treat the whole block as a plain list.
  if (tokens[pos.i] && tokens[pos.i].type === "STRING") {
    const list = [];
    while (pos.i < tokens.length && tokens[pos.i].value !== "}") {
      list.push(tokens[pos.i++].value);
    }
    return list;
  }

  const result = {};
  while (pos.i < tokens.length && tokens[pos.i].value !== "}") {
    const { key, value } = parseStatement(tokens, pos);
    setKey(result, key, value);
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
 *
 * IMPORTANT — `model` grouping (found 2026-08-26, a real 800-string
 * weekly export, not the earlier 2-string sample): a real 12d export
 * declares `model "path/like/this"` as a bare top-level statement, NOT
 * a block — everything doesn't nest inside it. Every `string` statement
 * that follows belongs to whichever `model` was most recently declared,
 * until the next `model` line. This top-level sequence therefore can't
 * use parseBlock()'s unordered key/value accumulation (which would just
 * merge every `model` declaration into one array, losing which strings
 * went with which) — it needs a dedicated ordered loop instead. In the
 * real weekly file this `model` grouping is far more useful than
 * `style`: 734 of 800 real strings just have `style: "1"`, while `model`
 * gives real discipline categories (Sewer, Water, Power/High Voltage,
 * Power/Low Voltage, Drainage, Communications, Earthing, Gas, Fuel
 * Line, Unknown). Both are exposed; callers grouping the sidebar should
 * prefer `model` over `style` where present.
 *
 * The returned array also carries a non-enumerable-looking but perfectly
 * normal extra property, `unrecognizedTopLevelKeys` (a `Set<string>`) —
 * every top-level key seen that wasn't `model`, `string`, or `full_tin`.
 * Callers can use this to tell "genuinely empty file" apart from "this
 * file has content, just not a kind we handle yet" — see main-2d.js's
 * design upload for why that distinction matters (silently rendering
 * nothing for an unsupported block would look like a bug, not an
 * unimplemented format).
 *
 * It also carries `surfaces` — see the `full_tin` notes below — an array
 * of parsed TIN/surface records, separate from the line-string `records`
 * array itself (a file can in principle contain both).
 *
 * ---
 *
 * **`full_tin { ... }` (surfaces/TIN)** — found 2026-08-26 against the
 * first real surface sample, "FL Surface.12daz" (a 12d "Quick Tin" test
 * export). Structurally very different from a `string`: a top-level
 * `full_tin { ... }` block (not a bare statement like `model`) containing
 * `points { }` (one E N Z per point — see `parseHexOrDecimalNumber` for
 * why these need their own decoder), `triangles { }` (one 1-based point
 * -index triple per triangle), `neighbours { }` (adjacent-triangle
 * indices — not used, kept only so parsing doesn't choke on it), and
 * `nulling { }` (one flag per triangle, flat list, NOT grouped in 3s).
 *
 * **The `nulling` flag's meaning isn't documented anywhere findable — its
 * use below is inferred from this one sample's actual geometry, not from
 * a 12d spec.** The sample has 8 points: 4 form a ~4.5km rectangle at flat
 * RL 0 (12d's automatic "quick tin" bounding box, added because the real
 * data was too sparse to triangulate alone — a real, well-known 12d
 * behaviour, not real design data), and 4 cluster tightly at the actual
 * K2 site with real elevations (RL 6.3-7.5m). Of the 10 triangles, the
 * exactly 2 built ONLY from the 4 real points have `nulling: 2`; all 8
 * touching a bounding-rectangle corner have `nulling: 1` — a clean split
 * that lines up with "1 = auto-bounding scaffold, exclude" / "2 = real
 * design data, keep". `buildSurfaceFeaturesFrom12d()` in main-2d.js
 * filters out `nulling === 1` on this basis. **Ask Cameron to confirm**
 * before trusting this on a second, differently-shaped surface export —
 * if a future file's nulling values don't split cleanly the same way,
 * this inference doesn't generalise.
 *
 * @param {string} text - UTF-8 text (already decoded from UTF-16)
 * @returns {Array<{
 *   model: string|null, name: string, style: string|null, colour: string|null,
 *   closed: boolean, justify: string|null, diameter: number|null,
 *   points: Array<[number, number, number]>,   // raw [E, N, Z] as given
 *   centrelinePoints: Array<[number, number, number]>, // justify-corrected
 *   raw: object
 * }> & {
 *   unrecognizedTopLevelKeys: Set<string>,
 *   surfaces: Array<{
 *     model: string|null, name: string|null, colour: string|null,
 *     points: Array<[number, number, number]>, // [E, N, Z], 0-based index
 *     triangles: Array<[number, number, number]>, // 0-based point indices
 *     nulling: number[], // one flag per triangle, see notes above
 *     raw: object
 *   }>
 * }}
 */
export function parse12da(text) {
  const tokens = tokenize(text);
  const pos = { i: 0 };

  const strings = [];
  const tins = [];
  const unrecognizedTopLevelKeys = new Set();
  let currentModel = null;
  while (pos.i < tokens.length) {
    const { key, value } = parseStatement(tokens, pos);
    if (key === "model") {
      currentModel = value; // scalar string
    } else if (key === "string") {
      strings.push({ ...value, __model: currentModel });
    } else if (key === "full_tin") {
      tins.push({ ...value, __model: currentModel });
    } else {
      unrecognizedTopLevelKeys.add(key);
    }
  }

  const surfaces = tins.map((t) => ({
    model: t.__model,
    name: t.name ?? null,
    colour: t.colour ?? null,
    points: t.points ?? [],
    // File uses 1-based point indices; normalise to 0-based here so
    // callers can index straight into `points` like everywhere else in JS.
    triangles: (t.triangles ?? []).map(([a, b, c]) => [a - 1, b - 1, c - 1]),
    nulling: t.nulling ?? [],
    raw: t,
  }));

  const records = strings.map((s) => {
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
      model: s.__model,
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

  records.unrecognizedTopLevelKeys = unrecognizedTopLevelKeys;
  records.surfaces = surfaces;
  return records;
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

// --- Gap splitting (2026-08-26) --------------------------------------

/**
 * Split a polyline's points into multiple sub-polylines wherever a
 * consecutive gap is both absolutely large AND dramatically larger than
 * that record's own typical vertex spacing.
 *
 * Needed because a real 800-record weekly export bundles multiple
 * physically separate features into ONE `string` record's `data_3d`,
 * with no marker of where one ends and the next begins — found by
 * inspecting a "power mh" record with 205 points: it decomposed into
 * ~30 clusters of ~8 points each (each cluster a small manhole rim
 * outline, <1m across), linked by large jumps (17-133m) to the next
 * manhole's cluster. Rendered as one continuous line, this draws long
 * spurious lines connecting unrelated manholes — reported by Cameron as
 * "pits seem to be joining up."
 *
 * *** CORRECTION 2026-08-26: a flat distance threshold does NOT work ***
 * The first version of this function split on ANY gap over 3m,
 * validated only against the giant concatenated-pit records. Cameron
 * then compared the 3D scene against the same file opened in real 12d
 * and found a dense, continuous network there vs. scattered fragments
 * in ours — a real regression, not a framing/zoom difference. Re-checked
 * against ordinary pipe/cable records ("COMMS UG PIPE 100", "earth ug
 * line") and found their NORMAL, legitimate vertex-to-vertex spacing is
 * 3-25m — well past the 3m threshold, so real continuous alignments were
 * being shattered into isolated single points and vanishing entirely.
 * Worse, the two cases genuinely overlap in absolute terms: one
 * concatenated-manhole record's smallest between-cluster jump (16.2m)
 * is SMALLER than one legitimate single alignment's largest real gap
 * (17.4m) — no fixed distance cutoff can separate them.
 *
 * What actually distinguishes the two cases is RELATIVE, not absolute:
 * a concatenated-pits record has many tiny gaps (<1m, one pit's own rim)
 * and a few huge jumps (tens-to-hundreds of metres) to the next pit —
 * an extreme ratio. A genuine pipe alignment has fairly uniform,
 * moderate gaps throughout — nothing wildly out of line with the rest
 * of that same record. So a gap only counts as a split point if it's
 * BOTH more than `absoluteThresholdM` AND more than `relativeMultiplier`
 * times the LOCAL median gap (see recursion note below). Re-verified
 * against both failure modes: "COMMS UG PIPE 100" (gaps 5.4-24.9m,
 * median ~16.5m) and "earth ug line" (gaps 1.0-13.2m, median ~3.9m) now
 * correctly stay as one segment each; "power mh" (205 points) and
 * "comms manhole" (29 points, tiny ~0.5m clusters split by 16-182m
 * jumps) still correctly split apart.
 *
 * *** CORRECTION 2026-08-26, later same day: one global median per
 * record isn't always enough either ***. Cameron: "still a few rogue
 * pits joining up" after the fix above. A record with more than one
 * genuine scale of clustering (e.g. some pits 0.5m apart internally,
 * others 1m apart, mixed with the real jumps between them) can end up
 * with a single record-wide median that doesn't cleanly separate every
 * jump from every cluster's own internal spacing. Fixed by finding and
 * splitting at the SINGLE WORST outlier gap first, then recursing into
 * each half with its OWN freshly-computed local median — rather than
 * measuring every gap against one global baseline in a single pass,
 * this re-establishes "what's normal here" after every split, so a
 * record with several different internal scales gets fully resolved
 * instead of just its single largest jump.
 *
 * @param {Array<[number, number, number]>} points
 * @param {{ absoluteThresholdM?: number, relativeMultiplier?: number }} [opts]
 * @returns {Array<Array<[number, number, number]>>} one or more segments
 */
export function splitOnGaps(points, opts = {}) {
  const { absoluteThresholdM = 3, relativeMultiplier = 8 } = opts;
  if (points.length === 0) return [];
  return splitOnWorstOutlier(points, absoluteThresholdM, relativeMultiplier);
}

function splitOnWorstOutlier(points, absoluteThresholdM, relativeMultiplier) {
  if (points.length <= 2) return [points]; // nothing to compare a single gap's ratio against

  const dists = [];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    dists.push(Math.hypot(x2 - x1, y2 - y1));
  }
  const sorted = [...dists].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  let worstIdx = 0;
  for (let i = 1; i < dists.length; i++) {
    if (dists[i] > dists[worstIdx]) worstIdx = i;
  }

  const isSplit = dists[worstIdx] > absoluteThresholdM && dists[worstIdx] > median * relativeMultiplier;
  if (!isSplit) return [points];

  const left = points.slice(0, worstIdx + 1);
  const right = points.slice(worstIdx + 1);
  return [
    ...splitOnWorstOutlier(left, absoluteThresholdM, relativeMultiplier),
    ...splitOnWorstOutlier(right, absoluteThresholdM, relativeMultiplier),
  ];
}
