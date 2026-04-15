import { describe, it, expect } from "vitest";
import { type WorkosClient } from "../../auth/workos-client.js";

describe("WorkosClient interface", () => {
  it("the type allows a stub implementation", () => {
    const stub: WorkosClient = {
      async getAuthorizationUrl(args) {
        return `https://workos.example/authz?state=${args.state}&client=${args.clientId}`;
      },
      async authenticateWithCode(_args) {
        return {
          user: { id: "wu_test", email: "a@b.com", firstName: "A", lastName: "B" },
        };
      },
    };
    expect(stub).toBeDefined();
  });
});
