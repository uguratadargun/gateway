import { NextResponse, type NextRequest } from "next/server";

import { ADMIN_COOKIE, adminConfigured, verifySessionToken } from "@/lib/admin-auth";
import { GATE_VERSION, MIN_CLIENT_VERSION, VERSION_HEADERS } from "@/lib/protocol";

/**
 * Protects the dashboard and management API behind the admin session.
 * The gateway itself (/api/gateway/*) is excluded — it has its own key auth.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Surfaces with their own auth: the gateway takes an API key, and so does the
  // client API the CLI on a developer's machine talks to. Neither can sit
  // behind the admin cookie — there is no browser on the other end.
  if (pathname.startsWith("/api/gateway/")) return NextResponse.next();
  if (pathname.startsWith("/api/v1/")) {
    // Every client-API response says what this server is and how old a client
    // it will still serve, so a CLI learns it is behind from any call it makes
    // rather than only from the one that finally breaks.
    const res = NextResponse.next();
    res.headers.set(VERSION_HEADERS.server, GATE_VERSION);
    res.headers.set(VERSION_HEADERS.minClient, MIN_CLIENT_VERSION);
    return res;
  }
  if (pathname === "/login" || pathname === "/api/admin/login") return NextResponse.next();

  if (!adminConfigured()) {
    return new NextResponse(
      JSON.stringify({ error: "GATE_ADMIN_SECRET is not set; refusing to serve the admin surface." }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const ok = await verifySessionToken(req.cookies.get(ADMIN_COOKIE)?.value);
  if (ok) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "Admin authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const login = new URL("/login", req.url);
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
