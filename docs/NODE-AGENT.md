# Remote Sparks through sparkdash-agent

By default sparkDash reads a remote Spark by running shell commands over SSH:
about five commands every 2 s per Spark. Through **Tailscale SSH** each command
is a new login session, and the churn makes polkitd leak (measured at
~1 GiB/day per node; on a GB10 that is GPU memory) and adds ~1,100 wakeups/s.

`sparkdash-agent` is a small Rust service that runs on each Spark, reads
/proc, /sys and NVML in-process, and answers one token-gated HTTP GET per poll.
Its source, systemd unit and installer live in the agent-storage repository
(`apps/sparkdash-agent`).

## Enable it for a Spark

1. Install the agent on the Spark (`apps/sparkdash-agent/deploy/install.sh`).
2. Give sparkDash the agent's token: `SPARKDASH_AGENT_TOKEN=…` in `.env`.
3. Add the endpoint to the Spark in `config/sparks.json` and restart sparkDash:

   ```json
   { "id": "dgx-01", "agent": { "url": "http://192.168.1.116:9110" }, ... }
   ```

The agent URL can only be set in the config file: it receives the token, so
the HTTP API ignores it.

## What changes

- GPU, CPU, RAM, storage, network, unified memory, uptime/liveness, hardware
  detection and the `NV_ERR_NO_MEMORY` count all come from the agent. They
  never fall back to SSH; if the agent is down, the Spark shows offline.
- CX7 RoCE links show real traffic. RoCE bypasses the kernel's netdev
  counters, so those interfaces use the RDMA port counters (tagged "RoCE").
- A **Memory health** panel shows MemAvailable, MemFree, swap, the RSS of the
  agent's watched processes (polkitd by default), a ~24 h MemAvailable chart
  from the agent's own history, and the agent's footprint.

SSH is still used, only on demand, for Shutdown, benchmark tunnels, and the
opt-in Tailscale and Hermes probes. Leave those off on agent Sparks to keep
them session-free.
