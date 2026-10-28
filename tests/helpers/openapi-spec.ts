import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Reader for `docs/api/openapi.yaml`, shared by the unit and integration parity guards.
 *
 * The spec is hand-maintained, so it drifts the moment someone adds, renames or removes a route. Both
 * guards parse the SAME bytes with the SAME parser: a second copy of the scanner could drift from the
 * first and let a mismatch through, which is the exact failure this machinery exists to prevent.
 *
 * Deliberately a tiny indentation scanner instead of a YAML dependency: the spec is machine-regular by
 * construction, and if that structure ever changes the scan finds 0 operations — which fails the count
 * assertion in the unit guard loudly instead of passing quietly. That is the whole reason the count
 * check exists.
 */

export const SPEC_FILE = path.resolve(process.cwd(), 'docs', 'api', 'openapi.yaml');
export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export type OpenApiMethod = (typeof HTTP_METHODS)[number];

export type OpenApiOperation = {
  /** Path template exactly as written in the spec, e.g. `/api/v1/reservations/{id}/cancel`. */
  path: string;
  method: OpenApiMethod;
  operationId: string | undefined;
  /** Response status codes declared for this operation, as written (`201`, `404`, …). */
  statuses: string[];
  /** True when the operation opts out of the document-wide bearer requirement with `security: []`. */
  anonymous: boolean;
};

export function readSpecText(): string {
  return readFileSync(SPEC_FILE, 'utf8');
}

export function scanOpenApiOperations(text: string): OpenApiOperation[] {
  const lines = text.split(/\r?\n/);
  const operations: OpenApiOperation[] = [];
  let inPaths = false;
  let currentPath: string | null = null;
  let current: OpenApiOperation | null = null;

  for (const line of lines) {
    if (line.startsWith('paths:')) {
      inPaths = true;
      continue;
    }
    // Any other top-level key ends the paths section.
    if (inPaths && /^[^\s]/.test(line)) {
      inPaths = false;
      currentPath = null;
      current = null;
    }
    if (!inPaths) continue;

    const pathMatch = /^ {2}(\/[^:]*):$/.exec(line);
    if (pathMatch?.[1] !== undefined) {
      currentPath = pathMatch[1];
      current = null;
      continue;
    }
    const methodMatch = /^ {4}(get|post|put|patch|delete):$/i.exec(line);
    if (methodMatch?.[1] !== undefined && currentPath !== null) {
      current = {
        path: currentPath,
        method: methodMatch[1].toLowerCase() as OpenApiMethod,
        operationId: undefined,
        statuses: [],
        anonymous: false,
      };
      operations.push(current);
      continue;
    }
    if (current === null) continue;

    const idMatch = /^ {6}operationId:\s*(\S+)\s*$/.exec(line);
    if (idMatch?.[1] !== undefined) current.operationId = idMatch[1];

    // `security: []` directly under an operation overrides the document-level bearer requirement.
    if (/^ {6}security:\s*\[\s*\]\s*$/.test(line)) current.anonymous = true;

    // Both response styles count: a block (`'201':` then indented content) and an inline reference
    // (`'401': { $ref: '#/components/responses/Unauthorized' }`). Requiring end-of-line here silently
    // dropped every inline response, which made correctly-documented operations look undocumented.
    const statusMatch = /^ {8}'?(\d{3})'?:/.exec(line);
    if (statusMatch?.[1] !== undefined) current.statuses.push(statusMatch[1]);
  }
  return operations;
}

/**
 * Replaces `{param}` placeholders with concrete values. `overrides` is keyed by `OPERATION path`, so a
 * spec that gains a path parameter nobody mapped cannot silently be requested as a literal `{id}`.
 */
export function resolvePath(
  operation: OpenApiOperation,
  overrides: Record<string, Record<string, string>>,
): string {
  const key = `${operation.method.toUpperCase()} ${operation.path}`;
  const values = overrides[key] ?? {};
  let unresolved = operation.path;
  for (const [name, value] of Object.entries(values)) {
    unresolved = unresolved.replace(`{${name}}`, value);
  }
  if (unresolved.includes('{') || unresolved.includes('}')) {
    throw new Error(
      `openapi parity: no concrete value for the path parameter in "${key}" (resolved to ${unresolved}). ` +
        'Add it to the override map in tests/integration/openapi-parity.test.ts.',
    );
  }
  return unresolved;
}

/**
 * Discriminator for "no route matched". `notFoundHandler` phrases its 404 as `No route for METHOD PATH`,
 * which is distinguishable from a genuine resource-not-found (`GET /api/v1/lab/runs/<valid-uuid>` answers
 * 404 too, but from inside a handler that certainly exists).
 */
export function isUnrouted(response: { status: number; body: unknown }): boolean {
  const body = response.body as { error?: { code?: string; message?: string } } | undefined;
  return (
    response.status === 404 &&
    body?.error?.code === 'not_found' &&
    /^No route for /.test(body.error.message ?? '')
  );
}
