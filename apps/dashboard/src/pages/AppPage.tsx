import type { Deployment, DeploymentMetrics, Package } from "@patchkite/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { HistoryTable } from "../components/HistoryTable";
import { activeLabels, replacedBy } from "../serving";
import { ReleaseTrack, TrackLegend } from "../components/ReleaseTrack";
import { MetricsChart } from "../components/MetricsChart";
import { ReleaseUpload } from "../components/ReleaseUpload";
import { AppSettings, DeploymentSettings } from "../components/Settings";
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ErrorText,
  Field,
  Lbl,
  Modal,
  Panel,
  Popover,
  formatDate,
  formatSize,
  useConfirm,
  useToast,
} from "../components/ui";

const HINT_KEY = "patchkite.hint.deployments";

export function AppPage({ appName }: { appName: string }) {
  const deployments = useQuery({ queryKey: ["deployments", appName], queryFn: () => api.deployments(appName) });
  const apps = useQuery({ queryKey: ["apps"], queryFn: api.apps });
  const account = useQuery({ queryKey: ["account"], queryFn: api.account });
  const [selected, setSelected] = useState<string>();
  const [adding, setAdding] = useState(false);
  const app = apps.data?.find((a) => a.name === appName);
  // Destructive actions (delete/rename/transfer) are owner-only; the server also rejects them for collaborators.
  const isOwner = !!account.data && app?.collaborators[account.data.email]?.permission === "Owner";
  const canUpload = app?.platform !== "flutter";
  const list = deployments.data ?? [];
  const current =
    list.find((d) => d.name === selected) ?? list.find((d) => d.name === "Production" && d.package) ?? list[0];

  return (
    <>
      <header className="page-h">
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            {app && <Lbl hue={app.platform === "flutter" ? "teal" : "blue"}>{app.platform}</Lbl>}
            {app && <Lbl hue="gray">{app.os}</Lbl>}
          </div>
          <h1>{appName}</h1>
        </div>
        {isOwner && (
          <Button icon="plus" onClick={() => setAdding(true)}>
            Add deployment
          </Button>
        )}
      </header>
      {adding && <NewDeployment appName={appName} onClose={() => setAdding(false)} onCreated={setSelected} />}
      <ErrorText error={deployments.error} />
      <FirstRunHint />

      {list.length > 0 && current && (
        <div className="dep-cards" role="tablist" aria-label="Deployment">
          {list.map((d) => (
            <DeploymentCard key={d.name} appName={appName} deployment={d} on={d.name === current.name} onSelect={() => setSelected(d.name)} />
          ))}
        </div>
      )}
      {current && (
        <DeploymentPanel
          key={current.name}
          appName={appName}
          deployment={current}
          all={list}
          isOwner={isOwner}
          canUpload={canUpload}
          onSelectDeployment={setSelected}
        />
      )}
      {app && <Collaborators appName={appName} collaborators={app.collaborators} />}
      {isOwner && <AppSettings key={appName} appName={appName} />}
    </>
  );
}

function FirstRunHint() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  return (
    <aside className="hint-card">
      <Icon name="info" size={16} />
      <div>
        <b>How deployments work</b>
        <p>
          Each deployment has its own key, and devices only receive updates from the deployment whose key is embedded in the app build. Typically internal builds
          use <b>Staging</b> and store builds use <b>Production</b>. Release to Staging, test, then promote to Production.
        </p>
      </div>
      <button
        type="button"
        className="ibtn ibtn-sm"
        aria-label="Dismiss hint"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem(HINT_KEY, "1");
          } catch {}
        }}
      >
        <Icon name="x" />
      </button>
    </aside>
  );
}

function NewDeployment({ appName, onClose, onCreated }: { appName: string; onClose: () => void; onCreated: (name: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.addDeployment(appName, name.trim()),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["deployments", appName] }), qc.invalidateQueries({ queryKey: ["apps"] })]);
      toast(`Deployment ${name.trim()} created`);
      onCreated(name.trim());
      onClose();
    },
  });
  return (
    <Modal
      title="Add deployment"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <span className="sp" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" form="new-deployment" disabled={!name.trim()} loading={add.isPending}>
            Add deployment
          </Button>
        </>
      }
    >
      <form
        id="new-deployment"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add.mutate();
        }}
      >
        <Field
          label="Name"
          placeholder="e.g. QA"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={add.error?.message}
          hint="A new deployment gets its own key. Use it for a separate release channel, e.g. QA builds or beta testers."
        />
      </form>
    </Modal>
  );
}

/** Latest release still delivered to devices, plus the number of other releases that are still active. */
function liveRelease(history: Package[]) {
  const active = activeLabels(history);
  const live = [...history].reverse().find((p) => active.has(p.label));
  return { live, others: active.size - (live ? 1 : 0) };
}

function DeploymentCard({ appName, deployment, on, onSelect }: { appName: string; deployment: Deployment; on: boolean; onSelect: () => void }) {
  const history = useQuery({ queryKey: ["history", appName, deployment.name], queryFn: () => api.history(appName, deployment.name) });
  const metrics = useQuery({ queryKey: ["metrics", appName, deployment.name], queryFn: () => api.metrics(appName, deployment.name) });
  const list = history.data ?? [];
  const { live, others } = liveRelease(list);
  const devices = Object.values(metrics.data ?? {}).reduce((s, m) => s + m.active, 0);
  const ref = useRef<HTMLButtonElement>(null);
  // On narrow screens the cards scroll horizontally; make sure the selected card is visible.
  useEffect(() => {
    const el = ref.current;
    const row = el?.parentElement;
    if (on && el && row && row.scrollWidth > row.clientWidth) row.scrollTo({ left: el.offsetLeft - row.offsetLeft - 2 });
  }, [on]);

  let body: ReactNode;
  if (!history.isSuccess) body = <span className="faint">Loading…</span>;
  else if (list.length === 0) body = <span className="faint">No releases yet</span>;
  else if (!live) body = <span className="faint">No release being delivered</span>;
  else
    body = (
      <>
        <div className="dc-live">
          <span className="lab">{live.label}</span>
          <span className="faint">for app {live.appVersion}</span>
          {live.isMandatory && <Badge tone="amber">Mandatory</Badge>}
        </div>
        {live.rollout != null && live.rollout < 100 ? (
          <div className="dc-rollout" title={`Rollout ${live.rollout}%`}>
            <span className="progress">
              <span style={{ width: `${live.rollout}%` }} />
            </span>
            <span className="num">{live.rollout}%</span>
          </div>
        ) : (
          <div className="dc-meta">To all devices</div>
        )}
        <div className="dc-meta">
          <span className="num">{devices.toLocaleString()}</span> active {devices === 1 ? "device" : "devices"}
          {others > 0 && ` · ${others} other ${others === 1 ? "release" : "releases"} still active`}
        </div>
      </>
    );

  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={on}
      aria-label={`${deployment.name}: ${live ? `${live.label} for app ${live.appVersion}` : "no active release"}`}
      className={`dep-card${on ? " on" : ""}`}
      onClick={onSelect}
    >
      <span className="dc-h">
        <b>{deployment.name}</b>
        <span className="faint num">{list.length} {list.length === 1 ? "release" : "releases"}</span>
      </span>
      {body}
    </button>
  );
}

function DeploymentPanel({
  appName,
  deployment,
  all,
  isOwner,
  canUpload,
  onSelectDeployment,
}: {
  appName: string;
  deployment: Deployment;
  all: Deployment[];
  isOwner: boolean;
  canUpload: boolean;
  onSelectDeployment: (name: string) => void;
}) {
  const [modal, setModal] = useState<"upload" | "settings" | null>(null);
  const history = useQuery({ queryKey: ["history", appName, deployment.name], queryFn: () => api.history(appName, deployment.name) });
  const metrics = useQuery({ queryKey: ["metrics", appName, deployment.name], queryFn: () => api.metrics(appName, deployment.name) });
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<"track" | "table">("track");
  const list = history.data ?? [];
  const index = Math.max(0, list.findIndex((p) => p.label === selected));
  const current = selected && list.some((p) => p.label === selected) ? list[index] : list.at(-1);
  const active = activeLabels(list);

  return (
    <Panel
      className="dep-panel"
      title={
        <span className="row">
          {deployment.name}
          <span className="faint num" style={{ fontWeight: 400 }}>
            {list.length} {list.length === 1 ? "release" : "releases"}
          </span>
        </span>
      }
      actions={
        <>
          <Popover label={`Deployment key ${deployment.name}`} icon="key" text="Deployment key" width={360}>
            {() => (
              <div className="note">
                <b>Deployment key {deployment.name}</b>
                <div className="secret" style={{ marginTop: 0 }}>
                  <span className="mono">{deployment.key}</span>
                  <CopyButton value={deployment.key} label="Copy deployment key" />
                </div>
                <p>
                  Embed it in the native build config of the app that should receive updates from {deployment.name}, as{" "}
                  <span className="mono">PatchkiteDeploymentKey</span> (Info.plist / AndroidManifest). Don't store it in JS or Dart code.
                </p>
              </div>
            )}
          </Popover>
          {canUpload && (
            <Button size="sm" icon="upload" onClick={() => setModal("upload")}>
              Upload release
            </Button>
          )}
          {isOwner && (
            <button type="button" className="ibtn ibtn-sm" aria-label={`${deployment.name} settings`} title="Settings" onClick={() => setModal("settings")}>
              <Icon name="settings" />
            </button>
          )}
        </>
      }
    >
      {modal === "upload" && (
        <ReleaseUpload appName={appName} deployment={deployment} defaultVersion={list.at(-1)?.appVersion} onClose={() => setModal(null)} />
      )}
      {modal === "settings" && <DeploymentSettings appName={appName} deployment={deployment} onClose={() => setModal(null)} />}
      {history.isSuccess && list.length === 0 ? (
        <EmptyState icon="rocket" title={`${deployment.name} has no releases yet`} small>
          <p>
            Release with <span className="mono">patchkite release-react</span> or <span className="mono">patchkite release-flutter</span>
            {canUpload ? ", upload a zip with the Upload release button," : ""} or promote from another deployment.
          </p>
        </EmptyState>
      ) : (
        <>
          <div className="view-bar">
            <div className="seg" role="group" aria-label="History view">
              <button type="button" className={view === "track" ? "on" : ""} aria-pressed={view === "track"} onClick={() => setView("track")}>
                Track
              </button>
              <button type="button" className={view === "table" ? "on" : ""} aria-pressed={view === "table"} onClick={() => setView("table")}>
                Table <span className="faint num">{list.length}</span>
              </button>
            </div>
            <span className="faint view-tip">Select a release to see its details and actions.</span>
            <span className="sp" />
            <Popover label="Release track legend" icon="help" text="Legend" width={300}>
              {() => <TrackLegend />}
            </Popover>
          </div>
          {view === "track" ? (
            <ReleaseTrack history={list} selected={current?.label} onSelect={setSelected} onShowAll={() => setView("table")} />
          ) : (
            <HistoryTable history={list} metrics={metrics.data ?? {}} active={active} selected={current?.label} onSelect={setSelected} />
          )}
          {current && (
            <ReleaseDetail
              // key per label: form state (rollout, edit) resets when the selected release changes.
              key={current.label}
              appName={appName}
              deployment={deployment}
              pkg={current}
              replacement={active.has(current.label) ? undefined : replacedBy(list, list.indexOf(current))}
              isLatest={current.label === list.at(-1)?.label}
              isActive={active.has(current.label)}
              metrics={metrics.data ?? {}}
              others={all.filter((d) => d.name !== deployment.name)}
              onDone={() => setSelected(undefined)}
              onSelectDeployment={onSelectDeployment}
            />
          )}
          <MetricsChart appName={appName} deployment={deployment.name} label={current?.label} />
        </>
      )}
    </Panel>
  );
}

function statusLine(pkg: Package, isActive: boolean, deployment: string, replacement?: Package): ReactNode {
  if (pkg.isDisabled) return <>Disabled: not delivered to devices. Devices that already installed it keep using this version.</>;
  if (!isActive)
    return (
      <>
        Replaced by {replacement ? <b>{replacement.label}</b> : "a newer release"} for app {pkg.appVersion}. No longer delivered to new devices.
      </>
    );
  const who = pkg.rollout != null && pkg.rollout < 100 ? `${pkg.rollout}% of devices` : "all devices";
  return (
    <>
      Being delivered to <b>{who}</b> on {deployment} with app version <b className="mono">{pkg.appVersion}</b>
      {pkg.isMandatory ? ", and is mandatory." : "."}
    </>
  );
}

function ReleaseDetail({
  appName,
  deployment,
  pkg,
  replacement,
  isLatest,
  isActive,
  metrics,
  others,
  onDone,
  onSelectDeployment,
}: {
  appName: string;
  deployment: Deployment;
  pkg: Package;
  replacement?: Package;
  isLatest: boolean;
  isActive: boolean;
  metrics: DeploymentMetrics;
  others: Deployment[];
  onDone: () => void;
  onSelectDeployment: (name: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const refresh = async () => {
    await Promise.all(
      [["history", appName], ["deployments", appName], ["metrics", appName], ["metrics-daily", appName]].map((queryKey) =>
        qc.invalidateQueries({ queryKey }),
      ),
    );
  };
  const m = metrics[pkg.label];
  const totalActive = Object.values(metrics).reduce((s, x) => s + x.active, 0);
  const [rollout, setRollout] = useState(pkg.rollout ?? 100);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ description: pkg.description, appVersion: pkg.appVersion });

  const patch = useMutation({
    mutationFn: (p: Parameters<typeof api.patch>[2] & { msg: string }) => {
      const { msg: _msg, ...info } = p;
      return api.patch(appName, deployment.name, { label: pkg.label, ...info });
    },
    onSuccess: async (_r, p) => {
      await refresh();
      toast(p.msg);
    },
  });
  const [promoteTo, setPromoteTo] = useState<Deployment | null>(null);
  const promote = useMutation({
    mutationFn: ({ dest, ...info }: { dest: string; isMandatory: boolean; rollout: number | null }) =>
      api.promote(appName, deployment.name, dest, { label: pkg.label, ...info }),
    onSuccess: async (r, { dest }) => {
      await refresh();
      toast(`${pkg.label} promoted to ${dest} as ${r.package.label}`);
    },
  });
  const rollback = useMutation({
    mutationFn: () => api.rollback(appName, deployment.name, isLatest ? undefined : pkg.label),
    onSuccess: async (r) => {
      await refresh();
      onDone();
      toast(`${deployment.name} rolled back to ${r.package.originalLabel}`);
    },
  });
  const error = patch.error ?? rollback.error;
  const busy = patch.isPending || promote.isPending || rollback.isPending;

  let origin = "Upload";
  if (pkg.releaseMethod === "Promote") origin = `Promote ${pkg.originalLabel} from ${pkg.originalDeployment}`;
  if (pkg.releaseMethod === "Rollback") origin = `Rollback to ${pkg.originalLabel}`;
  const pct = m && totalActive ? Math.round((m.active / totalActive) * 100) : 0;
  const diffs = Object.keys(pkg.diffPackageMap ?? {}).length;

  const askRollback = async (close: () => void) => {
    close();
    const ok = await confirm({
      title: isLatest ? `Roll back ${deployment.name}?` : `Roll back ${deployment.name} to ${pkg.label}?`,
      body: isLatest
        ? `The release before ${pkg.label} will be re-released as a new label. Devices receive it on their next update check.`
        : `The contents of ${pkg.label} will be re-released as a new label on ${deployment.name}. Devices receive it on their next update check.`,
      confirm: "Rollback",
      danger: true,
    });
    if (ok) rollback.mutate();
  };

  return (
    <div className="release">
      <div>
        <div className="release-h">
          <span className="lab">{pkg.label}</span>
          {pkg.isDisabled ? (
            <Badge tone="red">Disabled</Badge>
          ) : isActive ? (
            <Badge tone="green" dot>
              Active
            </Badge>
          ) : (
            <Badge>Replaced</Badge>
          )}
          {pkg.isMandatory && <Badge tone="amber">Mandatory</Badge>}
          {pkg.rollout != null && pkg.rollout < 100 && <Badge tone="amber">Rollout {pkg.rollout}%</Badge>}
          <span className="sp" />
        <Popover label={`More actions for ${pkg.label}`} icon="more" text="More actions" role="menu" width={260}>
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                className="mi mi-2"
                disabled={busy}
                onClick={() => {
                  close();
                  patch.mutate({ isMandatory: !pkg.isMandatory, msg: `${pkg.label} ${pkg.isMandatory ? "made optional" : "made mandatory"}` });
                }}
              >
                <Icon name="flag" />
                <span>
                  {pkg.isMandatory ? "Make optional" : "Make mandatory"}
                  <small>{pkg.isMandatory ? "Users may postpone installing it." : "Users must install this update."}</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="mi mi-2"
                disabled={busy}
                onClick={() => {
                  close();
                  patch.mutate({ isDisabled: !pkg.isDisabled, msg: `${pkg.label} ${pkg.isDisabled ? "enabled" : "disabled"}` });
                }}
              >
                <Icon name="ban" />
                <span>
                  {pkg.isDisabled ? "Enable" : "Disable"}
                  <small>{pkg.isDisabled ? "Deliver to devices again." : "Stop delivering to new devices."}</small>
                </span>
              </button>
              <div className="mi-sep" role="separator" />
              <button type="button" role="menuitem" className="mi mi-2 danger" disabled={busy} onClick={() => void askRollback(close)}>
                <Icon name="undo" />
                <span>
                  {isLatest ? "Roll back to previous release" : `Roll back to ${pkg.label}`}
                  <small>Re-release an older version as a new label.</small>
                </span>
              </button>
            </>
          )}
        </Popover>
        </div>
        <p className="status-line">{statusLine(pkg, isActive, deployment.name, replacement)}</p>

        {editing ? (
          <form
            className="form-stack edit-release"
            onSubmit={(e) => {
              e.preventDefault();
              const changes: { description?: string; appVersion?: string } = {};
              if (draft.description !== pkg.description) changes.description = draft.description;
              if (draft.appVersion.trim() !== pkg.appVersion) changes.appVersion = draft.appVersion.trim();
              patch.mutate({ ...changes, msg: `${pkg.label} updated` }, { onSuccess: () => setEditing(false) });
            }}
          >
            <label className="field">
              <span className="label">Description</span>
              <textarea
                className="textarea"
                rows={3}
                maxLength={10000}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <Field
              label="Target app version"
              required
              value={draft.appVersion}
              onChange={(e) => setDraft({ ...draft, appVersion: e.target.value })}
              hint="Semver range of binary versions that receive this release, e.g. 1.5.x or ^1.5.0."
            />
            <div className="row">
              <Button
                variant="primary"
                size="sm"
                loading={patch.isPending}
                disabled={!draft.appVersion.trim() || (draft.description === pkg.description && draft.appVersion.trim() === pkg.appVersion)}
              >
                Save
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="desc-row">
            <p className={`desc${pkg.description ? "" : " none"}`}>{pkg.description || "No description"}</p>
            <Button
              variant="ghost"
              size="sm"
              icon="pencil"
              disabled={busy}
              onClick={() => {
                setDraft({ description: pkg.description, appVersion: pkg.appVersion });
                setEditing(true);
              }}
            >
              Edit
            </Button>
          </div>
        )}
        <dl className="kv">
          <Kv k="Target app" v={<span className="mono">{pkg.appVersion}</span>} />
          <Kv k="Released" v={`${formatDate(pkg.uploadTime)} by ${pkg.releasedBy}`} />
          <Kv k="Origin" v={origin} />
        </dl>
        <details className="tech">
          <summary>Technical details</summary>
          <dl className="kv">
            <Kv k="Size" v={<span className="num">{formatSize(pkg.size)}</span>} />
            <Kv k="Hash" v={<span className="mono faint">{pkg.packageHash.slice(0, 16)}</span>} />
            <Kv k="Diff update" v={diffs ? `Available from ${diffs} previous ${diffs === 1 ? "release" : "releases"}` : "None (devices download the full package)"} />
            {pkg.engineRevision && <Kv k="Flutter engine" v={<span className="mono faint">{pkg.engineRevision.slice(0, 10)}</span>} />}
          </dl>
        </details>
      </div>

      <div className="side-stack">
        <div className="stats compact">
          <Stat
            icon="activity"
            k="Active devices"
            v={m?.active.toLocaleString() ?? 0}
            d={m ? `${pct}% of ${deployment.name} devices` : "no data yet"}
          />
          <Stat icon="download" k="Downloaded" v={m?.downloaded.toLocaleString() ?? 0} />
          <Stat icon="circleCheck" k="Installed" v={m?.installed.toLocaleString() ?? 0} />
          <Stat
            icon="undo"
            k="Failed"
            v={m?.failed ?? 0}
            bad={!!m?.failed}
            d={m?.failed ? "crashed, rolled back automatically" : "no crashes"}
          />
        </div>

        {pkg.rollout != null && pkg.rollout < 100 && !pkg.isDisabled && (
          <form
            className="rollout-box"
            onSubmit={(e) => {
              e.preventDefault();
              patch.mutate({ rollout, msg: `${pkg.label} rollout increased to ${rollout}%` });
            }}
          >
            <span className="label">Staged rollout</span>
            <div className="rollout">
              <input
                type="range"
                min={pkg.rollout}
                max={100}
                value={rollout}
                onChange={(e) => setRollout(Number(e.target.value))}
                aria-label="Rollout percentage"
              />
              <span className="mono num" style={{ width: 38, textAlign: "right" }}>
                {rollout}%
              </span>
              <Button size="sm" disabled={rollout === pkg.rollout || busy} loading={patch.isPending}>
                {rollout === 100 ? "Release to all" : "Increase"}
              </Button>
            </div>
            <span className="hint">Increase while watching the Failed count. Rollout can't be decreased; 100% completes it.</span>
          </form>
        )}

        <div className="next-step">
          {others.map((d) => (
            <PromoteAction
              key={d.name}
              source={deployment}
              dest={d}
              pkg={pkg}
              isLatest={isLatest}
              disabled={busy}
              loading={promote.isPending && promote.variables?.dest === d.name}
              onPromote={() => setPromoteTo(d)}
            />
          ))}
        </div>
        <ErrorText error={error} />
      </div>
      {promoteTo && (
        <PromoteDialog
          pkg={pkg}
          dest={promoteTo}
          loading={promote.isPending}
          error={promote.error}
          onClose={() => !promote.isPending && setPromoteTo(null)}
          onSubmit={(info) =>
            promote.mutate(
              { dest: promoteTo.name, ...info },
              {
                onSuccess: () => {
                  setPromoteTo(null);
                  onSelectDeployment(promoteTo.name);
                },
              },
            )
          }
        />
      )}
    </div>
  );
}

/** Promote with mandatory & rollout options for the new release in the target deployment; defaults follow the source release. */
function PromoteDialog({
  pkg,
  dest,
  loading,
  error,
  onClose,
  onSubmit,
}: {
  pkg: Package;
  dest: Deployment;
  loading: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (info: { isMandatory: boolean; rollout: number | null }) => void;
}) {
  const [mandatory, setMandatory] = useState(pkg.isMandatory);
  const [rollout, setRollout] = useState(pkg.rollout != null && pkg.rollout < 100 ? String(pkg.rollout) : "");
  const rolloutValid = !rollout || (Number.isInteger(Number(rollout)) && Number(rollout) >= 1 && Number(rollout) <= 100);

  return (
    <Modal
      title={`Promote ${pkg.label} to ${dest.name}`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <span className="sp" />
          <Button type="button" variant="ghost" disabled={loading} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="promote-release" variant="primary" icon="promote" disabled={!rolloutValid} loading={loading}>
            Promote to {dest.name}
          </Button>
        </>
      }
    >
      <form
        id="promote-release"
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ isMandatory: mandatory, rollout: rollout ? Number(rollout) : null });
        }}
      >
        <p className="muted">
          {pkg.label} is copied to {dest.name} as a new release (target app <span className="mono">{pkg.appVersion}</span>).{" "}
          {dest.name} devices receive it on their next update check.
        </p>
        <div className="row" style={{ gap: 20, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="row" style={{ gap: 8 }}>
            <input className="check" type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} />
            Mandatory
          </label>
          <Field
            label="Rollout (%)"
            type="number"
            min={1}
            max={100}
            placeholder="100"
            value={rollout}
            onChange={(e) => setRollout(e.target.value)}
            error={rolloutValid ? undefined : "1–100"}
            style={{ width: 110 }}
          />
        </div>
        <p className="hint">Leave rollout empty to release to all devices. Rollout can be increased later, but not decreased.</p>
        <ErrorText error={error} />
      </form>
    </Modal>
  );
}

function PromoteAction({
  source,
  dest,
  pkg,
  isLatest,
  disabled,
  loading,
  onPromote,
}: {
  source: Deployment;
  dest: Deployment;
  pkg: Package;
  isLatest: boolean;
  disabled: boolean;
  loading: boolean;
  onPromote: () => void;
}) {
  const there = dest.package;
  const already = there?.originalDeployment === source.name && there.originalLabel === pkg.label;
  let note: ReactNode;
  if (already) note = `Already on ${dest.name} as ${there!.label}.`;
  else if (!isLatest) note = "Only the latest release can be promoted.";
  else if (!there) note = `${dest.name} has no releases yet.`;
  else
    note = (
      <>
        {dest.name} is currently on <b>{there.label}</b>
        {there.releaseMethod === "Promote" && there.originalDeployment ? ` (from ${there.originalDeployment} ${there.originalLabel})` : ""}.
      </>
    );
  return (
    <div className="promote-row">
      <Button
        variant={dest.name === "Production" && isLatest && !already ? "primary" : "secondary"}
        icon="promote"
        disabled={disabled || !isLatest || already}
        loading={loading}
        onClick={onPromote}
      >
        Promote to {dest.name}
      </Button>
      <span className="hint">{note}</span>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function Stat({ icon, k, v, d, bad }: { icon: Parameters<typeof Icon>[0]["name"]; k: string; v: ReactNode; d?: string; bad?: boolean }) {
  return (
    <div className="stat">
      <span className="k">
        <Icon name={icon} />
        {k}
      </span>
      <span className="v" style={bad ? { color: "var(--red)" } : undefined}>
        {v}
      </span>
      {d && <span className={`d${bad ? " bad" : ""}`}>{d}</span>}
    </div>
  );
}

function Collaborators({ appName, collaborators }: { appName: string; collaborators: Record<string, { permission: string }> }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [email, setEmail] = useState("");
  const add = useMutation({
    mutationFn: () => api.addCollaborator(appName, email),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(`${email} added as a collaborator`);
      setEmail("");
    },
  });
  const remove = useMutation({
    mutationFn: (e: string) => api.removeCollaborator(appName, e),
    onSuccess: async (_r, e) => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(`${e} removed from the app`);
    },
  });
  return (
    <Panel title="Collaborators">
      <ul className="list">
        {Object.entries(collaborators).map(([mail, c]) => (
          <li key={mail}>
            <span className="av" style={{ ["--c" as string]: "var(--accent)" }}>
              {mail.slice(0, 2).toUpperCase()}
            </span>
            <span className="grow trunc">{mail}</span>
            {c.permission === "Owner" ? (
              <Badge>Owner</Badge>
            ) : (
              <Button
                variant="danger-ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={async () => {
                  if (await confirm({ title: "Remove collaborator?", body: `${mail} will no longer be able to manage ${appName}.`, confirm: "Remove", danger: true }))
                    remove.mutate(mail);
                }}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="inline-form"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (email) add.mutate();
        }}
      >
        <Field
          label="Invite collaborator"
          type="email"
          placeholder="name@company.com"
          hint="The user must already have a Patchkite account."
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={add.error?.message ?? remove.error?.message}
        />
        <Button icon="userPlus" disabled={!email} loading={add.isPending}>
          Invite
        </Button>
      </form>
    </Panel>
  );
}
