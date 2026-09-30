import { useEffect, useState } from "react";
import type { AgentHistory, HealthMetrics } from "../../api/types";
import { fetchAgentHistory } from "../../api/client";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { Panel } from "../ui/Panel";
import { Sparkline } from "../ui/Sparkline";
import { MemoryIcon } from "../ui/icons";

interface HealthPanelProps {
  health: HealthMetrics;
  sparkId: string;
  className?: string;
}

/** Long-range history refresh; the agent samples every 10 s. */
const HISTORY_REFRESH_MS = 5 * 60 * 1000;

function formatMb(mb: number | null): string {
  if (mb == null) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function formatDeltaMb(mb: number): string {
  const sign = mb > 0 ? "+" : mb < 0 ? "−" : "±";
  return `${sign}${formatMb(Math.abs(mb))}`;
}

/**
 * Memory health for Sparks read through a sparkdash-agent: what the model can
 * still get (MemAvailable), swap, and the RSS of watched processes — polkitd
 * by default, which leaked under per-poll SSH sessions. The 24 h row comes
 * from the agent's own history, so it survives dashboard restarts.
 */
export function HealthPanel({ health, sparkId, className }: HealthPanelProps) {
  const availableTail = useMetricsHistoryTail(sparkId, "health.memAvailableMB");
  const [history, setHistory] = useState<AgentHistory | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchAgentHistory(sparkId)
        .then((h) => {
          if (!cancelled) setHistory(h);
        })
        .catch(() => {
          if (!cancelled) setHistory(null);
        });
    void load();
    const id = setInterval(load, HISTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sparkId]);

  const points = history?.points ?? [];
  const dayAvailable = points.map((p) => p.memAvailableKb / 1024);
  const dayMin = dayAvailable.length ? Math.min(...dayAvailable) : null;
  const hours = points.length > 1 ? (points[points.length - 1].t - points[0].t) / 3_600_000 : 0;

  return (
    <Panel title="Memory health" icon={<MemoryIcon />} className={className} bodyClassName="space-y-2">
      <Row label="Available" value={formatMb(health.memAvailableMB)} hint={`of ${formatMb(health.memTotalMB)}`}>
        <Sparkline data={availableTail} width={120} />
      </Row>
      <Row label="Free" value={formatMb(health.memFreeMB)} />
      <Row
        label="Swap used"
        value={formatMb(health.swapUsedMB)}
        hint={health.swapTotalMB ? `of ${formatMb(health.swapTotalMB)}` : undefined}
      />
      {health.watched.map((w, i) => {
        const series = points.map((p) => p.watchedRssKb[history?.watched.indexOf(w.name) ?? i] ?? 0);
        const known = series.filter((v) => v > 0);
        const growth = known.length > 1 ? (known[known.length - 1] - known[0]) / 1024 : null;
        return (
          <WatchedRow
            key={w.name}
            sparkId={sparkId}
            name={w.name}
            rssMB={w.rssMB}
            swapMB={w.swapMB}
            daySeries={series.map((kb) => kb / 1024)}
            growth={growth}
            hours={hours}
          />
        );
      })}
      {dayAvailable.length > 1 && (
        <div className="rounded-md border border-border bg-surface-elevated px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
            <span>Available, last {Math.max(1, Math.round(hours))} h</span>
            <span className="font-tabular">low {formatMb(dayMin)}</span>
          </div>
          <Sparkline data={dayAvailable} width={260} height={32} />
        </div>
      )}
      <div className="flex justify-between text-[11px] text-muted">
        <span>Agent {health.agent.version ? `v${health.agent.version}` : ""}</span>
        <span className="font-tabular">
          {formatMb(health.agent.rssMB)} RSS
          {health.agent.cpuPct != null && ` · ${health.agent.cpuPct.toFixed(2)}% CPU`}
        </span>
      </div>
    </Panel>
  );
}

function Row({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <div className="flex items-center gap-3">
        {children}
        <span className="font-tabular text-sm font-semibold text-text">
          {value}
          {hint && <span className="ml-1 text-xs font-normal text-muted">{hint}</span>}
        </span>
      </div>
    </div>
  );
}

function WatchedRow({
  sparkId,
  name,
  rssMB,
  swapMB,
  daySeries,
  growth,
  hours,
}: {
  sparkId: string;
  name: string;
  rssMB: number | null;
  swapMB: number | null;
  daySeries: number[];
  growth: number | null;
  hours: number;
}) {
  const tail = useMetricsHistoryTail(sparkId, `health.rss.${name}`);
  const series = daySeries.length > 1 ? daySeries : tail;
  const hint =
    rssMB == null
      ? "not running"
      : [swapMB ? `+${formatMb(swapMB)} swap` : null, growth != null && hours >= 1 ? `${formatDeltaMb(growth)} / ${Math.round(hours)} h` : null]
          .filter(Boolean)
          .join(" · ") || undefined;
  return (
    <Row label={`${name} RSS`} value={formatMb(rssMB)} hint={hint}>
      <Sparkline data={series} width={120} color="var(--color-warning)" />
    </Row>
  );
}
