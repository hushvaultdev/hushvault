import { forward } from '../../../../lib/proxy'

// Catch-all for /api/admin/*. Next.js's router has already matched and decoded `params.path` as
// the literal segments after /api/admin/ in the request URL — this handler only ever receives
// segments of THIS request's own path, never an arbitrary string an attacker could substitute, so
// joining them back under '/api/admin/' cannot escape to a different API route. A segment of '..'
// is matched and passed through like any other literal segment (Next does not resolve '.'/'..' in
// route params), and the rejoined path still starts with '/api/admin/' — see test/proxy.test.ts.
type Params = { path: string[] }

function targetPath(request: Request, params: Params): string {
  const segments = params.path.map((segment) => encodeURIComponent(segment))
  const search = new URL(request.url).search
  return `/api/admin/${segments.join('/')}${search}`
}

export async function GET(request: Request, { params }: { params: Promise<Params> }): Promise<Response> {
  return forward(request, targetPath(request, await params))
}

export async function POST(request: Request, { params }: { params: Promise<Params> }): Promise<Response> {
  return forward(request, targetPath(request, await params))
}

export async function PUT(request: Request, { params }: { params: Promise<Params> }): Promise<Response> {
  return forward(request, targetPath(request, await params))
}

export async function DELETE(request: Request, { params }: { params: Promise<Params> }): Promise<Response> {
  return forward(request, targetPath(request, await params))
}
