import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AdminUser } from "../api";
import { Badge, Button, CopyButton, ErrorText, Field, Panel, formatDate, useConfirm, useToast } from "../components/ui";

/** Admin page: create accounts, reset passwords, manage roles, and delete users. */
export function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const account = useQuery({ queryKey: ["account"], queryFn: api.account });
  const users = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: !!account.data?.isAdmin });
  const [email, setEmail] = useState("");
  /** Most recent temporary password, shown once. */
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });

  const add = useMutation({
    mutationFn: () => api.addUser(email, false),
    onSuccess: async (r) => {
      await refresh();
      if (r.password) setSecret({ email, password: r.password });
      toast(`Account ${email} created`);
      setEmail("");
    },
  });
  const reset = useMutation({
    mutationFn: (u: AdminUser) => api.resetPassword(u.email),
    onSuccess: (password, u) => setSecret({ email: u.email, password }),
  });
  const role = useMutation({
    mutationFn: (u: AdminUser) => api.setAdmin(u.email, !u.isAdmin),
    onSuccess: async (_r, u) => {
      await refresh();
      toast(u.isAdmin ? `${u.email} is no longer an admin` : `${u.email} is now an admin`);
    },
  });
  const remove = useMutation({
    mutationFn: (u: AdminUser) => api.removeUser(u.email, u.ownedApps ? account.data?.email : undefined),
    onSuccess: async (_r, u) => {
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ["apps"] })]);
      toast(`User ${u.email} deleted`);
    },
  });
  const error = reset.error ?? role.error ?? remove.error;

  if (account.data && !account.data.isAdmin) return <ErrorText error={new Error("This page is for server admins only.")} />;

  return (
    <>
      <header className="page-h">
        <div>
          <h1>Users</h1>
          <p>Accounts that can sign in to this server. Disable open registration with <span className="mono">ALLOW_REGISTRATION=false</span>.</p>
        </div>
      </header>
      <Panel title="Create account">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label="Email" type="email" placeholder="dev@company.com" required value={email} onChange={(e) => setEmail(e.target.value)} error={add.error?.message} />
          <Button variant="primary" icon="plus" disabled={!email} loading={add.isPending}>
            Create account
          </Button>
        </form>
        {secret && (
          <>
            <div className="secret">
              <span className="mono">{secret.password}</span>
              <CopyButton value={secret.password} label="Copy password" />
            </div>
            <span className="hint">
              Temporary password for {secret.email}. Share it with the user and ask them to change it on the Account page. It won't be shown again.
            </span>
          </>
        )}
      </Panel>
      <Panel title={`All users${users.data ? ` (${users.data.length})` : ""}`}>
        {error && <ErrorText error={error} />}
        <ul className="list">
          {users.data?.map((u) => {
            const self = u.email === account.data?.email;
            return (
              <li key={u.email}>
                <div className="grow">
                  <span className="row">
                    {u.email}
                    {u.isAdmin && <Badge tone="accent">Admin</Badge>}
                    {self && <Badge>You</Badge>}
                  </span>
                  <small>
                    {u.name} · {u.ownedApps} {u.ownedApps === 1 ? "app" : "apps"} · joined {formatDate(u.createdTime)}
                  </small>
                </div>
                <Button variant="ghost" size="sm" disabled={role.isPending} onClick={() => role.mutate(u)}>
                  {u.isAdmin ? "Revoke admin" : "Make admin"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={reset.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Reset password for ${u.email}?`,
                        body: "A new temporary password will be generated. All of this user's login sessions and access keys will be revoked, including those used by CI.",
                        confirm: "Reset password",
                        danger: true,
                      })
                    )
                      reset.mutate(u);
                  }}
                >
                  Reset password
                </Button>
                {!self && (
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Delete ${u.email}?`,
                          body: u.ownedApps
                            ? `This user's ${u.ownedApps === 1 ? "app" : `${u.ownedApps} apps`} will be transferred to your account. Their access keys and collaborator access will also be removed.`
                            : "This user's access keys and collaborator access will also be removed.",
                          confirm: "Delete user",
                          danger: true,
                        })
                      )
                        remove.mutate(u);
                    }}
                  >
                    Delete
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Panel>
    </>
  );
}
