import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { PlayfulSelect } from "../src/components/PlayfulSelect";
import { SharePeopleSection } from "../src/components/share-modal/SharePeopleSection";
import { TeamDetailsCard } from "../src/pages/teams/TeamDetailsCard";
import type { TeamDetails, TeamMember } from "../src/types";

vi.mock("react-dom", () => ({
  createPortal: (children: React.ReactNode) => children,
}));
vi.mock("../src/api", () => ({
  resolveTeamMemberCandidates: vi.fn(async () => []),
}));

const member = (overrides: Partial<TeamMember>): TeamMember => ({
  userId: "user-1",
  name: "Ada",
  email: "ada@example.com",
  role: "member",
  source: "manual",
  createdAt: "2026-10-30T00:00:00.000Z",
  ...overrides,
});

const team = (overrides: Partial<TeamDetails>): TeamDetails => ({
  id: "team-1",
  name: "Design",
  description: null,
  oidcGroup: null,
  myRole: "member",
  canManage: false,
  canEditGroup: false,
  members: [],
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
  ...overrides,
});

const textOf = (node: ReactTestInstance): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");

const buttonsWithText = (root: ReactTestInstance, text: string) =>
  root.findAll((node) => node.type === "button" && textOf(node).includes(text));

const renderCard = (
  props: Partial<React.ComponentProps<typeof TeamDetailsCard>>,
) => {
  const handlers = {
    onSave: vi.fn(async () => {}),
    onDelete: vi.fn(),
    onAddMember: vi.fn(async () => {}),
    onChangeRole: vi.fn(async () => {}),
    onRemoveMember: vi.fn(async () => {}),
  };
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <TeamDetailsCard
        team={team({})}
        currentUserId="user-1"
        busy={false}
        {...handlers}
        {...props}
      />,
    );
  });
  return { root: renderer.root, handlers };
};

describe("TeamDetailsCard", () => {
  it("lets managers remove members added by hand but not synced ones", () => {
    const manual = member({ userId: "user-2", name: "Grace" });
    const synced = member({ userId: "user-3", name: "Linus", source: "oidc" });
    const { root, handlers } = renderCard({
      team: team({
        canManage: true,
        myRole: "manager",
        oidcGroup: "design",
        members: [manual, synced],
      }),
    });

    const removeGrace = root.find(
      (node) =>
        node.type === "button" && node.props["aria-label"] === "Remove Grace",
    );
    const removeLinus = root.find(
      (node) =>
        node.type === "button" && node.props["aria-label"] === "Remove Linus",
    );
    expect(removeLinus.props.disabled).toBe(true);
    expect(removeGrace.props.disabled).toBe(false);

    act(() => removeGrace.props.onClick());
    expect(handlers.onRemoveMember).toHaveBeenCalledWith(manual);

    // Managers who are not admins cannot change the identity provider link.
    const groupInput = root.find(
      (node) => node.type === "input" && node.props.id === "team-group",
    );
    expect(groupInput.props.disabled).toBe(true);
    expect(buttonsWithText(root, "Delete team")).toHaveLength(0);
  });

  it("lets admins edit the group link and delete the team", () => {
    const { root, handlers } = renderCard({
      team: team({ canManage: true, canEditGroup: true, myRole: null }),
    });
    const groupInput = root.find(
      (node) => node.type === "input" && node.props.id === "team-group",
    );
    expect(groupInput.props.disabled).toBe(false);

    act(() => buttonsWithText(root, "Delete team")[0]?.props.onClick());
    expect(handlers.onDelete).toHaveBeenCalled();
  });

  it("offers to leave only a team the member was added to by hand", () => {
    const self = member({});
    const { root, handlers } = renderCard({ team: team({ members: [self] }) });
    const leave = buttonsWithText(root, "Leave team");
    expect(leave).toHaveLength(1);
    act(() => leave[0]?.props.onClick());
    expect(handlers.onRemoveMember).toHaveBeenCalledWith(self);

    const synced = renderCard({
      team: team({ members: [member({ source: "oidc" })] }),
    });
    expect(buttonsWithText(synced.root, "Leave team")).toHaveLength(0);
    // Plain members see roles but cannot change them.
    expect(synced.root.findAllByType(PlayfulSelect)).toHaveLength(0);
  });
});

describe("SharePeopleSection with teams", () => {
  const renderSection = () => {
    const handlers = {
      setUserQuery: vi.fn(),
      setUserPermission: vi.fn(),
      handleAddUser: vi.fn(),
      handleRevokeUser: vi.fn(),
      handleUpdateUserPermission: vi.fn(),
      handleAddTeam: vi.fn(),
      handleRevokeTeam: vi.fn(),
      handleUpdateTeamPermission: vi.fn(),
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <SharePeopleSection
          user={{ name: "Owner", email: "owner@example.com" }}
          sharing={{
            permissions: [],
            teamPermissions: [
              {
                teamId: "team-shared",
                permission: "view",
                createdAt: "2026-10-30T00:00:00.000Z",
                team: { id: "team-shared", name: "Ops", memberCount: 3 },
              },
            ],
          }}
          userQuery="des"
          userPermission="edit"
          userResults={[]}
          teamResults={[{ id: "team-found", name: "Design", memberCount: 1 }]}
          {...handlers}
        />,
      );
    });
    return { root: renderer.root, handlers };
  };

  it("adds a team found by the search with the selected permission", () => {
    const { root, handlers } = renderSection();
    const result = buttonsWithText(root, "Design")[0];
    expect(result).toBeTruthy();
    expect(textOf(result!)).toContain("1 member");
    act(() => result!.props.onClick());
    expect(handlers.handleAddTeam).toHaveBeenCalledWith("team-found");
  });

  it("lists teams with access and lets the owner change or remove them", async () => {
    const { root, handlers } = renderSection();
    const select = root
      .findAllByType(PlayfulSelect)
      .find((node) => node.props.ariaLabel === "Access for team Ops");
    expect(select?.props.value).toBe("view");

    await act(async () => select!.props.onChange("edit"));
    expect(handlers.handleUpdateTeamPermission).toHaveBeenCalledWith(
      "team-shared",
      "edit",
    );
    await act(async () => select!.props.onChange("remove"));
    expect(handlers.handleRevokeTeam).toHaveBeenCalledWith("team-shared");
  });
});
