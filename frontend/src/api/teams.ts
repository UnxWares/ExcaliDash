import type {
  Team,
  TeamDetails,
  TeamMember,
  TeamRole,
  TeamSummary,
} from "../types";
import { api } from "./client";

export type { Team, TeamDetails, TeamMember, TeamRole, TeamSummary };

export const getTeams = async (): Promise<{
  teams: Team[];
  canCreate: boolean;
}> => {
  const response = await api.get<{ teams: Team[]; canCreate: boolean }>(
    "/teams",
  );
  return response.data;
};

export const getTeam = async (teamId: string): Promise<TeamDetails> => {
  const response = await api.get<{ team: TeamDetails }>(`/teams/${teamId}`);
  return response.data.team;
};

export const createTeam = async (params: {
  name: string;
  description?: string | null;
  oidcGroup?: string | null;
}): Promise<Team> => {
  const response = await api.post<{ team: Team }>("/teams", params);
  return response.data.team;
};

export const updateTeam = async (
  teamId: string,
  params: {
    name?: string;
    description?: string | null;
    oidcGroup?: string | null;
  },
): Promise<Team> => {
  const response = await api.patch<{ team: Team }>(`/teams/${teamId}`, params);
  return response.data.team;
};

export const deleteTeam = async (teamId: string) => {
  const response = await api.delete<{ success: true }>(`/teams/${teamId}`);
  return response.data;
};

export const resolveTeamMemberCandidates = async (
  teamId: string,
  q: string,
): Promise<{ id: string; name: string; email: string }[]> => {
  const response = await api.get<{
    users: { id: string; name: string; email: string }[];
  }>(`/teams/${teamId}/member-resolve`, { params: { q } });
  return response.data.users;
};

export const addTeamMember = async (
  teamId: string,
  identifier: string,
  role: TeamRole = "member",
): Promise<TeamMember> => {
  const response = await api.post<{ member: TeamMember }>(
    `/teams/${teamId}/members`,
    { identifier, role },
  );
  return response.data.member;
};

export const updateTeamMemberRole = async (
  teamId: string,
  userId: string,
  role: TeamRole,
) => {
  const response = await api.patch<{ success: true }>(
    `/teams/${teamId}/members/${userId}`,
    { role },
  );
  return response.data;
};

export const removeTeamMember = async (teamId: string, userId: string) => {
  const response = await api.delete<{ success: true }>(
    `/teams/${teamId}/members/${userId}`,
  );
  return response.data;
};
