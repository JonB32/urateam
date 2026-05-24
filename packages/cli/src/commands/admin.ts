import { Command } from "commander";
import * as os from "node:os";
import {
  createDb,
  isFeatureLicensed,
  listUsers,
  setUserRole,
  terminateRun,
  type Role,
} from "@urateam/core";

export interface AdminDeps {
  db: any;
  log: (msg: string) => void;
}

function requireLicensed(): void {
  if (!isFeatureLicensed("rbac")) {
    throw new Error(
      "RBAC is an Enterprise feature. Upgrade your license to use 'ura admin' commands.",
    );
  }
}

function actorId(): string {
  try {
    return `cli:${os.userInfo().username}`;
  } catch {
    return "cli:unknown";
  }
}

export async function runAdminList(deps: AdminDeps): Promise<void> {
  requireLicensed();
  const users = await listUsers(deps.db);
  deps.log("EMAIL                            ROLE       LAST_LOGIN");
  for (const u of users) {
    const email = u.email.padEnd(32).slice(0, 32);
    const role = u.role.padEnd(10).slice(0, 10);
    const ll = u.lastLoginAt ? u.lastLoginAt.toISOString() : "(never)";
    deps.log(`${email} ${role} ${ll}`);
  }
}

export async function runAdminGrant(
  args: AdminDeps & { email: string; newRole: Role },
): Promise<void> {
  requireLicensed();
  const normalized = args.email.trim().toLowerCase();
  const users = await listUsers(args.db);
  const target = users.find((u) => u.email.toLowerCase() === normalized);
  if (!target) {
    throw new Error(`user not found: ${args.email}`);
  }

  await setUserRole(args.db, {
    userId: target.id,
    newRole: args.newRole,
    actorUserId: actorId(),
  });
  args.log(`Updated ${target.email} → ${args.newRole}`);
}

export async function runAdminRevoke(
  args: AdminDeps & { email: string },
): Promise<void> {
  await runAdminGrant({ ...args, newRole: "viewer" });
}

export async function runAdminTerminate(
  args: AdminDeps & { runId: string },
): Promise<void> {
  const result = await terminateRun(args.db, args.runId);
  args.log(`Terminated run ${result.runId} (issue: ${result.issueId}, was: ${result.previousStatus})`);
  args.log("The issue can now be resubmitted without orphaned process state.");
  args.log("Note: if the executor process is still running, it will hit its wall-clock timeout.");
}

// ---------------- commander wiring ----------------

async function openDb(): Promise<any> {
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    throw new Error(
      "DATABASE_URL is not set. Set it to your urateam database (e.g. postgres://... or file:./ura.db).",
    );
  }
  return createDb({ connectionString: conn });
}

function fail(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

export const adminCommand = new Command("admin")
  .description("Manage dashboard user roles (Enterprise)")
  .addCommand(
    new Command("list")
      .description("List all dashboard users and their roles")
      .action(async () => {
        try {
          const db = await openDb();
          await runAdminList({ db, log: (s) => console.log(s) });
        } catch (err) {
          fail(err);
        }
      }),
  )
  .addCommand(
    new Command("grant")
      .description("Grant a role to a user (by email)")
      .argument("<email>", "Target user email")
      .option(
        "--role <role>",
        "New role: admin | operator | viewer",
        "operator",
      )
      .action(async (email: string, opts: { role: string }) => {
        if (
          opts.role !== "admin" &&
          opts.role !== "operator" &&
          opts.role !== "viewer"
        ) {
          fail(new Error(`invalid --role: '${opts.role}'`));
        }
        try {
          const db = await openDb();
          await runAdminGrant({
            db,
            email,
            newRole: opts.role as Role,
            log: (s) => console.log(s),
          });
        } catch (err) {
          fail(err);
        }
      }),
  )
  .addCommand(
    new Command("revoke")
      .description("Revoke privileges — sets role to viewer")
      .argument("<email>", "Target user email")
      .action(async (email: string) => {
        try {
          const db = await openDb();
          await runAdminRevoke({
            db,
            email,
            log: (s) => console.log(s),
          });
        } catch (err) {
          fail(err);
        }
      }),
  )
  .addCommand(
    new Command("terminate")
      .description("Terminate a stuck pipeline run and clear its execution lock")
      .argument("<runId>", "Pipeline run ID to terminate (e.g. FyGPSITBTB49blnEdTMlX)")
      .action(async (runId: string) => {
        try {
          const db = await openDb();
          await runAdminTerminate({ db, runId, log: (s) => console.log(s) });
        } catch (err) {
          fail(err);
        }
      }),
  );
