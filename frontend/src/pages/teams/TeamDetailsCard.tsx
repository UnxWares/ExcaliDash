import React, { useEffect, useState } from "react";
import {
  KeyRound,
  LogOut,
  Plus,
  Save,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import * as api from "../../api";
import { PlayfulSelect } from "../../components/PlayfulSelect";
import { UserAvatar } from "../../components/UserAvatar";
import type { TeamDetails, TeamMember, TeamRole } from "../../types";

type Props = {
  team: TeamDetails;
  currentUserId: string | null;
  busy: boolean;
  onSave: (changes: {
    name?: string;
    description?: string | null;
    oidcGroup?: string | null;
  }) => Promise<void>;
  onDelete: () => void;
  onAddMember: (identifier: string, role: TeamRole) => Promise<void>;
  onChangeRole: (member: TeamMember, role: TeamRole) => Promise<void>;
  onRemoveMember: (member: TeamMember) => Promise<void>;
};

const cardClass =
  "overflow-hidden rounded-2xl border-2 border-slate-800 bg-white shadow-[3px_3px_0px_0px_rgba(30,41,59,0.9)] dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,0.18)]";
const inputClass =
  "w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 placeholder:font-normal placeholder:text-slate-400 transition-colors focus:border-indigo-400 focus:outline-none disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100";
const labelClass =
  "mb-1 block text-xs font-semibold text-slate-500 dark:text-neutral-400";

const roleOptions = [
  { label: "Member", value: "member" },
  { label: "Manager", value: "manager" },
];

export const TeamDetailsCard: React.FC<Props> = ({
  team,
  currentUserId,
  busy,
  onSave,
  onDelete,
  onAddMember,
  onChangeRole,
  onRemoveMember,
}) => {
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const [oidcGroup, setOidcGroup] = useState(team.oidcGroup ?? "");
  const [query, setQuery] = useState("");
  const [addRole, setAddRole] = useState<TeamRole>("member");
  const [candidates, setCandidates] = useState<
    { id: string; name: string; email: string }[]
  >([]);

  useEffect(() => {
    setName(team.name);
    setDescription(team.description ?? "");
    setOidcGroup(team.oidcGroup ?? "");
    setQuery("");
    setCandidates([]);
  }, [team]);

  useEffect(() => {
    if (!team.canManage) return;
    const q = query.trim();
    if (q.length < 2) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const users = await api.resolveTeamMemberCandidates(team.id, q);
        if (!cancelled) setCandidates(users);
      } catch {
        if (!cancelled) setCandidates([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query, team.id, team.canManage]);

  const trimmedGroup = oidcGroup.trim();
  const isDirty =
    name.trim() !== team.name ||
    description.trim() !== (team.description ?? "") ||
    (team.canEditGroup && trimmedGroup !== (team.oidcGroup ?? ""));

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    await onSave({
      name: name.trim(),
      description: description.trim() || null,
      ...(team.canEditGroup && { oidcGroup: trimmedGroup || null }),
    });
  };

  const handleAdd = async (identifier: string) => {
    await onAddMember(identifier, addRole);
    setQuery("");
    setCandidates([]);
  };

  const myMembership = team.members.find((m) => m.userId === currentUserId);

  return (
    <section className={cardClass} aria-label={`Team ${team.name}`}>
      {team.canManage ? (
        <form
          onSubmit={handleSave}
          className="space-y-4 border-b-2 border-slate-100 p-4 dark:border-neutral-800 sm:p-6"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="team-name">
                Name
              </label>
              <input
                id="team-name"
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="team-group">
                Identity provider group
              </label>
              <input
                id="team-group"
                value={oidcGroup}
                maxLength={255}
                disabled={!team.canEditGroup}
                placeholder="Not linked"
                onChange={(event) => setOidcGroup(event.target.value)}
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="team-description">
              Description
            </label>
            <input
              id="team-description"
              value={description}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              className={inputClass}
            />
          </div>
          <p className="text-xs font-medium text-slate-500 dark:text-neutral-400">
            {team.canEditGroup
              ? "Members of a linked group join the team when they sign in and leave it when they are removed from the group. Unlinking keeps them as members added by hand; linking another group removes them."
              : "Only admins can link the team to an identity provider group."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy || !isDirty || !name.trim()}
              className="ui-button-primary px-4"
            >
              <Save size={16} /> Save
            </button>
            {team.canEditGroup && (
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                className="ui-button-secondary px-4 text-rose-600 dark:text-rose-400"
              >
                <Trash2 size={16} /> Delete team
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="border-b-2 border-slate-100 p-4 dark:border-neutral-800 sm:p-6">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            {team.name}
          </h2>
          {team.description && (
            <p className="mt-1 text-sm text-slate-600 dark:text-neutral-400">
              {team.description}
            </p>
          )}
          {team.oidcGroup && (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-neutral-400">
              <KeyRound size={13} /> Synced from {team.oidcGroup}
            </p>
          )}
          {myMembership?.source === "manual" && (
            <button
              type="button"
              onClick={() => void onRemoveMember(myMembership)}
              disabled={busy}
              className="ui-button-secondary mt-4 px-4"
            >
              <LogOut size={16} /> Leave team
            </button>
          )}
        </div>
      )}

      {team.canManage && (
        <div className="relative border-b-2 border-slate-100 p-4 dark:border-neutral-800 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Add people by name or email"
                aria-label="Add people to the team"
                className={`${inputClass} pl-9`}
              />
            </div>
            <PlayfulSelect
              ariaLabel="Role for new members"
              portal
              value={addRole}
              onChange={(value) => setAddRole(value as TeamRole)}
              options={roleOptions}
              align="right"
              variant="playful"
              buttonClassName="px-2.5 py-2"
            />
          </div>
          {candidates.length > 0 && (
            <div className="ui-menu absolute left-4 right-4 top-full z-[200] mt-1 sm:left-6 sm:right-6">
              {candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => void handleAdd(candidate.id)}
                  className="ui-menu-item gap-3"
                >
                  <UserAvatar name={candidate.name} size="sm" />
                  <div className="min-w-0 flex-1 text-left">
                    <div className="truncate text-xs font-semibold text-slate-850 dark:text-neutral-100">
                      {candidate.name}
                    </div>
                    <div className="truncate text-[10px] font-medium text-slate-500 dark:text-neutral-400">
                      {candidate.email}
                    </div>
                  </div>
                  <Plus size={15} className="text-slate-400" strokeWidth={3} />
                  <span className="sr-only">Add {candidate.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="p-4 sm:px-6">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-400 dark:text-neutral-500">
          <Users size={14} /> {team.members.length}{" "}
          {team.members.length === 1 ? "member" : "members"}
        </h3>
        {team.members.length === 0 ? (
          <p className="py-4 text-sm text-slate-500 dark:text-neutral-400">
            {team.oidcGroup
              ? "Members of the group appear here after they sign in."
              : "No members yet."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-neutral-800">
            {team.members.map((member) => {
              const isSynced = member.source === "oidc";
              return (
                <li
                  key={member.userId}
                  className="flex items-center gap-3 py-2"
                >
                  <UserAvatar name={member.name} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-800 dark:text-neutral-100">
                      {member.name}
                      {member.userId === currentUserId && (
                        <span className="ml-1 font-medium text-slate-400 dark:text-neutral-500">
                          (you)
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs font-medium text-slate-500 dark:text-neutral-400">
                      {member.email}
                    </div>
                  </div>
                  {isSynced && (
                    <span
                      className="hidden shrink-0 items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300 sm:inline-flex"
                      title="Managed in the identity provider group"
                    >
                      <KeyRound size={11} /> Synced
                    </span>
                  )}
                  {team.canManage ? (
                    <>
                      <PlayfulSelect
                        ariaLabel={`Role of ${member.name}`}
                        portal
                        value={member.role}
                        onChange={(value) =>
                          void onChangeRole(member, value as TeamRole)
                        }
                        options={roleOptions}
                        align="right"
                        size="sm"
                        variant="playful"
                        showCheck={false}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        onClick={() => void onRemoveMember(member)}
                        disabled={busy || isSynced}
                        title={
                          isSynced
                            ? "Remove them from the group in the identity provider"
                            : `Remove ${member.name}`
                        }
                        aria-label={`Remove ${member.name}`}
                        className="ui-icon-button h-8 w-8 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  ) : (
                    <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {member.role === "manager" ? "Manager" : "Member"}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
};
