import type { Prisma } from "../generated/client";
import { TEAM_NAME_MAX_LENGTH } from "../authz/teams";

type TeamSyncClient = Pick<Prisma.TransactionClient, "team" | "teamMember">;

export type OidcTeamSyncResult = {
  createdTeamIds: string[];
  addedTeamIds: string[];
  removedTeamIds: string[];
};

// Team name for a provider group that carries the automatic team prefix, or
// null when the group is not meant to become a team.
export const teamNameFromOidcGroup = (
  group: string,
  prefix: string,
): string | null => {
  if (!prefix || !group.startsWith(prefix)) return null;
  const name = group.slice(prefix.length).trim();
  if (name.length === 0) return null;
  return name.slice(0, TEAM_NAME_MAX_LENGTH);
};

// Reconcile the provider-managed team memberships of a user with the groups of
// their latest sign-in:
// - groups carrying the automatic prefix get a team when they have none yet;
// - the user joins every team linked to one of their groups;
// - memberships synced from the provider are removed when the group is gone.
// Members added by hand in ExcaliDash are never added, changed or removed here.
export const syncOidcTeamMemberships = async (params: {
  tx: TeamSyncClient;
  userId: string;
  groups: string[];
  teamGroupPrefix: string;
}): Promise<OidcTeamSyncResult> => {
  const { tx, userId, teamGroupPrefix } = params;
  const groups = Array.from(new Set(params.groups));

  const createdTeamIds: string[] = [];
  for (const group of groups) {
    const name = teamNameFromOidcGroup(group, teamGroupPrefix);
    if (!name) continue;
    const existing = await tx.team.findUnique({
      where: { oidcGroup: group },
      select: { id: true },
    });
    if (existing) continue;
    const created = await tx.team.create({
      data: { name, oidcGroup: group },
      select: { id: true },
    });
    createdTeamIds.push(created.id);
  }

  const linkedTeams =
    groups.length > 0
      ? await tx.team.findMany({
          where: { oidcGroup: { in: groups } },
          select: { id: true },
        })
      : [];
  const linkedTeamIds = new Set(linkedTeams.map((team) => team.id));

  const memberships = await tx.teamMember.findMany({
    where: { userId },
    select: { id: true, teamId: true, source: true },
  });
  const memberTeamIds = new Set(memberships.map((m) => m.teamId));

  const addedTeamIds: string[] = [];
  for (const teamId of linkedTeamIds) {
    if (memberTeamIds.has(teamId)) continue;
    await tx.teamMember.create({
      data: { teamId, userId, role: "member", source: "oidc" },
    });
    addedTeamIds.push(teamId);
  }

  const stale = memberships.filter(
    (m) => m.source === "oidc" && !linkedTeamIds.has(m.teamId),
  );
  if (stale.length > 0) {
    await tx.teamMember.deleteMany({
      where: { id: { in: stale.map((m) => m.id) } },
    });
  }

  return {
    createdTeamIds,
    addedTeamIds,
    removedTeamIds: stale.map((m) => m.teamId),
  };
};
