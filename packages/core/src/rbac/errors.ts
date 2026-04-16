export class SelfDemoteError extends Error {
  constructor() {
    super("An admin cannot demote themselves");
    this.name = "SelfDemoteError";
  }
}

export class LastAdminError extends Error {
  constructor() {
    super("Cannot demote the last remaining admin");
    this.name = "LastAdminError";
  }
}
