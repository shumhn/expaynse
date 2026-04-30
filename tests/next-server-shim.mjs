class ReadonlyHeadersAdapter {
  constructor(headers) {
    this._headers = headers;
  }

  get(name) {
    return this._headers.get(name);
  }

  has(name) {
    return this._headers.has(name);
  }

  entries() {
    return this._headers.entries();
  }

  keys() {
    return this._headers.keys();
  }

  values() {
    return this._headers.values();
  }

  [Symbol.iterator]() {
    return this._headers[Symbol.iterator]();
  }
}

class RequestCookies {
  constructor() {
    this._map = new Map();
  }

  get(name) {
    if (!this._map.has(name)) return undefined;
    return { name, value: this._map.get(name) };
  }

  getAll() {
    return Array.from(this._map.entries()).map(([name, value]) => ({
      name,
      value,
    }));
  }

  has(name) {
    return this._map.has(name);
  }

  set(name, value) {
    this._map.set(name, String(value));
  }

  delete(name) {
    this._map.delete(name);
  }

  clear() {
    this._map.clear();
  }

  toString() {
    return Array.from(this._map.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

export class NextRequest extends Request {
  constructor(input, init) {
    super(input, init);

    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input && typeof input.url === "string"
        ? input.url
        : "http://localhost/";

    this.nextUrl = new URL(url);
    this.cookies = new RequestCookies();
    this.page = undefined;
    this.ua = undefined;
    this.geo = {};
    this.ip = undefined;
  }
}

export class NextResponse extends Response {
  constructor(body, init) {
    super(body, init);
    this.cookies = new RequestCookies();
  }

  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }

    return new NextResponse(JSON.stringify(body), {
      ...init,
      headers,
    });
  }

  static redirect(url, init = 307) {
    const status = typeof init === "number" ? init : init.status || 307;
    const headers = new Headers(
      typeof init === "number" ? undefined : init.headers
    );
    headers.set("location", String(url));

    return new NextResponse(null, {
      ...(typeof init === "number" ? {} : init),
      status,
      headers,
    });
  }

  static next(init = {}) {
    return new NextResponse(null, init);
  }

  static rewrite(url, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("x-middleware-rewrite", String(url));

    return new NextResponse(null, {
      ...init,
      headers,
    });
  }
}

export function userAgent() {
  return {};
}

export function userAgentFromString() {
  return {};
}

export function after() {}

export async function connection() {
  return {};
}

export class ImageResponse extends Response {
  constructor(body = null, init = {}) {
    super(body, init);
  }
}

export const URLPattern = globalThis.URLPattern;

const nextServerShim = {
  NextRequest,
  NextResponse,
  userAgent,
  userAgentFromString,
  after,
  connection,
  ImageResponse,
  URLPattern,
  headers: ReadonlyHeadersAdapter,
};

export default nextServerShim;
