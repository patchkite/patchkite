export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const conflict = (msg: string) => new HttpError(409, msg);
export const badRequest = (msg: string) => new HttpError(400, msg);
export const forbidden = (msg = "Access denied") => new HttpError(403, msg);
export const unauthorized = (msg = "Unauthorized") => new HttpError(401, msg);
