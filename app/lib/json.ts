/** `Response.json()` is typed `unknown`, so every caller has to say what it
 *  expects. Naming the shape here keeps that in one place instead of spreading
 *  `as any` casts (and the runtime surprises they hide) through the UI. */
export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Every API route in this app reports failures as `{ error: string }`. */
export type ApiError = { error?: string };
