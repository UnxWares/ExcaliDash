import type { PrismaClient } from "../generated/client";

export const TEAM_NAME_MAX_LENGTH = 100;
export const TEAM_DESCRIPTION_MAX_LENGTH = 500;
export const TEAM_OIDC_GROUP_MAX_LENGTH = 255;

export type TeamRole = "member" | "manager";
export type TeamMemberSource = "manual" | "oidc";

export const normalizeTeamRole = (input: unknown): TeamRole | null => {
  if (input === "member" || input === "manager") return input;
  return null;
};

type TeamActor = { id: string; role: string };

export const isAdminActor = (actor: TeamActor): boolean =>
  actor.role === "ADMIN";

// Membership of the acting user in a team, or null when they are not a member.
export const getTeamMembership = async (params: {
  prisma: PrismaClient;
  teamId: string;
  userId: string;
}) =>
  params.prisma.teamMember.findUnique({
    where: {
      teamId_userId: { teamId: params.teamId, userId: params.userId },
    },
    select: { role: true, source: true },
  });

// Admins manage every team; managers manage the members of their own team.
export const canManageTeamMembers = async (params: {
  prisma: PrismaClient;
  teamId: string;
  actor: TeamActor;
}): Promise<boolean> => {
  if (isAdminActor(params.actor)) return true;
  const membership = await getTeamMembership({
    prisma: params.prisma,
    teamId: params.teamId,
    userId: params.actor.id,
  });
  return membership?.role === "manager";
};
