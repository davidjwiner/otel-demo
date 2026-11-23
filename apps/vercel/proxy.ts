// "Sign in": give new browsers a dummy user via a session cookie.
import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, USERS } from "./lib/user";

export function proxy(req: NextRequest) {
  if (req.cookies.get(COOKIE)) return NextResponse.next();
  const user = USERS[Math.floor(Math.random() * USERS.length)];
  // Also set it on this request, so the first page render already has a user.
  const headers = new Headers(req.headers);
  headers.set("cookie", `${req.headers.get("cookie") ? req.headers.get("cookie") + "; " : ""}${COOKIE}=${user.id}`);
  const res = NextResponse.next({ request: { headers } });
  res.cookies.set(COOKIE, user.id, { httpOnly: true, sameSite: "lax", path: "/" });
  return res;
}

export const config = { matcher: ["/((?!_next/|otel/|favicon.ico).*)"] };
