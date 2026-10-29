export interface DrawingSummary {
  id: string;
  name: string;
  collectionId: string | null;
  updatedAt: number;
  createdAt: number;
  version: number;
  preview?: string | null;
  accessLevel?: "none" | "view" | "edit" | "owner";
  userId?: string;
  creatorName?: string | null;
  // Shared-with-me entries: hiding applies to direct shares only.
  canHide?: boolean;
  sharedViaTeams?: TeamRef[];
}
export interface Drawing extends DrawingSummary {
  elements: any[];
  appState: any;
  files: Record<string, any> | null;
}
export interface Collection {
  id: string;
  name: string;
  createdAt: number;
  sharedRole?: "view" | "edit" | null;
  isOwner?: boolean;
  isShared?: boolean;
  sharedViaTeams?: TeamRef[];
}

export type CollectionShareRole = "view" | "edit";

export interface CollectionShareUser {
  id: string;
  name: string;
  email: string;
}

export interface CollectionShareRow {
  id: string;
  collectionId: string;
  granteeUserId: string;
  granteeUser: CollectionShareUser;
  role: CollectionShareRole;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRef {
  id: string;
  name: string;
}

export interface TeamSummary extends TeamRef {
  memberCount: number;
}

export type TeamRole = "member" | "manager";
export type TeamMemberSource = "manual" | "oidc";

export interface Team extends TeamSummary {
  description: string | null;
  oidcGroup: string | null;
  myRole: TeamRole | null;
  mySource: TeamMemberSource | null;
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: TeamRole;
  source: TeamMemberSource;
  createdAt: string;
}

export interface TeamDetails extends TeamRef {
  description: string | null;
  oidcGroup: string | null;
  myRole: TeamRole | null;
  canManage: boolean;
  canEditGroup: boolean;
  members: TeamMember[];
  createdAt: string;
  updatedAt: string;
}

export interface CollectionTeamShareRow {
  teamId: string;
  role: CollectionShareRole;
  createdAt: string;
  team: TeamSummary;
}
