import type { DatabaseSync } from "node:sqlite";
import { type ReportRequest, type ReportResult, finishReports, planReports } from "../worker/report";

/** Runs one report the way the Worker does: the plan's statements, then the grouping. */
export function runReport(db: DatabaseSync, req: ReportRequest): ReportResult {
  const plan = planReports(req, [req]);
  return finishReports(
    plan,
    plan.statements.map((s) => db.prepare(s.sql).all(...(s.params as any[]))),
  )[0];
}
