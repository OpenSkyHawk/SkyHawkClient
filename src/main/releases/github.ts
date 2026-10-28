// GitHub, as the release check reaches it (#192): unauthenticated requests over the fetch port
// main/app injects (Electron's `net.fetch`; a fake GitHub in the tests), each with a timeout run on
// the app's own timers.
//
// A check costs one API request, the releases list. The manifest and the zip are asset downloads,
// which GitHub doesn't count against the API limit.

/** Port: `fetch`, as Electron's `net.fetch` and the global one take it. */
export type FetchPort = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<Response>

/** How long the releases list or a manifest may take. */
export const CHECK_TIMEOUT_MS = 15_000
/** How long a zip download may take. */
export const DOWNLOAD_TIMEOUT_MS = 120_000
/** A manifest is a few KB; anything far bigger is not one. */
const MANIFEST_MAX_BYTES = 1_000_000

/** The API's media type (GitHub asks for it). */
const API_ACCEPT = 'application/vnd.github+json'

/** Why a request gave no answer to use. */
export class FetchFailed extends Error {
  constructor(
    message: string,
    /** GitHub's answer, when there was one. */
    readonly status?: number
  ) {
    super(message)
  }
}

/** GitHub's limit for unauthenticated requests was reached; it resets at `retryAt`. */
export class RateLimited extends Error {
  constructor(readonly retryAt: number) {
    super('GitHub’s limit for checks was reached')
  }
}

export class GitHub {
  constructor(
    private readonly fetch: FetchPort,
    /** GitHub requires a User-Agent. */
    private readonly userAgent: () => string
  ) {}

  /** One request, aborted after `ms` on the app's timers; `read` consumes the body in time. */
  private async request<T>(
    url: string,
    accept: string,
    ms: number,
    read: (res: Response, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), ms)
    try {
      const res = await this.fetch(url, {
        headers: { 'User-Agent': this.userAgent(), Accept: accept },
        signal: ctl.signal
      })
      return await read(res, ctl.signal)
    } catch (err) {
      if (err instanceof FetchFailed || err instanceof RateLimited) throw err
      throw new FetchFailed(
        ctl.signal.aborted ? 'GitHub didn’t answer in time' : 'GitHub couldn’t be reached'
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /** The releases list, as GitHub's JSON. */
  releases(url: string): Promise<unknown> {
    return this.request(url, API_ACCEPT, CHECK_TIMEOUT_MS, async (res) => {
      const remaining = res.headers.get('x-ratelimit-remaining')
      if ((res.status === 403 || res.status === 429) && remaining === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset'))
        throw new RateLimited(Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now())
      }
      if (!res.ok) throw new FetchFailed(`GitHub answered ${res.status}`, res.status)
      return (await res.json()) as unknown
    })
  }

  /** A release asset's text (the manifest). */
  async text(url: string): Promise<string> {
    const bytes = await this.request(url, 'application/octet-stream', CHECK_TIMEOUT_MS, (res) =>
      body(res, MANIFEST_MAX_BYTES, false)
    )
    return Buffer.from(bytes).toString('utf8')
  }

  /**
   * A release asset's bytes, exactly `size` of them: a download that ends early (cut off) or runs
   * past its size is refused.
   */
  bytes(url: string, size: number): Promise<Uint8Array> {
    return this.request(url, 'application/octet-stream', DOWNLOAD_TIMEOUT_MS, (res) =>
      body(res, size, true)
    )
  }
}

/** The response body, at most `max` bytes; `exact`: exactly `max`. */
async function body(res: Response, max: number, exact: boolean): Promise<Uint8Array> {
  if (!res.ok) throw new FetchFailed(`GitHub answered ${res.status}`, res.status)
  if (!res.body) throw new FetchFailed('the download was empty')
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > max) throw new FetchFailed('the download is bigger than the manifest says')
      chunks.push(value)
    }
  } catch (err) {
    void reader.cancel().catch(() => {})
    if (err instanceof FetchFailed) throw err
    throw new FetchFailed('the download was cut off')
  }
  if (exact && total !== max) throw new FetchFailed('the download was cut off')
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
