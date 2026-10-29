import express from "express";
import { z } from "zod";
import { Prisma } from "../../generated/client";
import {
  TEAM_DESCRIPTION_MAX_LENGTH,
  TEAM_NAME_MAX_LENGTH,
  TEAM_OIDC_GROUP_MAX_LENGTH,
  canManageTeamMembers,
  getTeamMembership,
  isAdminActor,
} from "../../authz/teams";
import { DashboardRouteDeps } from "./types";

const teamNameSchema = z.string().trim().min(1).max(TEAM_NAME_MAX_LENGTH);
const teamDescriptionSchema = z
  .string()
  .trim()
  .max(TEAM_DESCRIPTION_MAX_LENGTH)
  .nullable();
const oidcGroupSchema = z
  .string()
  .trim()
  .min(1)
  .max(TEAM_OIDC_GROUP_MAX_LENGTH)
  .nullable();
const teamRoleSchema = z.enum(["member", "manager"]);

const teamCreateSchema = z.object({
  name: teamNameSchema,
  description: teamDescriptionSchema.optional(),
  oidcGroup: oidcGroupSchema.optional(),
});

const teamUpdateSchema = z
  .object({
    name: teamNameSchema.optional(),
    description: teamDescriptionSchema.optional(),
    oidcGroup: oidcGroupSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Nothing to update",
  });

const teamMemberAddSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
  role: teamRoleSchema.default("member"),
});

const teamMemberUpdateSchema = z.object({ role: teamRoleSchema });

const memberUserSelect = { id: true, name: true, email: true } as const;

export const registerTeamRoutes = (
  app: express.Express,
  deps: DashboardRouteDeps,
) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    sanitizeText,
    respondWithValidationErrors,
    invalidateDrawingsCache,
    config,
    logAuditEvent,
    revalidateAllDrawingAccess,
  } = deps;

  const audit = async (
    req: express.Request,
    action: string,
    teamId: string,
    details: Record<string, unknown>,
  ) => {
    if (!config.enableAuditLogging || !req.user) return;
    await logAuditEvent({
      userId: req.user.id,
      action,
      resource: `team:${teamId}`,
      ipAddress: req.ip || req.connection.remoteAddress || undefined,
      userAgent: req.headers["user-agent"] || undefined,
      details: { teamId, ...details },
    });
  };

  // Membership changes can grant or revoke access to shared drawings: drop the
  // cached drawing lists and re-check every open collaboration room.
  const onAccessChanged = async () => {
    invalidateDrawingsCache();
    if (!revalidateAllDrawingAccess) return;
    try {
      await revalidateAllDrawingAccess();
    } catch (err) {
      console.error("Failed to revalidate live drawing access:", err);
    }
  };

  const isUniqueOidcGroupError = (error: unknown) =>
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002";

  // GET /teams: every team for admins, the teams of the user otherwise.
  app.get(
    "/teams",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const isAdmin = isAdminActor(req.user);

      const teams = await prisma.team.findMany({
        where: isAdmin
          ? undefined
          : { members: { some: { userId: req.user.id } } },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          oidcGroup: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { members: true } },
          members: {
            where: { userId: req.user.id },
            select: { role: true, source: true },
          },
        },
      });

      return res.json({
        canCreate: isAdmin,
        teams: teams.map(({ _count, members, ...team }) => {
          const membership = members[0] ?? null;
          return {
            ...team,
            memberCount: _count.members,
            myRole: membership?.role ?? null,
            mySource: membership?.source ?? null,
            canManage: isAdmin || membership?.role === "manager",
          };
        }),
      });
    }),
  );

  // POST /teams: admins only.
  app.post(
    "/teams",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdminActor(req.user)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const parsed = teamCreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return respondWithValidationErrors(res, parsed.error.issues);
      }

      const name = sanitizeText(parsed.data.name, TEAM_NAME_MAX_LENGTH);
      if (!name) {
        return res.status(400).json({ error: "Team name is required" });
      }
      try {
        const team = await prisma.team.create({
          data: {
            name,
            description: parsed.data.description
              ? sanitizeText(
                  parsed.data.description,
                  TEAM_DESCRIPTION_MAX_LENGTH,
                )
              : null,
            oidcGroup: parsed.data.oidcGroup ?? null,
            createdByUserId: req.user.id,
          },
        });
        await audit(req, "team_created", team.id, {
          name: team.name,
          oidcGroup: team.oidcGroup,
        });
        return res.status(201).json({ team });
      } catch (error) {
        if (isUniqueOidcGroupError(error)) {
          return res.status(409).json({
            error: "Conflict",
            message: "Another team is already linked to this group",
          });
        }
        throw error;
      }
    }),
  );

  // GET /teams/:id: admins and team members.
  app.get(
    "/teams/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const isAdmin = isAdminActor(req.user);
      const membership = await getTeamMembership({
        prisma,
        teamId: id,
        userId: req.user.id,
      });
      if (!isAdmin && !membership) {
        return res.status(404).json({ error: "Team not found" });
      }

      const team = await prisma.team.findUnique({
        where: { id },
        include: {
          members: {
            include: { user: { select: memberUserSelect } },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!team) return res.status(404).json({ error: "Team not found" });

      const { members, ...rest } = team;
      return res.json({
        team: {
          ...rest,
          myRole: membership?.role ?? null,
          canManage: isAdmin || membership?.role === "manager",
          canEditGroup: isAdmin,
          members: members.map((m) => ({
            userId: m.userId,
            name: m.user.name,
            email: m.user.email,
            role: m.role,
            source: m.source,
            createdAt: m.createdAt,
          })),
        },
      });
    }),
  );

  // PATCH /teams/:id: managers can rename and describe their team, only admins
  // can link it to an identity provider group.
  app.patch(
    "/teams/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const parsed = teamUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return respondWithValidationErrors(res, parsed.error.issues);
      }

      const existing = await prisma.team.findUnique({ where: { id } });
      const canManage =
        existing &&
        (await canManageTeamMembers({ prisma, teamId: id, actor: req.user }));
      if (!existing || !canManage) {
        return res.status(404).json({ error: "Team not found" });
      }
      const groupChanged =
        parsed.data.oidcGroup !== undefined &&
        parsed.data.oidcGroup !== existing.oidcGroup;
      if (groupChanged && !isAdminActor(req.user)) {
        return res.status(403).json({
          error: "Forbidden",
          message: "Only admins can link a team to an identity provider group",
        });
      }

      const data: Prisma.TeamUpdateInput = {};
      if (parsed.data.name !== undefined) {
        const name = sanitizeText(parsed.data.name, TEAM_NAME_MAX_LENGTH);
        if (!name) {
          return res.status(400).json({ error: "Team name is required" });
        }
        data.name = name;
      }
      if (parsed.data.description !== undefined) {
        data.description = parsed.data.description
          ? sanitizeText(parsed.data.description, TEAM_DESCRIPTION_MAX_LENGTH)
          : null;
      }
      if (groupChanged) data.oidcGroup = parsed.data.oidcGroup ?? null;

      try {
        const team = await prisma.$transaction(async (tx) => {
          if (groupChanged && existing.oidcGroup) {
            if (parsed.data.oidcGroup) {
              // Linked to another group: the members of the previous group
              // leave, the new group's members join at their next sign-in.
              await tx.teamMember.deleteMany({
                where: { teamId: id, source: "oidc" },
              });
            } else {
              // Unlinked: keep the synced members, now managed by hand.
              await tx.teamMember.updateMany({
                where: { teamId: id, source: "oidc" },
                data: { source: "manual" },
              });
            }
          }
          return tx.team.update({ where: { id }, data });
        });
        if (groupChanged) await onAccessChanged();
        await audit(req, "team_updated", id, {
          name: team.name,
          ...(groupChanged && {
            previousOidcGroup: existing.oidcGroup,
            oidcGroup: team.oidcGroup,
          }),
        });
        return res.json({ team });
      } catch (error) {
        if (isUniqueOidcGroupError(error)) {
          return res.status(409).json({
            error: "Conflict",
            message: "Another team is already linked to this group",
          });
        }
        throw error;
      }
    }),
  );

  // DELETE /teams/:id: admins only. Removes the team's memberships and shares.
  app.delete(
    "/teams/:id",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      if (!isAdminActor(req.user)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const { id } = req.params;
      const team = await prisma.team.findUnique({ where: { id } });
      if (!team) return res.status(404).json({ error: "Team not found" });

      await prisma.$transaction([
        prisma.collectionTeamShare.deleteMany({ where: { teamId: id } }),
        prisma.drawingTeamPermission.deleteMany({ where: { teamId: id } }),
        prisma.teamMember.deleteMany({ where: { teamId: id } }),
        prisma.team.delete({ where: { id } }),
      ]);
      await onAccessChanged();
      await audit(req, "team_deleted", id, {
        name: team.name,
        oidcGroup: team.oidcGroup,
      });
      return res.json({ success: true });
    }),
  );

  // GET /teams/:id/member-resolve: search users to add (admins and managers).
  app.get(
    "/teams/:id/member-resolve",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const q = String(req.query.q || "").trim();
      if (q.length < 2) return res.json({ users: [] });

      const team = await prisma.team.findUnique({
        where: { id },
        select: { id: true },
      });
      if (
        !team ||
        !(await canManageTeamMembers({ prisma, teamId: id, actor: req.user }))
      ) {
        return res.status(404).json({ error: "Team not found" });
      }

      const users = await prisma.user.findMany({
        where: {
          isActive: true,
          teamMemberships: { none: { teamId: id } },
          OR: [
            { email: { contains: q.toLowerCase() } },
            { name: { contains: q } },
            { username: { contains: q } },
          ],
        },
        select: memberUserSelect,
        take: 8,
      });
      return res.json({ users });
    }),
  );

  // POST /teams/:id/members: add a member by hand, or change the role of an
  // existing member (admins and managers).
  app.post(
    "/teams/:id/members",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const parsed = teamMemberAddSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return respondWithValidationErrors(res, parsed.error.issues);
      }

      const team = await prisma.team.findUnique({
        where: { id },
        select: { id: true },
      });
      if (
        !team ||
        !(await canManageTeamMembers({ prisma, teamId: id, actor: req.user }))
      ) {
        return res.status(404).json({ error: "Team not found" });
      }

      const identifier = parsed.data.identifier;
      const user = await prisma.user.findFirst({
        where: {
          isActive: true,
          OR: [
            { id: identifier },
            { email: identifier.toLowerCase() },
            { username: identifier },
          ],
        },
        select: memberUserSelect,
      });
      if (!user) return res.status(404).json({ error: "User not found" });

      const member = await prisma.teamMember.upsert({
        where: { teamId_userId: { teamId: id, userId: user.id } },
        update: { role: parsed.data.role },
        create: {
          teamId: id,
          userId: user.id,
          role: parsed.data.role,
          source: "manual",
        },
      });
      await onAccessChanged();
      await audit(req, "team_member_upsert", id, {
        memberUserId: user.id,
        role: member.role,
      });
      return res.json({
        member: {
          userId: user.id,
          name: user.name,
          email: user.email,
          role: member.role,
          source: member.source,
          createdAt: member.createdAt,
        },
      });
    }),
  );

  // PATCH /teams/:id/members/:userId: change a member's role (admins and managers).
  app.patch(
    "/teams/:id/members/:userId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, userId } = req.params;
      const parsed = teamMemberUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return respondWithValidationErrors(res, parsed.error.issues);
      }
      if (
        !(await canManageTeamMembers({ prisma, teamId: id, actor: req.user }))
      ) {
        return res.status(404).json({ error: "Team not found" });
      }

      const result = await prisma.teamMember.updateMany({
        where: { teamId: id, userId },
        data: { role: parsed.data.role },
      });
      if (result.count === 0) {
        return res.status(404).json({ error: "Member not found" });
      }
      await audit(req, "team_member_role_updated", id, {
        memberUserId: userId,
        role: parsed.data.role,
      });
      return res.json({ success: true });
    }),
  );

  // DELETE /teams/:id/members/:userId: admins and managers remove members added
  // by hand; any member can leave a team they were added to by hand. Members
  // synced from the identity provider leave when they leave the group.
  app.delete(
    "/teams/:id/members/:userId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, userId } = req.params;

      const isSelf = userId === req.user.id;
      const canManage = await canManageTeamMembers({
        prisma,
        teamId: id,
        actor: req.user,
      });
      if (!canManage && !isSelf) {
        return res.status(404).json({ error: "Team not found" });
      }

      const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: id, userId } },
        select: { id: true, source: true },
      });
      if (!member) return res.status(404).json({ error: "Member not found" });
      if (member.source === "oidc") {
        return res.status(409).json({
          error: "Conflict",
          message:
            "This member is synced from the identity provider: remove them from the group there",
        });
      }

      await prisma.teamMember.delete({ where: { id: member.id } });
      await onAccessChanged();
      await audit(req, "team_member_removed", id, { memberUserId: userId });
      return res.json({ success: true });
    }),
  );
};
