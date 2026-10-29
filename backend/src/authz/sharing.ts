import type { PrismaClient } from "../generated/client";
import crypto from "crypto";
import { hashTokenForStorage } from "../auth/tokenSecurity";

export type DrawingPermission = "view" | "edit";
export type DrawingAccess = "none" | DrawingPermission | "owner";

export type DrawingPrincipal = { kind: "user"; userId: string };

export const normalizeDrawingPermission = (
  input: unknown,
): DrawingPermission | null => {
  if (input === "view" || input === "edit") return input;
  return null;
};

export const buildShareLinkToken = (): string =>
  crypto.randomBytes(24).toString("base64url");

export const hashShareLinkToken = (token: string): string =>
  hashTokenForStorage(token);

export const getDrawingAccess = async (params: {
  prisma: PrismaClient;
  principal: DrawingPrincipal | null;
  drawingId: string;
  now?: Date;
}): Promise<DrawingAccess> => {
  const nowMs = (params.now ?? new Date()).getTime();

  let baseAccess: DrawingAccess = "none";

  // User-based access (owner or explicit ACL).
  if (params.principal?.kind === "user") {
    const drawing = await params.prisma.drawing.findUnique({
      where: { id: params.drawingId },
      select: { userId: true, collectionId: true },
    });
    if (!drawing) return "none";
    if (drawing.userId === params.principal.userId) return "owner";

    const [perm, teamPerms] = await Promise.all([
      params.prisma.drawingPermission.findUnique({
        where: {
          drawingId_granteeUserId: {
            drawingId: params.drawingId,
            granteeUserId: params.principal.userId,
          },
        },
        select: { permission: true },
      }),
      params.prisma.drawingTeamPermission.findMany({
        where: {
          drawingId: params.drawingId,
          team: { members: { some: { userId: params.principal.userId } } },
        },
        select: { permission: true },
      }),
    ]);
    baseAccess =
      strongestPermission([
        perm?.permission,
        ...teamPerms.map((teamPerm) => teamPerm.permission),
      ]) ?? baseAccess;

    // A drawing inherits the strongest access available from its collection.
    // This matters when a direct drawing grant is weaker than the collection grant.
    if (drawing.collectionId) {
      const ownedCollection = await params.prisma.collection.findFirst({
        where: {
          id: drawing.collectionId,
          userId: params.principal.userId,
        },
        select: { id: true },
      });
      if (ownedCollection) {
        baseAccess = "owner";
      } else {
        const collectionAccess =
          (await getCollectionShareAccess({
            prisma: params.prisma,
            userId: params.principal.userId,
            collectionId: drawing.collectionId,
          })) ?? "none";
        baseAccess = maxAccess(baseAccess, collectionAccess);
      }
    }
  }

  // Google Docs-style link policy: applies regardless of whether the visitor is signed in.
  // If a drawing has an active link-share policy, possession of the drawing id URL grants the policy access.
  const linkPolicy = await getActiveLinkShareAccess({
    prisma: params.prisma,
    drawingId: params.drawingId,
    nowMs,
  });
  const linkAccess: DrawingAccess = linkPolicy ?? "none";

  return maxAccess(baseAccess, linkAccess);
};

// Strongest role a user who does not own a collection gets on it, from a direct
// share or from the shares of the teams they belong to.
export const getCollectionShareAccess = async (params: {
  prisma: PrismaClient;
  userId: string;
  collectionId: string;
}): Promise<DrawingPermission | null> => {
  const [directShare, teamShares] = await Promise.all([
    params.prisma.collectionShare.findFirst({
      where: {
        collectionId: params.collectionId,
        granteeUserId: params.userId,
      },
      select: { role: true },
    }),
    params.prisma.collectionTeamShare.findMany({
      where: {
        collectionId: params.collectionId,
        team: { members: { some: { userId: params.userId } } },
      },
      select: { role: true },
    }),
  ]);
  return strongestPermission([
    directShare?.role,
    ...teamShares.map((share) => share.role),
  ]);
};

export const strongestPermission = (
  inputs: unknown[],
): DrawingPermission | null => {
  let strongest: DrawingPermission | null = null;
  for (const input of inputs) {
    const permission = normalizeDrawingPermission(input);
    if (permission === "edit") return "edit";
    if (permission === "view") strongest = "view";
  }
  return strongest;
};

export const canViewDrawing = (
  access: DrawingAccess,
): access is Exclude<DrawingAccess, "none"> => access !== "none";

export const canEditDrawing = (
  access: DrawingAccess,
): access is Extract<DrawingAccess, "edit" | "owner"> =>
  access === "edit" || access === "owner";

export const isOwnerAccess = (access: DrawingAccess): boolean =>
  access === "owner";

const getActiveLinkShareAccess = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  nowMs: number;
}): Promise<DrawingPermission | null> => {
  const linkShare = await params.prisma.drawingLinkShare.findFirst({
    where: {
      drawingId: params.drawingId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(params.nowMs) } }],
    },
    orderBy: { createdAt: "desc" },
    select: { permission: true },
  });
  return normalizeDrawingPermission(linkShare?.permission);
};

const accessRank = (access: DrawingAccess): number => {
  switch (access) {
    case "owner":
      return 3;
    case "edit":
      return 2;
    case "view":
      return 1;
    default:
      return 0;
  }
};

const maxAccess = (a: DrawingAccess, b: DrawingAccess): DrawingAccess =>
  accessRank(a) >= accessRank(b) ? a : b;
