import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { api, serverHost, session } from "../api";
import { Button, ErrorText, Field } from "../components/ui";

const BASE = import.meta.env.BASE_URL;

export function AuthPage({ mode, hostname }: { mode: "login" | "register"; hostname?: string }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = useMutation({
    mutationFn: () => (mode === "login" ? api.login(email, password) : api.register(email, password)),
    onSuccess: ({ accessKey }) => {
      session.set(accessKey);
      if (hostname) void navigate({ to: "/cli-login", search: { hostname } });
      else void navigate({ to: "/" });
    },
  });
  const other = mode === "login" ? "register" : "login";
  const isLogin = mode === "login";

  let sub = isLogin ? "Use your team account to manage releases." : "The first account on this server automatically becomes an admin.";
  if (hostname) sub = `After ${isLogin ? "you sign in" : "your account is created"}, an access key for the CLI on ${hostname} will be created.`;

  return (
    <main className="auth" id="main">
      <aside className="auth-aside">
        <Brand />
        <div className="auth-pitch">
          <p className="lede">Ship fixes to devices without waiting for store review.</p>
          <p className="sub">OTA updates for React Native and Flutter Android: diff updates, code signing, and automatic rollback when an update crashes.</p>
        </div>
        <ReleaseLanes />
        <ServerStatus />
      </aside>

      <section className="auth-form">
        <div className="auth-card">
          <Brand compact />
          <header>
            <h1>{isLogin ? "Sign in to Patchkite" : "Create a Patchkite account"}</h1>
            <p className="sub">{sub}</p>
          </header>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit.mutate();
            }}
          >
            <Field label="Email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            <Field
              label="Password"
              type="password"
              minLength={8}
              hint={isLogin ? undefined : "At least 8 characters."}
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <ErrorText error={submit.error} />
            <Button variant="primary" size="lg" block loading={submit.isPending}>
              {isLogin ? "Sign in" : "Create account"}
            </Button>
          </form>
          <p className="alt">
            {isLogin ? "Don't have an account? " : "Already have an account? "}
            <a href={`${BASE}${other}${hostname ? `?hostname=${encodeURIComponent(hostname)}` : ""}`}>{isLogin ? "Sign up" : "Sign in"}</a>
          </p>
          <ServerStatus compact />
        </div>
      </section>
    </main>
  );
}

function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className={`auth-brand${compact ? " compact" : ""}`}>
      <img className="logo-light" src={`${BASE}patchkite-logo.svg`} alt="Patchkite" />
      <img className="logo-dark" src={`${BASE}patchkite-logo-dark.svg`} alt="Patchkite" />
    </div>
  );
}

function ServerStatus({ compact }: { compact?: boolean }) {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, retry: false, refetchInterval: 30_000 });
  const state = health.isPending ? "pending" : health.isSuccess ? "ok" : "down";
  const label = { pending: "Checking…", ok: "Connected", down: "Unreachable" }[state];
  return (
    <div className={`auth-server${compact ? " compact" : ""}`}>
      <span className="k">Server</span>
      <span className="mono host">{serverHost}</span>
      <span className={`state ${state}`} role="status">
        <i aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}

// The n-th column on the rail; Production lags Staging by one label.
const COL = [112, 182, 252, 322, 392];
const STAGING = { y: 34, labels: ["v12", "v13", "v14", "v15"], from: 1 };
const PRODUCTION = { y: 92, labels: ["v11", "v12", "v13", "v14"], from: 0 };

function Lane({ name, y, labels, from, labelSide }: typeof STAGING & { name: string; labelSide: "above" | "below" }) {
  const xs = labels.map((_, i) => COL[from + i]);
  const ty = labelSide === "above" ? y - 14 : y + 22;
  return (
    <g className={`lane ${name.toLowerCase()}`}>
      <text className="lane-name" x="0" y={y + 4}>
        {name}
      </text>
      <line className="rail gap" x1="80" y1={y} x2={xs[0]} y2={y} />
      <line className="rail" x1={xs[0]} y1={y} x2={xs[xs.length - 1]} y2={y} pathLength={1} />
      {labels.map((l, i) => {
        const last = i === labels.length - 1;
        return (
          <g key={l} className={`stop${last ? " current" : ""}`} style={{ "--i": i } as CSSProperties}>
            {last && <circle className="halo" cx={xs[i]} cy={y} r="9" />}
            <circle className="dot" cx={xs[i]} cy={y} r={last ? 4.5 : 3.5} />
            <text x={xs[i]} y={ty} textAnchor="middle">
              {l}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function ReleaseLanes() {
  const x = COL[3];
  return (
    <figure className="auth-lanes">
      <svg viewBox="0 0 412 120" role="img" aria-label="Illustration: release v14 promoted from Staging to Production, v15 still in Staging.">
        <Lane name="Staging" {...STAGING} labelSide="above" />
        <Lane name="Production" {...PRODUCTION} labelSide="below" />
        <g className="promote">
          <line x1={x} y1={STAGING.y + 9} x2={x} y2={PRODUCTION.y - 10} pathLength={1} />
          <path d={`M${x - 3.5} ${PRODUCTION.y - 14} L${x} ${PRODUCTION.y - 9.5} L${x + 3.5} ${PRODUCTION.y - 14}`} />
          <text x={x - 8} y={(STAGING.y + PRODUCTION.y) / 2 + 3} textAnchor="end">
            promote
          </text>
        </g>
      </svg>
    </figure>
  );
}
