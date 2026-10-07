import type { DeploymentMetrics, Package } from "@patchkite/shared";
import { useMemo, useState } from "react";
import { Icon } from "./icons";
import { Badge, formatDate } from "./ui";

/** Full history of a deployment (newest first), searchable and selectable. */
export function HistoryTable({
  history,
  metrics,
  active,
  selected,
  onSelect,
}: {
  history: Package[];
  metrics: DeploymentMetrics;
  active: Set<string>;
  selected?: string;
  onSelect: (label: string) => void;
}) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = [...history].reverse();
    if (!term) return list;
    return list.filter((p) => [p.label, p.appVersion, p.description, p.releasedBy].some((x) => x?.toLowerCase().includes(term)));
  }, [history, q]);

  return (
    <div className="history">
      <div className="inwrap history-search">
        <Icon name="search" />
        <input
          className="input"
          placeholder="Search label, target version, description…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search releases"
        />
      </div>
      <div className="tbl-wrap history-wrap">
        <table className="tbl">
          <colgroup>
            <col style={{ width: 64 }} />
            <col style={{ width: 84 }} />
            <col />
            <col style={{ width: 150 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 84 }} />
            <col style={{ width: 84 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="sticky">Label</th>
              <th>Target</th>
              <th>Description</th>
              <th>Status</th>
              <th>Released</th>
              <th className="r">Installed</th>
              <th className="r">Rollback</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const m = metrics[p.label];
              return (
                <tr
                  key={p.label}
                  className={p.label === selected ? "sel" : undefined}
                  onClick={() => onSelect(p.label)}
                  tabIndex={0}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(p.label)}
                  aria-selected={p.label === selected}
                >
                  <td className="sticky mono">{p.label}</td>
                  <td className="mono faint">{p.appVersion}</td>
                  <td title={p.description}>{p.description || <span className="faint">—</span>}</td>
                  <td>
                    <span className="row" style={{ gap: 4 }}>
                      {active.has(p.label) && <Badge tone="green">Active</Badge>}
                      {p.releaseMethod === "Promote" && <Badge>Promote</Badge>}
                      {p.releaseMethod === "Rollback" && <Badge tone="red">Rollback</Badge>}
                      {p.isMandatory && <Badge tone="amber">Mandatory</Badge>}
                      {p.isDisabled && <Badge tone="red">Disabled</Badge>}
                      {p.rollout != null && <Badge tone="amber">{p.rollout}%</Badge>}
                    </span>
                  </td>
                  <td className="faint">{formatDate(p.uploadTime)}</td>
                  <td className="r num">{m?.installed ?? 0}</td>
                  <td className={`r num${m?.failed ? " bad" : ""}`}>{m?.failed ?? 0}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="faint" style={{ textAlign: "center" }}>
                  No releases match “{q}”
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
