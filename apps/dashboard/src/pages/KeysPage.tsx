import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Badge, Button, CopyButton, EmptyState, Field, Panel, formatDate, useConfirm, useToast } from "../components/ui";

export function KeysPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.accessKeys });
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.addAccessKey(name),
    onSuccess: async (k) => {
      await qc.invalidateQueries({ queryKey: ["keys"] });
      toast(`Access key ${k.friendlyName} created`);
      setName("");
    },
  });
  const remove = useMutation({
    mutationFn: (k: { name: string; friendlyName: string }) => api.removeAccessKey(k.name),
    onSuccess: async (_r, k) => {
      await qc.invalidateQueries({ queryKey: ["keys"] });
      toast(`Access key ${k.friendlyName} deleted`);
    },
  });

  return (
    <>
      <header className="page-h">
        <div>
          <h1>Account</h1>
          <p>
            Login password and access keys for the CLI or CI/CD, e.g. <span className="mono">PATCHKITE_ACCESS_KEY=… patchkite release-react MyApp android</span>
          </p>
        </div>
      </header>
      <PasswordPanel />
      <Panel title="Create access key">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label="Name" placeholder="GitHub Actions" required value={name} onChange={(e) => setName(e.target.value)} error={add.error?.message} />
          <Button variant="primary" icon="key" disabled={!name} loading={add.isPending}>
            Create key
          </Button>
        </form>
        {add.data && (
          <>
            <div className="secret">
              <span className="mono">{add.data.key}</span>
              <CopyButton value={add.data.key} label="Copy access key" />
            </div>
            <span className="hint">Save it now. This key won't be shown again.</span>
          </>
        )}
      </Panel>
      <Panel title="Active keys">
        {keys.data?.length === 0 ? (
          <EmptyState icon="key" title="No access keys yet" small />
        ) : (
          <ul className="list">
            {keys.data?.map((k) => (
              <li key={k.name}>
                <div className="grow">
                  <span className="row">
                    {k.friendlyName}
                    {k.isSession && <Badge>Login session</Badge>}
                  </span>
                  <small>
                    Created {formatDate(k.createdTime)} · expires {formatDate(k.expires)}
                  </small>
                </div>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Delete ${k.friendlyName}?`,
                        body: "Any CLI or pipeline using this key will be rejected immediately.",
                        confirm: "Delete key",
                        danger: true,
                      })
                    )
                      remove.mutate(k);
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function PasswordPanel() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      toast("Password changed. Login sessions on other devices have been signed out.");
      setCurrent("");
      setNext("");
    },
  });
  return (
    <Panel title="Change password">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        <Field label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={change.error?.message}
        />
        <Button variant="primary" disabled={!current || next.length < 8} loading={change.isPending}>
          Change password
        </Button>
      </form>
    </Panel>
  );
}
