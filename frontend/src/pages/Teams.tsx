import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { KeyRound, Plus, RefreshCw, Users } from "lucide-react";
import { Layout } from "../components/Layout";
import { ConfirmModal } from "../components/ConfirmModal";
import { useAuth } from "../context/AuthContext";
import * as api from "../api";
import type { Team, TeamDetails, TeamMember, TeamRole } from "../types";
import { displayFontFamily } from "../utils/displayFont";
import { getApiErrorMessage } from "../utils/getApiErrorMessage";
import { AdminStatusMessages } from "./admin/AdminShell";
import { useAdminCollections } from "./admin/useAdminCollections";
import { TeamDetailsCard } from "./teams/TeamDetailsCard";

const inputClass =
  "w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 placeholder:font-normal placeholder:text-slate-400 transition-colors focus:border-indigo-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100";

export const Teams: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    collections,
    loadCollections,
    handleSelectCollection,
    handleCreateCollection,
    handleEditCollection,
    handleDeleteCollection,
  } = useAdminCollections(navigate);

  const [teams, setTeams] = useState<Team[]>([]);
  const [canCreate, setCanCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<TeamDetails | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadTeams = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getTeams();
      setTeams(data.teams);
      setCanCreate(data.canCreate);
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to load teams"));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSelected = useCallback(async (teamId: string) => {
    try {
      setSelected(await api.getTeam(teamId));
    } catch (err) {
      setSelected(null);
      setError(getApiErrorMessage(err, "Failed to load the team"));
    }
  }, []);

  useEffect(() => {
    void loadCollections();
    void loadTeams();
  }, [loadCollections, loadTeams]);

  useEffect(() => {
    if (selectedId) void loadSelected(selectedId);
    else setSelected(null);
  }, [selectedId, loadSelected]);

  // Runs a change, then reloads the list and the open team.
  const run = async (
    action: () => Promise<unknown>,
    fallback: string,
    successMessage?: string,
  ) => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await action();
      if (successMessage) setSuccess(successMessage);
      await loadTeams();
      if (selectedId) await loadSelected(selectedId);
    } catch (err) {
      setError(getApiErrorMessage(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const team = await api.createTeam({
        name,
        oidcGroup: newGroup.trim() || null,
      });
      setNewName("");
      setNewGroup("");
      setCreateOpen(false);
      setSuccess(`Team ${team.name} created`);
      await loadTeams();
      setSelectedId(team.id);
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to create the team"));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setConfirmDelete(false);
    const { id, name } = selected;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api.deleteTeam(id);
      setSelectedId(null);
      setSuccess(`Team ${name} deleted`);
      await loadTeams();
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to delete the team"));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (member: TeamMember) => {
    if (!selected) return;
    const leaving = member.userId === user?.id;
    if (!leaving || selected.canEditGroup) {
      await run(
        () => api.removeTeamMember(selected.id, member.userId),
        "Failed to remove the member",
        leaving ? `You left ${selected.name}` : `${member.name} removed`,
      );
      return;
    }
    // Outside admins, leaving a team also hides it: close it before reloading.
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api.removeTeamMember(selected.id, member.userId);
      setSelectedId(null);
      setSuccess(`You left ${selected.name}`);
      await loadTeams();
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to leave the team"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout
      collections={collections}
      selectedCollectionId="TEAMS"
      onSelectCollection={handleSelectCollection}
      onCreateCollection={handleCreateCollection}
      onEditCollection={handleEditCollection}
      onDeleteCollection={handleDeleteCollection}
    >
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-6 flex min-w-0 flex-col justify-between gap-4 sm:mb-8 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <h1
              className="pl-1 text-3xl text-slate-900 dark:text-white sm:text-5xl"
              style={{ fontFamily: displayFontFamily }}
            >
              Teams
            </h1>
            <p className="mt-2 text-sm font-medium text-slate-600 dark:text-neutral-400">
              Share collections and drawings with a whole team at once
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void loadTeams()}
              disabled={loading}
              className="ui-button-secondary px-4"
            >
              <RefreshCw size={16} /> Refresh
            </button>
            {canCreate && (
              <button
                onClick={() => setCreateOpen((open) => !open)}
                className="ui-button-primary px-4"
              >
                <Plus size={16} /> New team
              </button>
            )}
          </div>
        </div>

        <AdminStatusMessages success={success} error={error} />

        {canCreate && createOpen && (
          <form
            onSubmit={handleCreate}
            className="mb-6 grid gap-3 rounded-2xl border-2 border-slate-800 bg-white p-4 shadow-[3px_3px_0px_0px_rgba(30,41,59,0.9)] dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,0.18)] sm:grid-cols-[1fr_1fr_auto] sm:items-end sm:p-6"
          >
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500 dark:text-neutral-400">
                Name
              </span>
              <input
                value={newName}
                maxLength={100}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Design"
                className={inputClass}
                autoFocus
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-slate-500 dark:text-neutral-400">
                Identity provider group (optional)
              </span>
              <input
                value={newGroup}
                maxLength={255}
                onChange={(event) => setNewGroup(event.target.value)}
                placeholder="design-team"
                className={inputClass}
              />
            </label>
            <button
              type="submit"
              disabled={busy || !newName.trim()}
              className="ui-button-primary px-4"
            >
              <Plus size={16} /> Create
            </button>
          </form>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <ul className="space-y-2" aria-label="Teams">
            {!loading && teams.length === 0 && (
              <li className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 p-8 text-center text-slate-500 dark:border-neutral-700 dark:text-neutral-400">
                <Users size={28} strokeWidth={1.5} />
                <p className="text-sm font-semibold">
                  {canCreate
                    ? "No teams yet. Create one, or let your identity provider groups create them."
                    : "You are not part of any team yet."}
                </p>
              </li>
            )}
            {teams.map((team) => (
              <li key={team.id}>
                <button
                  onClick={() =>
                    setSelectedId((current) =>
                      current === team.id ? null : team.id,
                    )
                  }
                  aria-current={selectedId === team.id}
                  className={clsx(
                    "flex w-full items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition-colors",
                    selectedId === team.id
                      ? "border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-900/20"
                      : "border-slate-200 bg-white hover:border-slate-400 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-neutral-500",
                  )}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">
                    <Users size={16} strokeWidth={2.5} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-slate-900 dark:text-white">
                      {team.name}
                    </span>
                    <span className="block truncate text-xs font-medium text-slate-500 dark:text-neutral-400">
                      {team.memberCount}{" "}
                      {team.memberCount === 1 ? "member" : "members"}
                      {team.myRole === "manager" && " · you manage it"}
                    </span>
                  </span>
                  {team.oidcGroup && (
                    <span
                      className="shrink-0 text-indigo-500 dark:text-indigo-300"
                      title={`Synced from ${team.oidcGroup}`}
                    >
                      <KeyRound size={15} />
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>

          <div>
            {selected ? (
              <TeamDetailsCard
                team={selected}
                currentUserId={user?.id ?? null}
                busy={busy}
                onSave={(changes) =>
                  run(
                    () => api.updateTeam(selected.id, changes),
                    "Failed to save the team",
                    "Team saved",
                  )
                }
                onDelete={() => setConfirmDelete(true)}
                onAddMember={(identifier: string, role: TeamRole) =>
                  run(
                    () => api.addTeamMember(selected.id, identifier, role),
                    "Failed to add the member",
                  )
                }
                onChangeRole={(member, role) =>
                  run(
                    () =>
                      api.updateTeamMemberRole(
                        selected.id,
                        member.userId,
                        role,
                      ),
                    "Failed to change the role",
                  )
                }
                onRemoveMember={handleRemoveMember}
              />
            ) : (
              teams.length > 0 && (
                <p className="rounded-2xl border-2 border-dashed border-slate-300 p-8 text-center text-sm font-semibold text-slate-500 dark:border-neutral-700 dark:text-neutral-400">
                  Select a team to see its members.
                </p>
              )
            )}
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmDelete}
        title="Delete team"
        message={
          selected
            ? `Delete ${selected.name}? Its members lose the access they had through the team. The shared collections and drawings stay with their owners.`
            : ""
        }
        confirmText="Delete team"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
        isDangerous
      />
    </Layout>
  );
};
