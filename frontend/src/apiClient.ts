export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// The session lives in an httpOnly cookie, so requests only need credentials.
// Nothing secret is ever held in the bundle or in browser storage.
export async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) || {}) };
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await response.text();
  const data = text ? safeParse(text) : {};

  if (!response.ok) {
    throw new ApiError(data?.error || `Request failed (${response.status})`, response.status);
  }
  return data as T;
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}
