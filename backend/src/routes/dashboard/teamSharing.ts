import express from "express";
import { z } from "zod";
import type { PrismaClient } from "../../generated/client";
import { DashboardRouteDeps } from "./types";

const teamShareSchema = z.object({
  teamId: z.string().trim().min(1).max(100),
  role: z.enum(["view", "edit"]),
});

const TEAM_SEARCH_LIMIT = 8;

// Teams whose name matches a search, for the share dialogs. Matching happens in
// memory so it is case-insensitive on every database; organizations have few
// enough teams for this to stay cheap.
export const searchTeamsForSharing = async (params: {
  prisma: PrismaClient;
  q: string;
  excludeTeamIds: string[];
}) => {
  const q = params.q.trim().toLowerCase();
  if (q.length < 2) return [];
  const excluded = new Set(params.excludeTeamIds);
  const teams = await params.prisma.team.findMany({
    select: {
      id: true,
      name: true,
      _count: { select: { members: true } },
    },
    orderBy: { name: "asc" },
  });
  return teams
    .filter((team) => !excluded.has(team.id))
    .filter((team) => team.name.toLowerCase().includes(q))
    .slice(0, TEAM_SEARCH_LIMIT)
    .map(({ _count, ...team }) => ({ ...team, memberCount: _count.members }));
};

const teamSummarySelect = {
  id: true,
  name: true,
  _count: { select: { members: true } },
} as const;

const toTeamSummary = (team: {
  id: string;
  name: string;
  _count: { members: number };
}) => ({ id: team.id, name: team.name, memberCount: team._count.members });

export const registerTeamSharingRoutes = (
  app: express.Express,
  deps: DashboardRouteDeps,
) => {
  const {
    prisma,
    requireAuth,
    asyncHandler,
    respondWithValidationErrors,
    invalidateDrawingsCache,
    config,
    logAuditEvent,
    revalidateDrawingAccess,
    revalidateAllDrawingAccess,
  } = deps;

  const audit = async (
    req: express.Request,
    action: string,
    resource: string,
    details: Record<string, unknown>,
  ) => {
    if (!config.enableAuditLogging || !req.user) return;
    await logAuditEvent({
      userId: req.user.id,
      action,
      resource,
      ipAddress: req.ip || req.connection.remoteAddress || undefined,
      userAgent: req.headers["user-agent"] || undefined,
      details,
    });
  };

  // Best-effort: never let a socket failure break the sharing HTTP response.
  const revalidate = async (revalidateFn?: () => Promise<void> | void) => {
    if (!revalidateFn) return;
    try {
      await revalidateFn();
    } catch (err) {
      console.error("Failed to revalidate live drawing access:", err);
    }
  };

  const findOwnedCollection = (id: string, userId: string) =>
    prisma.collection.findFirst({
      where: { id, userId },
      select: { id: true },
    });

  const findOwnedDrawing = async (id: string, userId: string) => {
    const drawing = await prisma.drawing.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    return drawing && drawing.userId === userId ? drawing : null;
  };

  // ─── Collections ──────────────────────────────────────────────────────────

  // GET /collections/:id/team-shares: list team shares (owner only)
  app.get(
    "/collections/:id/team-shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      if (!(await findOwnedCollection(id, req.user.id))) {
        return res.status(404).json({ error: "Collection not found" });
      }
      const shares = await prisma.collectionTeamShare.findMany({
        where: { collectionId: id },
        include: { team: { select: teamSummarySelect } },
        orderBy: { createdAt: "asc" },
      });
      return res.json({
        shares: shares.map((share) => ({
          teamId: share.teamId,
          role: share.role,
          createdAt: share.createdAt,
          team: toTeamSummary(share.team),
        })),
      });
    }),
  );

  // POST /collections/:id/team-shares: share with a team or change its role (owner only)
  app.post(
    "/collections/:id/team-shares",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const parsed = teamShareSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return respondWithValidationErrors(res, parsed.error.issues);
      }
      if (!(await findOwnedCollection(id, req.user.id))) {
        return res.status(404).json({ error: "Collection not found" });
      }
      const team = await prisma.team.findUnique({
        where: { id: parsed.data.teamId },
        select: teamSummarySelect,
      });
      if (!team) return res.status(404).json({ error: "Team not found" });

      const share = await prisma.collectionTeamShare.upsert({
        where: {
          collectionId_teamId: { collectionId: id, teamId: team.id },
        },
        update: { role: parsed.data.role },
        create: {
          collectionId: id,
          teamId: team.id,
          role: parsed.data.role,
          createdByUserId: req.user.id,
        },
      });
      invalidateDrawingsCache();
      // A downgrade from edit to view must reach open editors too.
      await revalidate(revalidateAllDrawingAccess);
      await audit(req, "collection_shared_team_upsert", `collection:${id}`, {
        collectionId: id,
        teamId: team.id,
        role: share.role,
      });
      return res.json({
        share: {
          teamId: share.teamId,
          role: share.role,
          createdAt: share.createdAt,
          team: toTeamSummary(team),
        },
      });
    }),
  );

  // DELETE /collections/:id/team-shares/:teamId: stop sharing with a team (owner only)
  app.delete(
    "/collections/:id/team-shares/:teamId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, teamId } = req.params;
      if (!(await findOwnedCollection(id, req.user.id))) {
        return res.status(404).json({ error: "Collection not found" });
      }
      await prisma.collectionTeamShare.deleteMany({
        where: { collectionId: id, teamId },
      });
      invalidateDrawingsCache();
      await revalidate(revalidateAllDrawingAccess);
      await audit(req, "collection_shared_team_revoke", `collection:${id}`, {
        collectionId: id,
        teamId,
      });
      return res.json({ success: true });
    }),
  );

  // ─── Drawings ─────────────────────────────────────────────────────────────

  // POST /drawings/:id/team-permissions: share with a team or change its permission (owner only)
  app.post(
    "/drawings/:id/team-permissions",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id } = req.params;
      const parsed = teamShareSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return respondWithValidationErrors(res, parsed.error.issues);
      }
      if (!(await findOwnedDrawing(id, req.user.id))) {
        return res.status(404).json({ error: "Drawing not found" });
      }
      const team = await prisma.team.findUnique({
        where: { id: parsed.data.teamId },
        select: teamSummarySelect,
      });
      if (!team) return res.status(404).json({ error: "Team not found" });

      const saved = await prisma.drawingTeamPermission.upsert({
        where: { drawingId_teamId: { drawingId: id, teamId: team.id } },
        update: { permission: parsed.data.role },
        create: {
          drawingId: id,
          teamId: team.id,
          permission: parsed.data.role,
          createdByUserId: req.user.id,
        },
      });
      invalidateDrawingsCache();
      await revalidate(() => revalidateDrawingAccess?.(id));
      await audit(req, "drawing_shared_team_upsert", `drawing:${id}`, {
        drawingId: id,
        teamId: team.id,
        permission: saved.permission,
      });
      return res.json({
        permission: {
          teamId: saved.teamId,
          permission: saved.permission,
          createdAt: saved.createdAt,
          team: toTeamSummary(team),
        },
      });
    }),
  );

  // DELETE /drawings/:id/team-permissions/:teamId: stop sharing with a team (owner only)
  app.delete(
    "/drawings/:id/team-permissions/:teamId",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      const { id, teamId } = req.params;
      if (!(await findOwnedDrawing(id, req.user.id))) {
        return res.status(404).json({ error: "Drawing not found" });
      }
      await prisma.drawingTeamPermission.deleteMany({
        where: { drawingId: id, teamId },
      });
      invalidateDrawingsCache();
      await revalidate(() => revalidateDrawingAccess?.(id));
      await audit(req, "drawing_shared_team_revoke", `drawing:${id}`, {
        drawingId: id,
        teamId,
      });
      return res.json({ success: true });
    }),
  );
};
