import test from "node:test";
import assert from "node:assert/strict";
import { NodeAgentClient, downsampleHistory, normalizeAgentConfig, SNAPSHOT_TTL_MS } from "../NodeAgent.js";
import { SystemCollector } from "../SystemCollector.js";

/** A GB10-shaped agent snapshot (see apps/sparkdash-agent in agent-storage). */
function snapshot(overrides = {}) {
  return {
    version: 1,
    hostname: "dgx-02",
    arch: "aarch64",
    collectedAtMs: 1_000_000,
    uptimeS: 266_000,
    cpu: { cores: 20, model: null, usagePct: 37.6, load: [1, 1, 1], tempC: 63.2 },
    memory: {
      totalKb: 127_535_392,
      availableKb: 8_388_608,
      freeKb: 1_048_576,
      buffersKb: 0,
      cachedKb: 0,
      shmemKb: 0,
      swapTotalKb: 16_777_216,
      swapFreeKb: 15_728_640,
    },
    gpus: [
      {
        index: 0,
        name: "NVIDIA GB10",
        tempC: 71,
        utilPct: 96,
        memUtilPct: 0,
        powerW: 88.4,
        powerLimitW: null,
        smClockMhz: 2100,
        smClockMaxMhz: 2250,
        memUsedBytes: null,
        memTotalBytes: null,
        throttle: { hwThermal: false, swThermal: false, hwSlowdown: false, swPowerCap: true, hwPowerBrake: false, raw: 4 },
        processes: [
          { pid: 10, name: "/usr/local/bin/tensorfold", usedBytes: 100 * 1048576 * 1024 },
          { pid: 11, name: "python3", usedBytes: null },
        ],
      },
    ],
    gpuDriver: "580.178.04",
    gpuError: null,
    nvErrNoMemory: 3,
    disks: [
      {
        device: "nvme0n1p2",
        mount: "/",
        fsType: "ext4",
        totalBytes: 4000 * 1048576,
        usedBytes: 1000 * 1048576,
        availableBytes: 2999 * 1048576,
        readBytes: 0,
        writeBytes: 0,
      },
    ],
    network: {
      defaultInterface: "wlP9s9",
      interfaces: [
        { name: "wlP9s9", rxBytes: 1000, txBytes: 2000, operstate: "up", speedMbps: null, mac: "aa:bb:cc:dd:ee:ff", ipv4: ["192.168.1.117"] },
        { name: "enP7s7", rxBytes: 0, txBytes: 0, operstate: "down", speedMbps: null, mac: "fc:9d:05:13:25:95", ipv4: [] },
        { name: "enp1s0f1np1", rxBytes: 5, txBytes: 5, operstate: "up", speedMbps: 200000, mac: "x", ipv4: ["192.168.100.11"] },
        { name: "docker0", rxBytes: 0, txBytes: 0, operstate: "down", speedMbps: null, mac: "y", ipv4: ["172.17.0.1"] },
      ],
    },
    rdma: [
      { device: "rocep1s0f1", port: "1", netdev: "enp1s0f1np1", state: "ACTIVE", rateGbps: 200, rxBytes: 4_000_000_000, txBytes: 8_000_000_000 },
    ],
    containers: null,
    containersError: null,
    watched: [{ name: "polkitd", pid: 1519, rssKb: 2_958_316, swapKb: 818_000 }],
    agent: { version: "0.1.0", startedAtMs: 0, rssKb: 3072, cpuSeconds: 1.5, samples: 9, minIntervalMs: 1000 },
    ...overrides,
  };
}

/** A collector whose agent returns the queued snapshots in order. */
function collectorWith(...snaps) {
  const c = new SystemCollector({ id: "dgx-02", kind: "spark", isLocal: false, agent: { url: "http://192.168.1.117:9110" } });
  const queue = [...snaps];
  c.agent.snapshot = async () => (queue.length > 1 ? queue.shift() : queue[0]);
  return c;
}

test("normalizeAgentConfig accepts http(s) LAN URLs only", () => {
  assert.deepEqual(normalizeAgentConfig({ url: "http://192.168.1.116:9110/" }), { url: "http://192.168.1.116:9110" });
  assert.deepEqual(normalizeAgentConfig({ url: "https://dgx-01.example.ts.net:9110" }), { url: "https://dgx-01.example.ts.net:9110" });
  assert.equal(normalizeAgentConfig({ url: "ftp://192.168.1.116" }), null);
  assert.equal(normalizeAgentConfig({ url: "http://169.254.169.254/" }), null);
  assert.equal(normalizeAgentConfig({ url: "http://user:pw@192.168.1.116:9110" }), null);
  assert.equal(normalizeAgentConfig({ url: "" }), null);
  assert.equal(normalizeAgentConfig(null), null);
});

test("NodeAgentClient shares one request between concurrent callers and caches briefly", async () => {
  let calls = 0;
  let now = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(url, "http://a:9110/v1/snapshot");
    assert.equal(init.headers.Authorization, "Bearer tok");
    return { ok: true, status: 200, json: async () => snapshot() };
  };
  const client = new NodeAgentClient({ url: "http://a:9110" }, { token: "tok", fetchImpl, now: () => now });
  await Promise.all([client.snapshot(), client.snapshot(), client.snapshot()]);
  assert.equal(calls, 1);
  now = SNAPSHOT_TTL_MS - 1;
  await client.snapshot();
  assert.equal(calls, 1);
  now = SNAPSHOT_TTL_MS;
  await client.snapshot();
  assert.equal(calls, 2);
});

test("NodeAgentClient refuses to run without a token and surfaces HTTP errors", async () => {
  const noToken = new NodeAgentClient({ url: "http://a:9110" }, { token: "" });
  await assert.rejects(noToken.snapshot(), /SPARKDASH_AGENT_TOKEN/);
  const denied = new NodeAgentClient(
    { url: "http://a:9110" },
    { token: "t", fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }
  );
  await assert.rejects(denied.snapshot(), /HTTP 401/);
});

test("agent snapshot maps to the GPU, CPU, RAM and unified-memory shapes", async () => {
  const c = collectorWith(snapshot());
  const gpu = await c.collectGpu();
  assert.equal(gpu.temperature, 71);
  assert.equal(gpu.usage, 96);
  assert.deepEqual(gpu.power, { draw: 88.4, limit: 120, systemDraw: 108 });
  assert.equal(gpu.vram.used, 102400);
  assert.equal(gpu.vram.total, Math.round(127_535_392 / 1024));
  assert.equal(gpu.vram.available, 8192);
  assert.equal(gpu.processes[0].name, "/usr/local/bin/tensorfold");
  assert.equal(gpu.throttle.powerCap, true);
  assert.equal(gpu.throttle.smClockMHz, 2100);
  assert.equal(gpu.nvErrNoMemory, 3);

  const cpu = await c.collectCpu();
  assert.equal(cpu.usage, 38);
  assert.equal(cpu.temperature, 63.2);
  assert.equal(cpu.tdp, 65);

  const ram = await c.collectRam();
  assert.equal(ram.total, Math.round(127_535_392 / 1024));
  assert.equal(ram.used, Math.round((127_535_392 - 8_388_608) / 1024));

  const um = await c.collectUnifiedMemory();
  assert.equal(um.gpuUsed, 102400);
  assert.equal(um.available, 8192);
});

test("network rates come from counters; RoCE links use the RDMA port counters", async () => {
  const later = snapshot({ collectedAtMs: 1_002_000 });
  later.network = structuredClone(later.network);
  later.network.interfaces[0].rxBytes = 3000;
  later.rdma = [{ ...later.rdma[0], rxBytes: 6_000_000_000, txBytes: 8_000_000_000 }];
  const c = collectorWith(snapshot(), later);
  const first = await c.collectNetwork();
  assert.deepEqual(first.interfaces.map((i) => i.name), ["wlP9s9", "enP7s7", "enp1s0f1np1"]);
  assert.equal(first.primaryInterface, "wlP9s9");
  assert.equal(first.wolMac, "fc:9d:05:13:25:95");
  const second = await c.collectNetwork();
  const wifi = second.interfaces.find((i) => i.name === "wlP9s9");
  const roce = second.interfaces.find((i) => i.name === "enp1s0f1np1");
  assert.equal(wifi.rxSpeed, 1000);
  assert.equal(roce.rxSpeed, 1_000_000_000);
  assert.equal(roce.txSpeed, 0);
  assert.deepEqual(roce.rdma, { device: "rocep1s0f1", state: "ACTIVE", rateGbps: 200 });
  assert.equal(roce.ip, "192.168.100.11");
  // Same snapshot again (cache hit): keep the last rate rather than dropping to 0.
  const third = await c.collectNetwork();
  assert.equal(third.interfaces.find((i) => i.name === "enp1s0f1np1").rxSpeed, 1_000_000_000);
});

test("storage and health come from the snapshot", async () => {
  const c = collectorWith(snapshot());
  const [disk] = await c.collectStorage();
  assert.equal(disk.label, "/");
  assert.equal(disk.total, 4000);
  assert.equal(disk.percentage, 26);

  const health = await c.collectHealth();
  assert.equal(health.memAvailableMB, 8192);
  assert.equal(health.swapUsedMB, 1024);
  assert.deepEqual(health.watched, [{ name: "polkitd", pid: 1519, rssMB: 2889, swapMB: 799 }]);
  assert.equal(health.agent.rssMB, 3);

  assert.equal(await c.agentUptime(), 266_000);
  const hw = await c.detectHardware();
  assert.equal(hw.gpuChip, "NVIDIA GB10");
  assert.equal(hw.cudaDriver, "580.178.04");
  assert.equal(hw.cpuCores, 20);
});

test("an unreachable agent reports defaults, never SSH", async () => {
  const c = new SystemCollector({ id: "x", isLocal: false, agent: { url: "http://192.168.1.117:9110" }, ssh: { host: "x", user: "root" } });
  c.agent.snapshot = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const gpu = await c.collectGpu();
  assert.equal(gpu.temperature, 0);
  assert.deepEqual(await c.collectRam(), c._defaultRam());
  assert.deepEqual(await c.collectStorage(), []);
  assert.equal(await c.collectHealth(), null);
});

test("setSpark swaps the agent client only when its URL changes", () => {
  const c = new SystemCollector({ id: "x", isLocal: false, agent: { url: "http://192.168.1.117:9110" } });
  const before = c.agent;
  c.setSpark({ id: "x", isLocal: false, agent: { url: "http://192.168.1.117:9110" }, name: "renamed" });
  assert.equal(c.agent, before);
  c.setSpark({ id: "x", isLocal: false, agent: null });
  assert.equal(c.agent, null);
});

test("downsampleHistory keeps memory dips and RSS peaks", () => {
  const points = Array.from({ length: 10 }, (_, i) => ({
    t: i,
    memAvailableKb: i === 3 ? 1 : 100,
    watchedRssKb: [i === 8 ? 999 : i, null],
  }));
  assert.equal(downsampleHistory(points, 20), points);
  const out = downsampleHistory(points, 2);
  assert.deepEqual(out, [
    { t: 4, memAvailableKb: 1, watchedRssKb: [4, null] },
    { t: 9, memAvailableKb: 100, watchedRssKb: [999, null] },
  ]);
});
