import express from "express";
import { registerCollectionRoutes } from "./collections";
import { registerDrawingRoutes } from "./drawings";
import { registerLibraryRoutes } from "./library";
import { registerTeamSharingRoutes } from "./teamSharing";
import { registerTeamRoutes } from "./teams";
import { DashboardRouteDeps } from "./types";

export const registerDashboardRoutes = (
  app: express.Express,
  deps: DashboardRouteDeps,
) => {
  registerDrawingRoutes(app, deps);
  registerCollectionRoutes(app, deps);
  registerLibraryRoutes(app, deps);
  registerTeamRoutes(app, deps);
  registerTeamSharingRoutes(app, deps);
};

export type { DashboardRouteDeps } from "./types";
