import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api";
import { CopyButton, ErrorText, Panel } from "../components/ui";

/** Access key page, opened by `patchkite login`. */
export function CliLoginPage({ hostname }: { hostname: string }) {
  const create = useMutation({
    mutationFn: () => {
      const stamp = new Date().toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      return api.addAccessKey(`CLI ${hostname} (${stamp})`, undefined, hostname);
    },
  });
  useEffect(() => {
    if (create.isIdle) create.mutate();
  }, [create]);

  return (
    <>
      <header className="page-h">
        <div>
          <h1>CLI access key</h1>
          <p>
            Paste this key into the terminal running <span className="mono">patchkite login</span> on <b>{hostname}</b>.
          </p>
        </div>
      </header>
      <Panel>
        {create.data ? (
          <>
            <div className="secret" style={{ marginTop: 0 }}>
              <span className="mono">{create.data.key}</span>
              <CopyButton value={create.data.key} label="Copy access key" />
            </div>
            <span className="hint">This key is shown only once. Manage or revoke it on the Access keys page.</span>
          </>
        ) : (
          <span className="faint">Creating key…</span>
        )}
        <ErrorText error={create.error} />
      </Panel>
    </>
  );
}
