/** An answer the server gives for a request it refuses: the status, the reason, and any headers that go with it. */
export class HttpError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  constructor(status: number, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.name = "HttpError";
  }
}
