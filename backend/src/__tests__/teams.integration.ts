import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";

type TestUser = { id: string; email: string };

describe("Teams - Backend Integration", () => {
  const userAgent = "vitest-teams";
  let prisma: PrismaClient;
  let app: any;

  let admin: TestUser;
  let owner: TestUser;
  let manager: TestUser;
  let member: TestUser;
  let outsider: TestUser;

  const signAccessToken = (user: TestUser) => {
    const signOptions: SignOptions = {
      expiresIn: config.jwtAccessExpiresIn as StringValue,
    };
    return jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      signOptions,
    );
  };

  const createUser = async (email: string, name: string, role = "USER") => {
    const passwordHash = await bcrypt.hash("password123", 10);
    return prisma.user.create({
      data: { email, passwordHash, name, role, isActive: true },
      select: { id: true, email: true },
    });
  };

  // Authenticated client for one user: bearer token plus a CSRF token bound to
  // its own cookie jar, as the browser app does.
  const clientFor = async (user: TestUser) => {
    const token = signAccessToken(user);
    const agent = request.agent(app);
    const csrf = await agent.get("/csrf-token").set("User-Agent", userAgent);
    const withAuth = (req: any) =>
      req
        .set("User-Agent", userAgent)
        .set("Authorization", `Bearer ${token}`)
        .set(csrf.body.header, csrf.body.token);
    return {
      get: (url: string) => withAuth(agent.get(url)),
      post: (url: string, body: unknown = {}) =>
        withAuth(agent.post(url)).send(body),
      patch: (url: string, body: unknown = {}) =>
        withAuth(agent.patch(url)).send(body),
      put: (url: string, body: unknown = {}) =>
        withAuth(agent.put(url)).send(body),
      del: (url: string) => withAuth(agent.delete(url)),
    };
  };

  let as: Record<
    "admin" | "owner" | "manager" | "member" | "outsider",
    Awaited<ReturnType<typeof clientFor>>
  >;

  const createTeam = async (name: string, oidcGroup?: string) => {
    const res = await as.admin.post("/teams", { name, oidcGroup });
    expect(res.status).toBe(201);
    return res.body.team as { id: string; name: string };
  };

  const createTeamWithMembers = async (name: string) => {
    const team = await createTeam(name);
    expect(
      (
        await as.admin.post(`/teams/${team.id}/members`, {
          identifier: manager.email,
          role: "manager",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await as.admin.post(`/teams/${team.id}/members`, {
          identifier: member.email,
        })
      ).status,
    ).toBe(200);
    return team;
  };

  const createCollection = (name = "Team Collection") =>
    prisma.collection.create({
      data: { name, userId: owner.id },
      select: { id: true },
    });

  const createDrawing = (collectionId: string | null = null) =>
    prisma.drawing.create({
      data: {
        name: "Owner Drawing",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: owner.id,
        collectionId,
      },
      select: { id: true },
    });

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });

    admin = await createUser("admin-teams@test.local", "Admin User", "ADMIN");
    owner = await createUser("owner-teams@test.local", "Owner User");
    manager = await createUser("manager-teams@test.local", "Manager User");
    member = await createUser("member-teams@test.local", "Member User");
    outsider = await createUser("outsider-teams@test.local", "Outsider User");

    as = {
      admin: await clientFor(admin),
      owner: await clientFor(owner),
      manager: await clientFor(manager),
      member: await clientFor(member),
      outsider: await clientFor(outsider),
    };
  }, 120000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("team management", () => {
    it("lets only admins create and delete teams", async () => {
      const denied = await as.owner.post("/teams", { name: "Not allowed" });
      expect(denied.status).toBe(403);

      const team = await createTeam("Design");
      const deleteDenied = await as.owner.del(`/teams/${team.id}`);
      expect(deleteDenied.status).toBe(403);

      const deleted = await as.admin.del(`/teams/${team.id}`);
      expect(deleted.status).toBe(200);
      expect(await prisma.team.findUnique({ where: { id: team.id } })).toBe(
        null,
      );
    });

    it("rejects invalid team payloads", async () => {
      const empty = await as.admin.post("/teams", { name: "   " });
      expect(empty.status).toBe(400);
      const tooLong = await as.admin.post("/teams", { name: "x".repeat(101) });
      expect(tooLong.status).toBe(400);
    });

    it("lists every team for admins and only their own teams for users", async () => {
      const team = await createTeamWithMembers("Listing");
      const other = await createTeam("Listing Other");

      const adminList = await as.admin.get("/teams");
      expect(adminList.status).toBe(200);
      expect(adminList.body.canCreate).toBe(true);
      const adminIds = adminList.body.teams.map((t: any) => t.id);
      expect(adminIds).toEqual(expect.arrayContaining([team.id, other.id]));

      const memberList = await as.member.get("/teams");
      expect(memberList.status).toBe(200);
      expect(memberList.body.canCreate).toBe(false);
      const mine = memberList.body.teams.find((t: any) => t.id === team.id);
      expect(mine).toMatchObject({
        myRole: "member",
        canManage: false,
        memberCount: 2,
      });
      expect(memberList.body.teams.some((t: any) => t.id === other.id)).toBe(
        false,
      );

      const managerList = await as.manager.get("/teams");
      expect(
        managerList.body.teams.find((t: any) => t.id === team.id)?.canManage,
      ).toBe(true);
    });

    it("hides a team from users outside it", async () => {
      const team = await createTeamWithMembers("Hidden");
      expect((await as.outsider.get(`/teams/${team.id}`)).status).toBe(404);
      const details = await as.member.get(`/teams/${team.id}`);
      expect(details.status).toBe(200);
      expect(details.body.team.members).toHaveLength(2);
      expect(details.body.team.canManage).toBe(false);
    });

    it("lets managers manage members added by hand, but not plain members", async () => {
      const team = await createTeamWithMembers("Managed");

      const byMember = await as.member.post(`/teams/${team.id}/members`, {
        identifier: outsider.email,
      });
      expect(byMember.status).toBe(404);

      const added = await as.manager.post(`/teams/${team.id}/members`, {
        identifier: outsider.email,
      });
      expect(added.status).toBe(200);
      expect(added.body.member).toMatchObject({
        userId: outsider.id,
        role: "member",
        source: "manual",
      });

      const promoted = await as.manager.patch(
        `/teams/${team.id}/members/${outsider.id}`,
        { role: "manager" },
      );
      expect(promoted.status).toBe(200);

      const removed = await as.manager.del(
        `/teams/${team.id}/members/${outsider.id}`,
      );
      expect(removed.status).toBe(200);
      expect(
        await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: team.id, userId: outsider.id } },
        }),
      ).toBe(null);
    });

    it("lets a member leave a team they were added to by hand", async () => {
      const team = await createTeamWithMembers("Leaving");
      const left = await as.member.del(
        `/teams/${team.id}/members/${member.id}`,
      );
      expect(left.status).toBe(200);
    });

    it("refuses to remove members synced from the identity provider", async () => {
      const team = await createTeam("Synced", "group-synced");
      await prisma.teamMember.create({
        data: { teamId: team.id, userId: member.id, source: "oidc" },
      });

      const removed = await as.admin.del(
        `/teams/${team.id}/members/${member.id}`,
      );
      expect(removed.status).toBe(409);
      const left = await as.member.del(
        `/teams/${team.id}/members/${member.id}`,
      );
      expect(left.status).toBe(409);
    });

    it("lets only admins link a team to an identity provider group", async () => {
      const team = await createTeamWithMembers("Linking");

      const renamed = await as.manager.patch(`/teams/${team.id}`, {
        name: "Linking Renamed",
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.team.name).toBe("Linking Renamed");

      const linkByManager = await as.manager.patch(`/teams/${team.id}`, {
        oidcGroup: "group-linking",
      });
      expect(linkByManager.status).toBe(403);

      const linked = await as.admin.patch(`/teams/${team.id}`, {
        oidcGroup: "group-linking",
      });
      expect(linked.status).toBe(200);
      expect(linked.body.team.oidcGroup).toBe("group-linking");

      const other = await createTeam("Linking Other");
      const duplicate = await as.admin.patch(`/teams/${other.id}`, {
        oidcGroup: "group-linking",
      });
      expect(duplicate.status).toBe(409);
    });

    it("keeps synced members as manual ones when a team is unlinked, and drops them when relinked", async () => {
      const unlinked = await createTeam("Unlink", "group-unlink");
      await prisma.teamMember.create({
        data: { teamId: unlinked.id, userId: member.id, source: "oidc" },
      });
      const unlink = await as.admin.patch(`/teams/${unlinked.id}`, {
        oidcGroup: null,
      });
      expect(unlink.status).toBe(200);
      expect(
        await prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: unlinked.id, userId: member.id } },
          select: { source: true },
        }),
      ).toEqual({ source: "manual" });

      const relinked = await createTeam("Relink", "group-relink-old");
      await prisma.teamMember.create({
        data: { teamId: relinked.id, userId: member.id, source: "oidc" },
      });
      await prisma.teamMember.create({
        data: { teamId: relinked.id, userId: manager.id, source: "manual" },
      });
      const relink = await as.admin.patch(`/teams/${relinked.id}`, {
        oidcGroup: "group-relink-new",
      });
      expect(relink.status).toBe(200);
      const remaining = await prisma.teamMember.findMany({
        where: { teamId: relinked.id },
        select: { userId: true },
      });
      expect(remaining).toEqual([{ userId: manager.id }]);
    });
  });

  describe("collections shared with a team", () => {
    it("gives team members the shared role on the collection and its drawings", async () => {
      const team = await createTeamWithMembers("Collection Viewers");
      const collection = await createCollection();
      const drawing = await createDrawing(collection.id);

      const share = await as.owner.post(
        `/collections/${collection.id}/team-shares`,
        { teamId: team.id, role: "view" },
      );
      expect(share.status).toBe(200);
      expect(share.body.share).toMatchObject({ teamId: team.id, role: "view" });

      const ownerCollections = await as.owner.get("/collections");
      expect(
        ownerCollections.body.find((c: any) => c.id === collection.id)
          ?.isShared,
      ).toBe(true);

      const memberCollections = await as.member.get("/collections");
      const shared = memberCollections.body.find(
        (c: any) => c.id === collection.id,
      );
      expect(shared).toMatchObject({
        isOwner: false,
        sharedRole: "view",
        sharedViaTeams: [{ id: team.id, name: team.name }],
      });

      const listed = await as.member.get(
        `/drawings?collectionId=${collection.id}`,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.drawings.map((d: any) => d.id)).toEqual([drawing.id]);

      const opened = await as.member.get(`/drawings/${drawing.id}`);
      expect(opened.status).toBe(200);
      expect(opened.body.accessLevel).toBe("view");

      // Like any viewer without edit access, the update route answers 404.
      const edit = await as.member.put(`/drawings/${drawing.id}`, {
        name: "Not allowed",
      });
      expect(edit.status).toBe(404);

      const create = await as.member.post("/drawings", {
        name: "Not allowed",
        elements: [],
        appState: {},
        files: {},
        collectionId: collection.id,
      });
      expect(create.status).toBe(403);

      expect(
        (await as.outsider.get(`/drawings?collectionId=${collection.id}`))
          .status,
      ).toBe(404);
      expect([403, 404]).toContain(
        (await as.outsider.get(`/drawings/${drawing.id}`)).status,
      );
    });

    it("lets team editors create and edit drawings in the collection", async () => {
      const team = await createTeamWithMembers("Collection Editors");
      const collection = await createCollection();
      const drawing = await createDrawing(collection.id);
      await as.owner.post(`/collections/${collection.id}/team-shares`, {
        teamId: team.id,
        role: "edit",
      });

      const edited = await as.member.put(`/drawings/${drawing.id}`, {
        name: "Edited by the team",
      });
      expect(edited.status).toBe(200);
      expect(edited.body.accessLevel).toBe("edit");

      const created = await as.member.post("/drawings", {
        name: "Created by the team",
        elements: [],
        appState: {},
        files: {},
        collectionId: collection.id,
      });
      expect(created.status).toBe(200);
      expect(created.body.collectionId).toBe(collection.id);
    });

    it("uses the strongest of the direct and team roles", async () => {
      const team = await createTeamWithMembers("Strongest");
      const collection = await createCollection();
      await as.owner.post(`/collections/${collection.id}/shares`, {
        identifier: member.email,
        role: "view",
      });
      await as.owner.post(`/collections/${collection.id}/team-shares`, {
        teamId: team.id,
        role: "edit",
      });

      const memberCollections = await as.member.get("/collections");
      const entries = memberCollections.body.filter(
        (c: any) => c.id === collection.id,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].sharedRole).toBe("edit");
    });

    it("does not list a team member's own collection twice", async () => {
      const team = await createTeam("Owner In Team");
      await as.admin.post(`/teams/${team.id}/members`, {
        identifier: owner.email,
      });
      const collection = await createCollection("Own Collection");
      await as.owner.post(`/collections/${collection.id}/team-shares`, {
        teamId: team.id,
        role: "edit",
      });

      const collections = await as.owner.get("/collections");
      const entries = collections.body.filter(
        (c: any) => c.id === collection.id,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].isOwner).toBe(true);
    });

    it("revokes access when the member leaves, the share ends or the team is deleted", async () => {
      const team = await createTeamWithMembers("Revocation");
      const collection = await createCollection();
      const drawing = await createDrawing(collection.id);
      await as.owner.post(`/collections/${collection.id}/team-shares`, {
        teamId: team.id,
        role: "view",
      });
      expect((await as.member.get(`/drawings/${drawing.id}`)).status).toBe(200);
      expect((await as.manager.get(`/drawings/${drawing.id}`)).status).toBe(
        200,
      );

      await as.manager.del(`/teams/${team.id}/members/${member.id}`);
      expect([403, 404]).toContain(
        (await as.member.get(`/drawings/${drawing.id}`)).status,
      );

      const unshared = await as.owner.del(
        `/collections/${collection.id}/team-shares/${team.id}`,
      );
      expect(unshared.status).toBe(200);
      expect([403, 404]).toContain(
        (await as.manager.get(`/drawings/${drawing.id}`)).status,
      );

      await as.owner.post(`/collections/${collection.id}/team-shares`, {
        teamId: team.id,
        role: "view",
      });
      expect((await as.manager.get(`/drawings/${drawing.id}`)).status).toBe(
        200,
      );
      await as.admin.del(`/teams/${team.id}`);
      expect([403, 404]).toContain(
        (await as.manager.get(`/drawings/${drawing.id}`)).status,
      );
      expect(
        await prisma.collectionTeamShare.count({ where: { teamId: team.id } }),
      ).toBe(0);
    });

    it("only lets the owner manage team shares", async () => {
      const team = await createTeamWithMembers("Owner Only");
      const collection = await createCollection();
      const byMember = await as.member.post(
        `/collections/${collection.id}/team-shares`,
        { teamId: team.id, role: "edit" },
      );
      expect(byMember.status).toBe(404);
      expect(
        (await as.member.get(`/collections/${collection.id}/team-shares`))
          .status,
      ).toBe(404);

      const badRole = await as.owner.post(
        `/collections/${collection.id}/team-shares`,
        { teamId: team.id, role: "owner" },
      );
      expect(badRole.status).toBe(400);

      const unknownTeam = await as.owner.post(
        `/collections/${collection.id}/team-shares`,
        { teamId: "missing-team", role: "view" },
      );
      expect(unknownTeam.status).toBe(404);
    });

    it("suggests teams in the collection share search", async () => {
      const team = await createTeam("Searchable Squad");
      const collection = await createCollection();
      const found = await as.owner.get(
        `/collections/${collection.id}/share-resolve?q=searchable`,
      );
      expect(found.status).toBe(200);
      expect(found.body.teams.map((t: any) => t.id)).toContain(team.id);

      await as.owner.post(`/collections/${collection.id}/team-shares`, {
        teamId: team.id,
        role: "view",
      });
      const again = await as.owner.get(
        `/collections/${collection.id}/share-resolve?q=searchable`,
      );
      expect(again.body.teams.map((t: any) => t.id)).not.toContain(team.id);
    });
  });

  describe("drawings shared with a team", () => {
    it("lists team-shared drawings under Shared with me with the team's permission", async () => {
      const team = await createTeamWithMembers("Drawing Editors");
      const drawing = await createDrawing();

      const share = await as.owner.post(
        `/drawings/${drawing.id}/team-permissions`,
        { teamId: team.id, role: "edit" },
      );
      expect(share.status).toBe(200);

      const sharing = await as.owner.get(`/drawings/${drawing.id}/sharing`);
      expect(sharing.body.teamPermissions).toEqual([
        expect.objectContaining({
          teamId: team.id,
          permission: "edit",
          team: expect.objectContaining({ name: team.name, memberCount: 2 }),
        }),
      ]);

      const shared = await as.member.get("/drawings/shared");
      expect(shared.status).toBe(200);
      const entry = shared.body.drawings.find((d: any) => d.id === drawing.id);
      expect(entry).toMatchObject({
        accessLevel: "edit",
        canHide: false,
        sharedViaTeams: [{ id: team.id, name: team.name }],
      });

      const edited = await as.member.put(`/drawings/${drawing.id}`, {
        name: "Edited through the team",
      });
      expect(edited.status).toBe(200);

      const revoked = await as.owner.del(
        `/drawings/${drawing.id}/team-permissions/${team.id}`,
      );
      expect(revoked.status).toBe(200);
      expect([403, 404]).toContain(
        (await as.member.get(`/drawings/${drawing.id}`)).status,
      );
      const afterRevoke = await as.member.get("/drawings/shared");
      expect(
        afterRevoke.body.drawings.some((d: any) => d.id === drawing.id),
      ).toBe(false);
    });

    it("keeps a drawing hidden when it is also shared with the user directly", async () => {
      const team = await createTeamWithMembers("Hidden Drawing");
      const drawing = await createDrawing();
      await as.owner.post(`/drawings/${drawing.id}/team-permissions`, {
        teamId: team.id,
        role: "view",
      });
      await prisma.drawingPermission.create({
        data: {
          drawingId: drawing.id,
          granteeUserId: member.id,
          permission: "view",
          createdByUserId: owner.id,
          hidden: true,
        },
      });

      const shared = await as.member.get("/drawings/shared");
      expect(shared.body.drawings.some((d: any) => d.id === drawing.id)).toBe(
        false,
      );
      // Still reachable: hiding only cleans up the list.
      expect((await as.member.get(`/drawings/${drawing.id}`)).status).toBe(200);
    });

    it("leaves drawings of a team-shared collection out of Shared with me", async () => {
      const team = await createTeamWithMembers("Collection And Drawing");
      const collection = await createCollection();
      const drawing = await createDrawing(collection.id);
      await as.owner.post(`/collections/${collection.id}/team-shares`, {
        teamId: team.id,
        role: "view",
      });
      await as.owner.post(`/drawings/${drawing.id}/team-permissions`, {
        teamId: team.id,
        role: "view",
      });

      const shared = await as.member.get("/drawings/shared");
      expect(shared.body.drawings.some((d: any) => d.id === drawing.id)).toBe(
        false,
      );
    });

    it("lists a drawing outside any collection while the user also has collection shares", async () => {
      const unrelated = await createCollection("Unrelated Shared Collection");
      await as.owner.post(`/collections/${unrelated.id}/shares`, {
        identifier: outsider.email,
        role: "view",
      });
      const drawing = await createDrawing();
      await prisma.drawingPermission.create({
        data: {
          drawingId: drawing.id,
          granteeUserId: outsider.id,
          permission: "view",
          createdByUserId: owner.id,
        },
      });

      const shared = await as.outsider.get("/drawings/shared");
      expect(shared.body.drawings.some((d: any) => d.id === drawing.id)).toBe(
        true,
      );
    });

    it("only lets the owner share a drawing with a team", async () => {
      const team = await createTeamWithMembers("Drawing Owner Only");
      const drawing = await createDrawing();
      const denied = await as.member.post(
        `/drawings/${drawing.id}/team-permissions`,
        { teamId: team.id, role: "edit" },
      );
      expect(denied.status).toBe(404);
    });

    it("suggests teams in the drawing share search", async () => {
      const team = await createTeam("Drawing Search Crew");
      const drawing = await createDrawing();
      const found = await as.owner.get(
        `/drawings/${drawing.id}/share-resolve?q=search crew`,
      );
      expect(found.status).toBe(200);
      expect(found.body.teams.map((t: any) => t.id)).toContain(team.id);
    });
  });
});
