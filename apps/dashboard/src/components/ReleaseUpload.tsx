import type { Deployment } from "@patchkite/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { Button, ErrorText, Field, Modal, formatSize, useToast } from "./ui";

/**
 * Upload a release from the dashboard (equivalent of `patchkite release <app> <zip> <version>`).
 * The zip contains the bundle output, e.g. a CI artifact. Signed and Flutter releases still go through the CLI,
 * because the private key must never be in the browser and Flutter needs the engine revision from the build.
 */
export function ReleaseUpload({
  appName,
  deployment,
  defaultVersion,
  onClose,
}: {
  appName: string;
  deployment: Deployment;
  defaultVersion?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState(defaultVersion ?? "");
  const [description, setDescription] = useState("");
  const [mandatory, setMandatory] = useState(false);
  const [rollout, setRollout] = useState("");
  const [progress, setProgress] = useState(0);

  const release = useMutation({
    mutationFn: () =>
      api.release(
        appName,
        deployment.name,
        file!,
        { appVersion: version.trim(), description, isMandatory: mandatory, rollout: rollout ? Number(rollout) : null },
        setProgress,
      ),
    onSuccess: async (r) => {
      await Promise.all(
        [["history", appName], ["deployments", appName], ["metrics", appName]].map((queryKey) => qc.invalidateQueries({ queryKey })),
      );
      toast(`${r.package.label} released to ${deployment.name}`);
      onClose();
    },
  });
  const rolloutValid = !rollout || (Number.isInteger(Number(rollout)) && Number(rollout) >= 1 && Number(rollout) <= 100);

  return (
    <Modal
      title={`Upload release to ${deployment.name}`}
      onClose={() => !release.isPending && onClose()}
      footer={
        <>
          {release.isPending && (
            <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          <span className="sp" />
          <Button type="button" variant="ghost" disabled={release.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="release-upload"
            variant="primary"
            icon="upload"
            disabled={!file || !version.trim() || !rolloutValid}
            loading={release.isPending}
          >
            Release
          </Button>
        </>
      }
    >
      <form
        id="release-upload"
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          release.mutate();
        }}
      >
        <label className="field">
          <span className="label">Package (.zip)</span>
          <input
            className="input file"
            type="file"
            accept=".zip,application/zip"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <span className="hint">
            {file ? `${file.name} · ${formatSize(file.size)}` : "Zip contents = the bundle output folder (JS bundle and assets), same as `patchkite release`."}
          </span>
        </label>
        <Field
          label="Target binary version"
          placeholder="1.0.0, 1.2.x, ^1.2.3"
          required
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          hint="Store binary versions allowed to receive this update (semver range)."
        />
        <label className="field">
          <span className="label">Description</span>
          <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} />
        </label>
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
        <p className="hint">Signed releases (code signing) are created via the CLI with the <span className="mono">-k</span> option.</p>
        <ErrorText error={release.error} />
      </form>
    </Modal>
  );
}
