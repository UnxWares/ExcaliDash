---
title: Teams in Self-hosted Excalidraw
description: Group the people of your ExcaliDash workspace into teams, share collections and drawings with a whole team, and sync team membership from your OpenID Connect provider groups.
---

# Teams

Teams group the people of your workspace. Share a collection or a drawing with a team once, and everyone in it gets access, including the people who join the team later. Removing someone from the team removes that access, also from drawings they have open.

Teams need authentication. Open **Teams** from the account menu in the sidebar.

## Create a team

Administrators create teams. In **Teams**, select **New team**, enter a name, and optionally the identity provider group to sync it from. Teams can also be created automatically from provider groups, see [Sync teams from your identity provider](#sync-teams-from-your-identity-provider).

Administrators see every team. Other people see the teams they belong to.

## Manage members

Select a team to see its members. Search people by name or email to add them, and choose their role:

| Role    | What it allows                                                 |
| ------- | -------------------------------------------------------------- |
| Member  | Receives what is shared with the team                          |
| Manager | Also adds and removes members, changes roles, renames the team |

Administrators can manage every team. A member added by hand can leave the team from the same page.

## Share with a team

In a drawing's **Share** controls, or in **Share Collection** for a collection, type the name of a team and select it. Choose viewing or editing access, as for a person. The team's members find the drawing under **Shared with me**, or the collection in their sidebar.

When someone has access both directly and through teams, the strongest access applies. Only the owner of a drawing or collection can share it with a team.

## Sync teams from your identity provider

With [OpenID Connect](/guide/authentication#configure-openid-connect), team membership can follow the groups of your identity provider. ExcaliDash reads the groups from the claim set in `OIDC_GROUPS_CLAIM` (default `groups`) at each sign-in:

- **Linked teams.** An administrator links a team to a provider group in **Teams**. People in that group join the team when they sign in.
- **Automatic teams.** Set `OIDC_TEAM_GROUP_PREFIX`, for example to `excalidash-`. Each group starting with the prefix becomes a team the first time one of its members signs in, named after the group without the prefix: `excalidash-design` becomes `design`.

At each sign-in, people leave the synced teams whose group they are no longer in. Synced members are marked in the member list and cannot be removed in ExcaliDash: remove them from the group in the provider instead. Members added by hand are never changed by the sync, even in a linked team.

Keep in mind:

- Changes in the provider apply when the person signs in again. To cut access sooner, deactivate the account in **Admin**.
- If the provider stops sending the groups claim, ExcaliDash keeps the existing memberships rather than empty every team. Check that the client requests the scope that includes groups.
- Unlinking a team from its group keeps its synced members as members added by hand. Linking it to another group removes them; the new group's members join at their next sign-in.

```yaml
services:
  backend:
    environment:
      OIDC_GROUPS_CLAIM: groups
      OIDC_TEAM_GROUP_PREFIX: excalidash-
```
