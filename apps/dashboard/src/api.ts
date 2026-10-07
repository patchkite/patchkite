import type { AccessKey, App, Deployment, DeploymentMetrics, OS, Package, PatchMetadata, Platform } from "@patchkite/shared";

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const TOKEN_KEY = "patchkite.accessKey";

export const serverHost = BASE ? new URL(BASE).host : window.location.host;

export const session = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (key: string) => {
    try {
      localStorage.setItem(TOKEN_KEY, key);
    } catch {}
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {}
  },
};

export interface AdminUser {
  email: string;
  name: string;
  isAdmin: boolean;
  createdTime: number;
  ownedApps: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const token = session.get();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (res.status === 401 && token) {
    session.clear();
    window.location.assign(`${import.meta.env.BASE_URL}login`);
  }
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText);
  return json as T;
}

/** Event counts per day (UTC). */
export interface DailyMetric {
  day: string;
  downloaded: number;
  installed: number;
  failed: number;
}

/** Release metadata from the dashboard (equivalent of the `patchkite release` options). */
export interface ReleaseInfo {
  appVersion: string;
  description?: string;
  isMandatory?: boolean;
  rollout?: number | null;
}

/** Multipart upload via XHR so upload progress can be shown. */
function upload<T>(path: string, file: File, info: ReleaseInfo, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}${path}`);
    const token = session.get();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (ev) => ev.lengthComputable && onProgress?.(ev.loaded / ev.total);
    xhr.onerror = () => reject(new ApiError(0, "Connection to the server was lost"));
    xhr.onload = () => {
      let json: { error?: string } = {};
      try {
        json = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(json as T);
      else reject(new ApiError(xhr.status, json.error ?? xhr.statusText));
    };
    const form = new FormData();
    form.set("packageInfo", JSON.stringify(info));
    form.set("package", file, file.name);
    xhr.send(form);
  });
}

const e = encodeURIComponent;
const dep = (app: string, d: string) => `/apps/${e(app)}/deployments/${e(d)}`;

export const api = {
  health: () => request<{ status: string }>("GET", "/health"),
  login: (email: string, password: string) => request<{ accessKey: string }>("POST", "/auth/login", { email, password, hostname: "web" }),
  register: (email: string, password: string, name?: string) =>
    request<{ accessKey: string }>("POST", "/auth/register", { email, password, name, hostname: "web" }),
  logout: () => request("POST", "/auth/logout"),
  account: () => request<{ account: { email: string; name: string; isAdmin: boolean } }>("GET", "/account").then((r) => r.account),
  changePassword: (currentPassword: string, newPassword: string) => request("PATCH", "/account", { currentPassword, newPassword }),

  users: () => request<{ users: AdminUser[] }>("GET", "/admin/users").then((r) => r.users),
  addUser: (email: string, isAdmin: boolean) => request<{ password?: string }>("POST", "/admin/users", { email, isAdmin }),
  setAdmin: (email: string, isAdmin: boolean) => request("PATCH", `/admin/users/${e(email)}`, { isAdmin }),
  resetPassword: (email: string) => request<{ password: string }>("POST", `/admin/users/${e(email)}/reset-password`).then((r) => r.password),
  removeUser: (email: string, transferTo?: string) =>
    request("DELETE", `/admin/users/${e(email)}${transferTo ? `?transferTo=${e(transferTo)}` : ""}`),

  accessKeys: () => request<{ accessKeys: AccessKey[] }>("GET", "/accessKeys").then((r) => r.accessKeys),
  addAccessKey: (friendlyName: string, ttl?: number, createdBy = "web") =>
    request<{ accessKey: AccessKey & { key: string } }>("POST", "/accessKeys", { friendlyName, ttl, createdBy }).then((r) => r.accessKey),
  removeAccessKey: (name: string) => request("DELETE", `/accessKeys/${e(name)}`),

  apps: () => request<{ apps: App[] }>("GET", "/apps").then((r) => r.apps),
  addApp: (name: string, os: OS, platform: Platform) => request<{ app: App }>("POST", "/apps", { name, os, platform }).then((r) => r.app),
  removeApp: (name: string) => request("DELETE", `/apps/${e(name)}`),
  renameApp: (name: string, newName: string) => request("PATCH", `/apps/${e(name)}`, { name: newName }),
  transferApp: (name: string, email: string) => request("POST", `/apps/${e(name)}/transfer/${e(email)}`),
  addCollaborator: (app: string, email: string) => request("POST", `/apps/${e(app)}/collaborators/${e(email)}`),
  removeCollaborator: (app: string, email: string) => request("DELETE", `/apps/${e(app)}/collaborators/${e(email)}`),

  deployments: (app: string) => request<{ deployments: Deployment[] }>("GET", `/apps/${e(app)}/deployments`).then((r) => r.deployments),
  addDeployment: (app: string, name: string) => request("POST", `/apps/${e(app)}/deployments`, { name }),
  renameDeployment: (app: string, d: string, name: string) => request("PATCH", dep(app, d), { name }),
  removeDeployment: (app: string, d: string) => request("DELETE", dep(app, d)),
  clearHistory: (app: string, d: string) => request("DELETE", `${dep(app, d)}/history`),
  release: (app: string, d: string, file: File, info: ReleaseInfo, onProgress?: (fraction: number) => void) =>
    upload<{ package: Package }>(`${dep(app, d)}/release`, file, info, onProgress),
  history: (app: string, d: string) => request<{ history: Package[] }>("GET", `${dep(app, d)}/history`).then((r) => r.history),
  metricsDaily: (app: string, d: string, days: number, label?: string) =>
    request<{ daily: DailyMetric[] }>("GET", `${dep(app, d)}/metrics/daily?days=${days}${label ? `&label=${e(label)}` : ""}`).then((r) => r.daily),
  metrics: (app: string, d: string) => request<{ metrics: DeploymentMetrics }>("GET", `${dep(app, d)}/metrics`).then((r) => r.metrics),
  patch: (app: string, d: string, packageInfo: PatchMetadata) => request<{ package: Package }>("PATCH", `${dep(app, d)}/release`, { packageInfo }),
  promote: (app: string, src: string, dest: string, packageInfo: PatchMetadata = {}) =>
    request<{ package: Package }>("POST", `${dep(app, src)}/promote/${e(dest)}`, { packageInfo }),
  rollback: (app: string, d: string, label?: string) =>
    request<{ package: Package }>("POST", `${dep(app, d)}/rollback${label ? `/${e(label)}` : ""}`),
};
