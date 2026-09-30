/**
 * NodeAgent — reads a remote Spark's metrics from its sparkdash-agent over
 * HTTP instead of running shell commands over SSH.
 *
 * Why: through Tailscale SSH every sshExec is a fresh login session. At the
 * default cadence that was ~2.6 sessions/s across two Sparks, and each session
 * made polkitd leak (≈1 GiB/day per node — GPU memory on a GB10). The agent
 * reads /proc, /sys and NVML in-process and answers one GET per poll.
 *
 * Config (config/sparks.json):
 *   "agent": { "url": "http://192.168.1.116:9110" }
 * Token: SPARKDASH_AGENT_TOKEN (the same token on every agent).
 *
 * One snapshot serves every collector domain: concurrent callers share the
 * in-flight request, and a result is reused for SNAPSHOT_TTL_MS, so the GPU,
 * CPU, RAM, network and memory pollers cost one request per ~second together.
 * When the agent is down the collectors report their defaults (the Spark shows
 * offline); they never fall back to SSH.
 */
import { isAllowedTargetHost } from "../validate.js";

export const SNAPSHOT_TTL_MS = 900;
const TIMEOUT_MS = 3000;

/**
 * Validate and normalize a spark's `agent` config. Returns `{ url }` or null.
 * @param {unknown} value
 */
export function normalizeAgentConfig(value) {
  if (!value || typeof value !== "object") return null;
  const raw = /** @type {{ url?: unknown }} */ (value).url;
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!isAllowedTargetHost(host)) return null;
  if (url.username || url.password) return null;
  return { url: `${url.protocol}//${url.host}` };
}

/**
 * Shrink agent history to at most `maxPoints` buckets for a chart. Each bucket
 * keeps its lowest MemAvailable and highest watched RSS, so dips toward the
 * memory floor and leak growth survive the downsampling.
 * @param {{ t: number, memAvailableKb: number, watchedRssKb: (number|null)[] }[]} points
 */
export function downsampleHistory(points, maxPoints = 360) {
  if (points.length <= maxPoints) return points;
  const size = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += size) {
    const bucket = points.slice(i, i + size);
    const last = bucket[bucket.length - 1];
    out.push({
      t: last.t,
      memAvailableKb: Math.min(...bucket.map((p) => p.memAvailableKb)),
      watchedRssKb: last.watchedRssKb.map((_, j) => {
        const values = bucket.map((p) => p.watchedRssKb[j]).filter((v) => v != null);
        return values.length ? Math.max(...values) : null;
      }),
    });
  }
  return out;
}

export class NodeAgentClient {
  /**
   * @param {{ url: string }} agent
   * @param {{ token?: string, fetchImpl?: typeof fetch, now?: () => number }} [opts]
   */
  constructor(agent, opts = {}) {
    this.baseUrl = agent.url;
    this.token = opts.token ?? process.env.SPARKDASH_AGENT_TOKEN ?? "";
    this._fetch = opts.fetchImpl ?? fetch;
    this._now = opts.now ?? Date.now;
    /** @type {{ at: number, value: any } | null} */
    this._cached = null;
    /** @type {Promise<any> | null} */
    this._inflight = null;
  }

  /** Latest snapshot, shared by concurrent callers and reused briefly. */
  async snapshot() {
    if (this._cached && this._now() - this._cached.at < SNAPSHOT_TTL_MS) {
      return this._cached.value;
    }
    if (!this._inflight) {
      this._inflight = this._get("/v1/snapshot")
        .then((value) => {
          if (value?.version !== 1) throw new Error(`unsupported agent snapshot version ${value?.version}`);
          this._cached = { at: this._now(), value };
          return value;
        })
        .finally(() => {
          this._inflight = null;
        });
    }
    return this._inflight;
  }

  /** Memory history newer than `since` (Unix ms). */
  history(since = 0) {
    return this._get(`/v1/history?since=${Math.max(0, Math.floor(since))}`);
  }

  async _get(path) {
    if (!this.token) throw new Error("SPARKDASH_AGENT_TOKEN is not set");
    const res = await this._fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`agent ${this.baseUrl} answered HTTP ${res.status}`);
    return res.json();
  }
}
