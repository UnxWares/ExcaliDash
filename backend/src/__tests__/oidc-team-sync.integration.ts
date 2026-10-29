import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../generated/client";
import {
  syncOidcTeamMemberships,
  teamNameFromOidcGroup,
} from "../auth/oidcTeamSync";
import { getTestPrisma, setupTestDb } from "./testUtils";

describe("OIDC team sync", () => {
  let prisma: PrismaClient;
  let userId: string;

  const sync = (groups: string[], teamGroupPrefix = "excalidash-") =>
    prisma.$transaction((tx) =>
      syncOidcTeamMemberships({ tx, userId, groups, teamGroupPrefix }),
    );

  const membershipsOf = (id: string) =>
    prisma.teamMember.findMany({
      where: { userId: id },
      select: {
        source: true,
        role: true,
        team: { select: { name: true, oidcGroup: true } },
      },
      orderBy: { team: { name: "asc" } },
    });

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
  });

  beforeEach(async () => {
    await prisma.teamMember.deleteMany();
    await prisma.team.deleteMany();
    await prisma.user.deleteMany({ where: { email: "oidc-sync@test.local" } });
    const user = await prisma.user.create({
      data: {
        email: "oidc-sync@test.local",
        passwordHash: "",
        name: "Synced User",
        role: "USER",
        isActive: true,
      },
      select: { id: true },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("derives team names only from groups carrying the prefix", () => {
    expect(teamNameFromOidcGroup("excalidash-design", "excalidash-")).toBe(
      "design",
    );
    expect(teamNameFromOidcGroup("design", "excalidash-")).toBe(null);
    expect(teamNameFromOidcGroup("excalidash-", "excalidash-")).toBe(null);
    expect(teamNameFromOidcGroup("excalidash-design", "")).toBe(null);
    expect(
      teamNameFromOidcGroup(`excalidash-${"x".repeat(150)}`, "excalidash-"),
    ).toHaveLength(100);
  });

  it("creates the teams of prefixed groups and adds the user to them", async () => {
    const result = await sync(["excalidash-design", "excalidash-ops", "staff"]);
    expect(result.createdTeamIds).toHaveLength(2);
    expect(result.addedTeamIds).toHaveLength(2);
    expect(await membershipsOf(userId)).toEqual([
      {
        source: "oidc",
        role: "member",
        team: { name: "design", oidcGroup: "excalidash-design" },
      },
      {
        source: "oidc",
        role: "member",
        team: { name: "ops", oidcGroup: "excalidash-ops" },
      },
    ]);

    const again = await sync(["excalidash-design", "excalidash-ops", "staff"]);
    expect(again).toEqual({
      createdTeamIds: [],
      addedTeamIds: [],
      removedTeamIds: [],
    });
  });

  it("does not create teams without a prefix, but joins teams linked by an admin", async () => {
    await prisma.team.create({ data: { name: "Staff", oidcGroup: "staff" } });
    const result = await sync(["excalidash-design", "staff"], "");
    expect(result.createdTeamIds).toEqual([]);
    expect(await membershipsOf(userId)).toEqual([
      {
        source: "oidc",
        role: "member",
        team: { name: "Staff", oidcGroup: "staff" },
      },
    ]);
  });

  it("removes synced memberships whose group is gone and keeps manual ones", async () => {
    const manualTeam = await prisma.team.create({ data: { name: "Manual" } });
    await prisma.teamMember.create({
      data: { teamId: manualTeam.id, userId, source: "manual" },
    });
    await sync(["excalidash-design", "excalidash-ops"]);

    const result = await sync(["excalidash-design"]);
    expect(result.removedTeamIds).toHaveLength(1);
    expect((await membershipsOf(userId)).map((m) => m.team.name)).toEqual([
      "Manual",
      "design",
    ]);

    await sync([]);
    expect((await membershipsOf(userId)).map((m) => m.team.name)).toEqual([
      "Manual",
    ]);
  });

  it("never changes a manual membership in a linked team", async () => {
    const team = await prisma.team.create({
      data: { name: "Linked", oidcGroup: "linked" },
    });
    await prisma.teamMember.create({
      data: { teamId: team.id, userId, source: "manual", role: "manager" },
    });

    await sync(["linked"]);
    await sync([]);
    expect(await membershipsOf(userId)).toEqual([
      {
        source: "manual",
        role: "manager",
        team: { name: "Linked", oidcGroup: "linked" },
      },
    ]);
  });

  it("keeps the role given in ExcaliDash to a synced member", async () => {
    await sync(["excalidash-design"]);
    await prisma.teamMember.updateMany({
      where: { userId },
      data: { role: "manager" },
    });
    await sync(["excalidash-design"]);
    expect((await membershipsOf(userId))[0]?.role).toBe("manager");
  });
});
