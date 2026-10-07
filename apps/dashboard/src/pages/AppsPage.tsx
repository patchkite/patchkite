import type { OS, Platform } from "@patchkite/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { Button, EmptyState, ErrorText, Field, Lbl, Panel, useToast } from "../components/ui";

export function AppsPage() {
  const apps = useQuery({ queryKey: ["apps"], queryFn: api.apps });
  const count = apps.data?.length ?? 0;
  return (
    <>
      <header className="page-h">
        <div>
          <h1>Apps</h1>
          <p>{apps.isSuccess ? `${count} ${count === 1 ? "app" : "apps"} · each has Staging and Production deployments` : " "}</p>
        </div>
      </header>
      <ErrorText error={apps.error} />
      {apps.isSuccess && count === 0 ? (
        <Panel>
          <EmptyState icon="smartphone" title="No apps yet">
            <p>Create an app below, or via the CLI: <span className="mono">patchkite app add MyApp-Android android react-native</span></p>
          </EmptyState>
        </Panel>
      ) : (
        <div className="grid-apps">
          {apps.data?.map((a) => (
            <Link key={a.name} to="/apps/$appName" params={{ appName: a.name }} className="app-card">
              <div className="row">
                <Lbl hue={a.platform === "flutter" ? "teal" : "blue"}>{a.platform}</Lbl>
                <Lbl hue="gray">{a.os}</Lbl>
              </div>
              <h3>{a.name}</h3>
              <span className="deps">
                {a.deployments.length} {a.deployments.length === 1 ? "deployment" : "deployments"} · {a.deployments.join(", ")}
              </span>
            </Link>
          ))}
        </div>
      )}
      <NewApp />
    </>
  );
}

function NewApp() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [os, setOs] = useState<OS>("android");
  const [platform, setPlatform] = useState<Platform>("react-native");
  const add = useMutation({
    mutationFn: () => api.addApp(name, os, platform),
    onSuccess: async (app) => {
      await qc.invalidateQueries({ queryKey: ["apps"] });
      toast(`App ${app.name} created`);
      void navigate({ to: "/apps/$appName", params: { appName: app.name } });
    },
  });
  return (
    <Panel title="New app">
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field
          label="Name"
          placeholder="MyApp-Android"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          hint="Letters, numbers, dots, underscores and hyphens."
          error={add.error?.message}
        />
        <div className="field">
          <span className="label">OS</span>
          <div className="seg" role="group" aria-label="OS">
            {(["android", "ios"] as const).map((o) => (
              <button type="button" key={o} className={os === o ? "on" : ""} aria-pressed={os === o} onClick={() => setOs(o)}>
                {o === "ios" ? "iOS" : "Android"}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">Platform</span>
          <div className="seg" role="group" aria-label="Platform">
            {(["react-native", "flutter"] as const).map((p) => (
              <button type="button" key={p} className={platform === p ? "on" : ""} aria-pressed={platform === p} onClick={() => setPlatform(p)}>
                {p === "flutter" ? "Flutter" : "React Native"}
              </button>
            ))}
          </div>
        </div>
        <Button variant="primary" icon="plus" disabled={!name} loading={add.isPending}>
          Create app
        </Button>
      </form>
    </Panel>
  );
}
