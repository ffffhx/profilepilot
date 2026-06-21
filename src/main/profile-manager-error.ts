
export class ProfileManagerError extends Error {
  constructor(
    message: string,
    readonly code = "PROFILE_MANAGER_ERROR"
  ) {
    super(message);
    this.name = "ProfileManagerError";
  }
}
