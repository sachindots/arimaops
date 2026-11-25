export interface PathBinding {
  "@path": string;
}

export interface NormalizedSurface {
  surfaceId: string;
  catalogId?: string;
  components: Record<string, unknown>[];
  dataModel: Record<string, unknown>;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isPathBinding(v: unknown): v is PathBinding {
  return isPlainObject(v) && typeof v["@path"] === "string" && Object.keys(v).length === 1;
}

/** Splits an RFC 6901 JSON pointer; returns null if relative or targeting prototype properties. */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) return null;
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.some((s) => UNSAFE_KEYS.has(s)) ? null : segments;
}

export function getPointer(data: unknown, pointer: string): unknown {
  const segs = parsePointer(pointer);
  if (!segs) return undefined;
  let cur: unknown = data;
  for (const seg of segs) {
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (isPlainObject(cur) && Object.prototype.hasOwnProperty.call(cur, seg)) {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setAt(node: Record<string, unknown>, segs: string[], depth: number, value: unknown): Record<string, unknown> {
  const seg = segs[depth]!;
  if (depth === segs.length - 1) {
    return { ...node, [seg]: value };
  }
  const existing = Object.prototype.hasOwnProperty.call(node, seg) && isPlainObject(node[seg]) ? node[seg] : {};
  return { ...node, [seg]: setAt(existing, segs, depth + 1, value) };
}

/** Immutably updates `pointer` while preserving object key insertion order. */
export function setPointer(data: Record<string, unknown>, pointer: string, value: unknown): Record<string, unknown> {
  const segs = parsePointer(pointer);
  if (!segs || segs.length === 0) return data;
  return setAt(data, segs, 0, value);
}

export function resolveValue(val: unknown, data: Record<string, unknown>): unknown {
  return isPathBinding(val) ? getPointer(data, val["@path"]) : val;
}

export function resolveActionContext(rawContext: unknown, data: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(rawContext)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawContext)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (isPathBinding(v)) {
      const resolved = getPointer(data, v["@path"]);
      out[k] = resolved === undefined ? null : resolved;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Normalizes either an A2UI v1.0 `createSurface` envelope or a raw FormSpec into surface components + dataModel. */
export function extractCreateSurface(input: unknown, fallbackSurfaceId = "surface"): NormalizedSurface | null {
  if (!isPlainObject(input)) return null;
  if (input.version === "1.0" && isPlainObject(input.createSurface)) {
    const cs = input.createSurface;
    if (!Array.isArray(cs.components) || cs.components.length === 0) return null;
    return {
      surfaceId: typeof cs.surfaceId === "string" ? cs.surfaceId : fallbackSurfaceId,
      catalogId: typeof cs.catalogId === "string" ? cs.catalogId : undefined,
      components: cs.components.filter(isPlainObject),
      dataModel: isPlainObject(cs.dataModel) ? cs.dataModel : {},
    };
  }
  if (Array.isArray(input.components) && input.components.length > 0) {
    return {
      surfaceId: fallbackSurfaceId,
      components: input.components.filter(isPlainObject),
      dataModel: isPlainObject(input.data) ? input.data : isPlainObject(input.dataModel) ? input.dataModel : {},
    };
  }
  return null;
}
