import type { Package } from "@patchkite/shared";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * Release track of a deployment: one dot per label (v1..vn).
 * Accent fill = upload, ring = promote, red = rollback, gray = disabled.
 * Amber arc on the last dot = rollout progress; small amber dot = mandatory.
 */
export function ReleaseTrack({
  history,
  selected,
  onSelect,
  onShowAll,
  limit = 8,
}: {
  history: Package[];
  selected?: string;
  onSelect: (label: string) => void;
  onShowAll?: () => void;
  limit?: number;
}) {
  const recent = history.slice(-limit);
  const hidden = history.length - recent.length;
  // An older release selected from the history table is still shown at the start of the track.
  const pinned = selected && !recent.some((p) => p.label === selected) ? history.find((p) => p.label === selected) : undefined;
  const visible = pinned ? [pinned, ...recent] : recent;
  const ref = useRef<HTMLDivElement>(null);
  // The latest release stays visible even when the track scrolls horizontally.
  useEffect(() => {
    if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
  }, [history.length]);
  return (
    <div className="track-row">
      {hidden > 0 && (
        <button type="button" className="chip older" onClick={onShowAll} title="See all releases in the history table">
          +{hidden} older
        </button>
      )}
    <div className="track" ref={ref}>
      <ol aria-label="Release history">
        {visible.map((p, i) => {
          const last = i === visible.length - 1;
          const color = p.isDisabled ? "var(--border-strong)" : p.releaseMethod === "Rollback" ? "var(--red)" : "var(--accent)";
          const rollout = last && p.rollout != null ? p.rollout : null;
          const status = [
            p.releaseMethod === "Promote" ? "promote" : p.releaseMethod === "Rollback" ? "rollback" : "upload",
            p.isMandatory && "mandatory",
            p.isDisabled && "disabled",
            rollout != null && `rollout ${rollout}%`,
          ]
            .filter(Boolean)
            .join(", ");
          return (
            <li key={p.label}>
              <button
                type="button"
                className={`stop${p.label === selected ? " on" : ""}${last ? " last" : ""}`}
                onClick={() => onSelect(p.label)}
                aria-pressed={p.label === selected}
                aria-label={`${p.label}: ${status}`}
                title={`${p.label} · ${status}${p.description ? ` · ${p.description}` : ""}`}
              >
                <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
                  {rollout != null && (
                    <>
                      <circle cx="13" cy="13" r="11" fill="none" stroke="var(--surface-3)" strokeWidth="2.5" />
                      <circle
                        cx="13"
                        cy="13"
                        r="11"
                        fill="none"
                        stroke="var(--amber)"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeDasharray={`${(rollout / 100) * 69.1} 69.1`}
                        transform="rotate(-90 13 13)"
                      />
                    </>
                  )}
                  {p.releaseMethod === "Promote" ? (
                    <circle cx="13" cy="13" r="5.5" fill="var(--surface)" stroke={color} strokeWidth="2.5" />
                  ) : (
                    <circle cx="13" cy="13" r={last ? 7 : 5.5} fill={color} />
                  )}
                  {p.isMandatory && <circle cx="20.5" cy="5.5" r="3" fill="var(--amber)" stroke="var(--surface)" strokeWidth="1.5" />}
                </svg>
                <span>{p.label}</span>
              </button>
              {!last && <span className={`rail${pinned && i === 0 ? " gap" : ""}`} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
    </div>
    </div>
  );
}

export function TrackLegend() {
  const dot = (fill: string, ring = false) => (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {ring ? <circle cx="7" cy="7" r="4.5" fill="none" stroke={fill} strokeWidth="2.2" /> : <circle cx="7" cy="7" r="5" fill={fill} />}
    </svg>
  );
  const arc = (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--surface-3)" strokeWidth="2" />
      <path d="M7 1.5 A5.5 5.5 0 0 1 12.5 7" fill="none" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
  const items: [ReactNode, string, string][] = [
    [dot("var(--accent)"), "Upload", "New release uploaded to this deployment."],
    [dot("var(--accent)", true), "Promote", "Copy of a release from another deployment."],
    [dot("var(--red)"), "Rollback", "Older release re-released."],
    [dot("var(--border-strong)"), "Disabled", "Not delivered to devices."],
    [dot("var(--amber)"), "Mandatory", "Small corner dot: users must install it."],
    [arc, "Staged rollout", "Arc on the latest dot: percentage of devices receiving it."],
  ];
  return (
    <dl className="legend-list">
      {items.map(([sym, k, v]) => (
        <div key={k}>
          <dt>
            {sym}
            {k}
          </dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
