/** A request that cannot be done, with the HTTP status and the message to show for it. */
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
