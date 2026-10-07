import { describe, expect, it } from "vitest";
import { decideUpdate, type HistoryEntry } from "../src/services/acquisition.js";

const pkg = (label: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  label,
  appVersion: "1.0.0",
  packageHash: `hash-${label}`,
  isDisabled: false,
  isMandatory: false,
  rollout: null,
  ...extra,
});

describe("decideUpdate", () => {
  it("returns latest for fresh install", () => {
    const d = decideUpdate([pkg("v1"), pkg("v2")], { appVersion: "1.0.0" });
    expect(d.kind).toBe("update");
    if (d.kind === "update") expect(d.package.label).toBe("v2");
  });

  it("reports up to date", () => {
    const d = decideUpdate([pkg("v1"), pkg("v2")], { appVersion: "1.0.0", packageHash: "hash-v2", label: "v2" });
    expect(d).toMatchObject({ kind: "none", shouldRunBinaryVersion: false });
  });

  it("marks mandatory when an intermediate release is mandatory", () => {
    const history = [pkg("v1"), pkg("v2", { isMandatory: true }), pkg("v3")];
    const d = decideUpdate(history, { appVersion: "1.0.0", packageHash: "hash-v1", label: "v1" });
    expect(d).toMatchObject({ kind: "update", isMandatory: true });
    const d2 = decideUpdate(history, { appVersion: "1.0.0", packageHash: "hash-v2", label: "v2" });
    expect(d2).toMatchObject({ kind: "update", isMandatory: false });
  });

  it("skips disabled and non-matching versions", () => {
    const history = [pkg("v1"), pkg("v2", { appVersion: "2.0.0" }), pkg("v3", { isDisabled: true })];
    const d = decideUpdate(history, { appVersion: "1.0" });
    expect(d.kind === "update" && d.package.label).toBe("v1");
  });

  it("asks for app update when binary is older than all ranges", () => {
    const d = decideUpdate([pkg("v1", { appVersion: "2.0.0" })], { appVersion: "1.0.0" });
    expect(d).toMatchObject({ kind: "none", updateAppVersion: true });
  });

  it("tells client to run binary when its update is gone", () => {
    const d = decideUpdate([], { appVersion: "1.0.0", packageHash: "hash-v9", label: "v9" });
    expect(d).toMatchObject({ kind: "none", shouldRunBinaryVersion: true });
  });

  it("respects rollout", () => {
    const history = [pkg("v1"), pkg("v2", { rollout: 0 as unknown as number })];
    const d = decideUpdate(history, { appVersion: "1.0.0", clientUniqueId: "abc" });
    expect(d.kind === "update" && d.package.label).toBe("v1");
  });

  it("filters flutter engine revision", () => {
    const history = [pkg("v1", { engineRevision: "aaa" }), pkg("v2", { engineRevision: "bbb" })];
    const d = decideUpdate(history, { appVersion: "1.0.0", engineRevision: "aaa" });
    expect(d.kind === "update" && d.package.label).toBe("v1");
  });
});
