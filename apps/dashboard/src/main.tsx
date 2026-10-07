import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api, session } from "./api";
import { Icon } from "./components/icons";
import { ConfirmProvider, ToastProvider } from "./components/ui";
import { AppPage } from "./pages/AppPage";
import { AppsPage } from "./pages/AppsPage";
import { AuthPage } from "./pages/AuthPage";
import { CliLoginPage } from "./pages/CliLoginPage";
import { KeysPage } from "./pages/KeysPage";
import { UsersPage } from "./pages/UsersPage";
import "./styles/patchkite-tokens.css";
import "./styles/patchkite-bundle.css";
import "./styles/app.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });

const hostnameSearch = (s: Record<string, unknown>) => ({ hostname: typeof s.hostname === "string" ? s.hostname : undefined });

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: hostnameSearch,
  component: function Login() {
    return <AuthPage mode="login" hostname={loginRoute.useSearch().hostname} />;
  },
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  validateSearch: hostnameSearch,
  component: function Register() {
    return <AuthPage mode="register" hostname={registerRoute.useSearch().hostname} />;
  },
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  beforeLoad: ({ location }) => {
    if (!session.get()) {
      const hostname = location.pathname.endsWith("/cli-login") ? (location.search as { hostname?: string }).hostname : undefined;
      throw redirect({ to: "/login", search: { hostname } });
    }
  },
  component: Shell,
});

function Shell() {
  const navigate = useNavigate();
  const account = useQuery({ queryKey: ["account"], queryFn: api.account });
  const apps = useQuery({ queryKey: ["apps"], queryFn: api.apps });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const crumbs = crumbsFor(pathname);

  return (
    <div className="shell">
      <aside className="side" aria-label="Navigation">
        <div className="ws">
          <img src={`${import.meta.env.BASE_URL}patchkite-symbol.svg`} alt="" />
          <span>
            Patchkite
            <small>OTA Console</small>
          </span>
        </div>
        <Link to="/" className="sitem" activeProps={{ className: "on" }} activeOptions={{ exact: true }}>
          <Icon name="grid" size={15} />
          <span className="sl">Apps</span>
          {apps.data && <span className="ct">{apps.data.length}</span>}
        </Link>
        <Link to="/keys" className="sitem" activeProps={{ className: "on" }}>
          <Icon name="key" size={15} />
          <span className="sl">Account</span>
        </Link>
        {account.data?.isAdmin && (
          <Link to="/users" className="sitem" activeProps={{ className: "on" }}>
            <Icon name="users" size={15} />
            <span className="sl">Users</span>
          </Link>
        )}
        {!!apps.data?.length && (
          <div className="app-links">
            <div className="sgroup-h">Apps</div>
            {apps.data.map((a) => (
              <Link key={a.name} to="/apps/$appName" params={{ appName: a.name }} className="sitem" activeProps={{ className: "on" }}>
                <span className="pico" style={{ ["--c" as string]: `var(--${a.platform === "flutter" ? "teal" : "blue"})` }}>
                  <Icon name="smartphone" size={12} />
                </span>
                <span className="trunc">{a.name}</span>
              </Link>
            ))}
          </div>
        )}
        <div className="side-foot">
          <span className="who trunc grow" title={account.data?.email}>{account.data?.email}</span>
          <button
            className="ibtn ibtn-sm"
            aria-label="Sign out"
            title="Sign out"
            onClick={async () => {
              await api.logout().catch(() => {});
              session.clear();
              queryClient.clear();
              void navigate({ to: "/login", search: { hostname: undefined } });
            }}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (i === crumbs.length - 1 ? <b key={c}>{c}</b> : <span key={c}>{c} /</span>))}
          </nav>
        </div>
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function crumbsFor(pathname: string): string[] {
  const p = pathname.replace(/^\/web/, "");
  if (p.startsWith("/apps/")) return ["Apps", decodeURIComponent(p.split("/")[2] ?? "")];
  if (p.startsWith("/keys")) return ["Account"];
  if (p.startsWith("/users")) return ["Admin", "Users"];
  if (p.startsWith("/cli-login")) return ["Account", "CLI login"];
  return ["Apps"];
}

const appsRoute = createRoute({ getParentRoute: () => shellRoute, path: "/", component: AppsPage });
const appRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/apps/$appName",
  component: function App() {
    return <AppPage appName={appRoute.useParams().appName} />;
  },
});
const keysRoute = createRoute({ getParentRoute: () => shellRoute, path: "/keys", component: KeysPage });
const usersRoute = createRoute({ getParentRoute: () => shellRoute, path: "/users", component: UsersPage });
const cliLoginRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/cli-login",
  validateSearch: hostnameSearch,
  component: function CliLogin() {
    return <CliLoginPage hostname={cliLoginRoute.useSearch().hostname ?? "cli"} />;
  },
});

const router = createRouter({
  routeTree: rootRoute.addChildren([loginRoute, registerRoute, shellRoute.addChildren([appsRoute, appRoute, keysRoute, usersRoute, cliLoginRoute])]),
  basepath: "/web",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
