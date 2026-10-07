import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type DailyMetric } from "../api";

const RANGES = [7, 30, 90] as const;

/**
 * Daily deployment activity: bars = installs (green) and rollbacks (red, stacked),
 * line = downloads. Can be filtered to the currently selected release.
 */
export function MetricsChart({ appName, deployment, label }: { appName: string; deployment: string; label?: string }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [scope, setScope] = useState<"release" | "all">("all");
  const filter = scope === "release" ? label : undefined;
  const daily = useQuery({
    queryKey: ["metrics-daily", appName, deployment, days, filter],
    queryFn: () => api.metricsDaily(appName, deployment, days, filter),
  });
  const data = daily.data ?? [];
  const totals = data.reduce((t, d) => ({ installed: t.installed + d.installed, failed: t.failed + d.failed, downloaded: t.downloaded + d.downloaded }), {
    installed: 0,
    failed: 0,
    downloaded: 0,
  });

  return (
    <section className="chart-card" aria-label="Daily activity">
      <div className="chart-h">
        <b>Activity</b>
        <span className="legend">
          <span>
            <i style={{ background: "var(--accent)" }} />
            Install {totals.installed}
          </span>
          <span>
            <i style={{ background: "var(--red)" }} />
            Rollback {totals.failed}
          </span>
          <span>
            <i className="line" />
            Download {totals.downloaded}
          </span>
        </span>
        <span className="sp" />
        {label && (
          <div className="seg" role="group" aria-label="Chart scope">
            <button type="button" className={scope === "all" ? "on" : ""} aria-pressed={scope === "all"} onClick={() => setScope("all")}>
              All releases
            </button>
            <button type="button" className={scope === "release" ? "on" : ""} aria-pressed={scope === "release"} onClick={() => setScope("release")}>
              {label}
            </button>
          </div>
        )}
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r} type="button" className={days === r ? "on" : ""} aria-pressed={days === r} onClick={() => setDays(r)}>
              {r} days
            </button>
          ))}
        </div>
      </div>
      {daily.isSuccess && totals.installed + totals.failed + totals.downloaded === 0 ? (
        <p className="chart-empty">No device activity in the last {days} days.</p>
      ) : (
        <Bars data={data} />
      )}
    </section>
  );
}

/** Element width in pixels, updated on resize. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function Bars({ data }: { data: DailyMetric[] }) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  return <div ref={ref}>{measured > 0 && <Plot data={data} W={measured} />}</div>;
}

function Plot({ data, W }: { data: DailyMetric[]; W: number }) {
  const H = 150;
  const pad = { top: 8, bottom: 20, left: 28 };
  const max = Math.max(1, ...data.map((d) => Math.max(d.installed + d.failed, d.downloaded)));
  const plotH = H - pad.top - pad.bottom;
  const step = (W - pad.left) / Math.max(data.length, 1);
  const barW = Math.max(2, Math.min(18, step * 0.62));
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;
  const x = (i: number) => pad.left + i * step + step / 2;
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.downloaded).toFixed(1)}`).join(" ");
  const fmt = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  const tickEvery = Math.ceil(data.length / Math.max(2, Math.floor(W / 90)));

  return (
    <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Installs, rollbacks, and downloads per day">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={pad.left} x2={W} y1={y(max * f)} y2={y(max * f)} className="grid" />
          <text x={pad.left - 6} y={y(max * f) + 3} className="tick" textAnchor="end">
            {Math.round(max * f)}
          </text>
        </g>
      ))}
      {data.map((d, i) => (
        <g key={d.day}>
          <title>{`${fmt(d.day)}: ${d.installed} install, ${d.failed} rollback, ${d.downloaded} download`}</title>
          <rect x={x(i) - step / 2} y={pad.top} width={step} height={plotH} fill="transparent" />
          {d.installed > 0 && <rect x={x(i) - barW / 2} y={y(d.installed)} width={barW} height={plotH + pad.top - y(d.installed)} rx={2} fill="var(--accent)" />}
          {d.failed > 0 && (
            <rect x={x(i) - barW / 2} y={y(d.installed + d.failed)} width={barW} height={y(d.installed) - y(d.installed + d.failed)} rx={2} fill="var(--red)" />
          )}
          {i % tickEvery === 0 && (
            <text x={x(i)} y={H - 5} className="tick" textAnchor="middle">
              {fmt(d.day)}
            </text>
          )}
        </g>
      ))}
      <path d={line} className="dl-line" />
    </svg>
  );
}
