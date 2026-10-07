import type { Deployment } from "@patchkite/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { Button, ErrorText, Field, Modal, Panel, useConfirm, useToast } from "./ui";

/** Deployment settings (owner only): rename, clear history, delete. */
export function DeploymentSettings({ appName, deployment, onClose }: { appName: string; deployment: Deployment; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState(deployment.name);
  const refresh = () =>
    Promise.all([["deployments", appName], ["history", appName], ["metrics", appName], ["apps"]].map((queryKey) => qc.invalidateQueries({ queryKey })));

  const rename = useMutation({
    mutationFn: () => api.renameDeployment(appName, deployment.name, name.trim()),
    onSuccess: async () => {
      await refresh();
      toast(`Deployment ${deployment.name} renamed to ${name.trim()}`);
      onClose();
    },
  });
  const clear = useMutation({
    mutationFn: () => api.clearHistory(appName, deployment.name),
    onSuccess: async () => {
      await refresh();
      toast(`${deployment.name} history cleared`);
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeDeployment(appName, deployment.name),
    onSuccess: async () => {
      await refresh();
      toast(`Deployment ${deployment.name} deleted`);
      onClose();
    },
  });
  const busy = rename.isPending || clear.isPending || remove.isPending;

  return (
    <Modal title={`${deployment.name} settings`} onClose={onClose}>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate();
        }}
      >
        <Field label="Deployment name" value={name} onChange={(e) => setName(e.target.value)} required pattern="[\w.\-]+" />
        <Button disabled={busy || !name.trim() || name.trim() === deployment.name} loading={rename.isPending}>
          Rename
        </Button>
      </form>
      <p className="hint">The deployment key doesn't change, so installed apps keep receiving updates.</p>

      <div className="danger-zone">
        <div className="grow">
          <b>Clear history</b>
          <small>All releases and metrics for this deployment are deleted. Devices that already installed an update keep using it.</small>
        </div>
        <Button
          variant="danger-ghost"
          disabled={busy}
          loading={clear.isPending}
          onClick={async () => {
            if (
              await confirm({
                title: `Clear ${deployment.name} history?`,
                body: "All releases and metrics will be permanently deleted. This action cannot be undone.",
                confirm: "Clear",
                danger: true,
              })
            )
              clear.mutate();
          }}
        >
          Clear
        </Button>
      </div>
      <div className="danger-zone">
        <div className="grow">
          <b>Delete deployment</b>
          <small>Apps using this key will no longer receive updates.</small>
        </div>
        <Button
          variant="danger"
          icon="trash"
          disabled={busy}
          loading={remove.isPending}
          onClick={async () => {
            if (
              await confirm({
                title: `Delete deployment ${deployment.name}?`,
                body: "The deployment, its key, release history, and metrics will be permanently deleted.",
                confirm: "Delete deployment",
                danger: true,
              })
            )
              remove.mutate();
          }}
        >
          Delete
        </Button>
      </div>
      <ErrorText error={rename.error ?? clear.error ?? remove.error} />
    </Modal>
  );
}

/** App settings (owner only): rename, transfer ownership, delete. */
export function AppSettings({ appName }: { appName: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [name, setName] = useState(appName);
  const [owner, setOwner] = useState("");

  const rename = useMutation({
    mutationFn: () => api.renameApp(appName, name.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(`App renamed to ${name.trim()}`);
      void navigate({ to: "/apps/$appName", params: { appName: name.trim() } });
    },
  });
  const transfer = useMutation({
    mutationFn: () => api.transferApp(appName, owner.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(`${appName} transferred to ${owner.trim()}; you are now a collaborator`);
      setOwner("");
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeApp(appName),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(`App ${appName} deleted`);
      void navigate({ to: "/" });
    },
  });
  const busy = rename.isPending || transfer.isPending || remove.isPending;

  return (
    <Panel title="App settings">
      <div className="form-stack">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate();
          }}
        >
          <Field label="App name" value={name} onChange={(e) => setName(e.target.value)} required pattern="[\w.\-]+" />
          <Button disabled={busy || !name.trim() || name.trim() === appName} loading={rename.isPending}>
            Rename
          </Button>
        </form>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await confirm({
                title: `Transfer ${appName}?`,
                body: `${owner.trim()} becomes the owner. You can still release as a collaborator, but can no longer delete the app or manage deployments.`,
                confirm: "Transfer",
                danger: true,
              })
            )
              transfer.mutate();
          }}
        >
          <Field
            label="Transfer ownership"
            type="email"
            placeholder="new owner's email"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            hint="The user must already have a Patchkite account."
          />
          <Button disabled={busy || !owner.trim()} loading={transfer.isPending}>
            Transfer
          </Button>
        </form>
        <div className="danger-zone">
          <div className="grow">
            <b>Delete app</b>
            <small>All deployments, releases, metrics, and collaborators are deleted. Devices will no longer receive updates.</small>
          </div>
          <Button
            variant="danger"
            icon="trash"
            disabled={busy}
            loading={remove.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Delete app ${appName}?`,
                  body: "All deployments, releases, and metrics will be permanently deleted. This action cannot be undone.",
                  confirm: "Delete app",
                  danger: true,
                })
              )
                remove.mutate();
            }}
          >
            Delete app
          </Button>
        </div>
        <ErrorText error={rename.error ?? transfer.error ?? remove.error} />
      </div>
    </Panel>
  );
}
