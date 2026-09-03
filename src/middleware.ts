import { NextResponse, type NextRequest } from "next/server";

import { ADMIN_COOKIE, adminConfigured, verifySessionToken } from "@/lib/admin-auth";

/**
 * Protects the dashboard and management API behind the admin session.
 * The gateway itself (/api/gateway/*) is excluded — it has its own key auth.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public surfaces.
  if (pathname.startsWith("/api/gateway/")) return NextResponse.next();
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
