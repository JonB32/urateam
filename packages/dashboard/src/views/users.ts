import type { Role } from "@urateam/core";
import { escapeHtml, layout } from "./layout.js";

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  lastLoginAt: Date | null;
}

export function renderUsersPage(args: {
  users: UserRow[];
  currentUserId: string;
  basePath: string;
  userEmail?: string;
}): string {
  const bp = args.basePath;
  const rows = args.users
    .map((u) => {
      const isSelf = u.id === args.currentUserId;
      const lastLogin = u.lastLoginAt
        ? u.lastLoginAt.toISOString()
        : "(never)";
      const disabled = isSelf ? "disabled" : "";
      return `
      <tr>
        <td>${escapeHtml(u.email)}${isSelf ? " <em>(you)</em>" : ""}</td>
        <td>${escapeHtml(u.name ?? "")}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(lastLogin)}</td>
        <td>
          <form method="post" action="${bp}/users/${escapeHtml(u.id)}/role" hx-post="${bp}/users/${escapeHtml(u.id)}/role" hx-headers='{"HX-Request":"true"}'>
            <select name="role" ${disabled}>
              <option value="admin" ${u.role === "admin" ? "selected" : ""}>admin</option>
              <option value="operator" ${u.role === "operator" ? "selected" : ""}>operator</option>
              <option value="viewer" ${u.role === "viewer" ? "selected" : ""}>viewer</option>
            </select>
            <button type="submit" ${disabled}>Update</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const content = `
  <table class="users-table">
    <thead>
      <tr>
        <th>Email</th><th>Name</th><th>Role</th><th>Last login</th><th></th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;

  return layout("Users", content, bp, {
    userEmail: args.userEmail,
    userRole: "admin",
  });
}
