import { forward } from '../../../../lib/proxy'

export async function POST(request: Request): Promise<Response> {
  return forward(request, '/api/auth/logout')
}
