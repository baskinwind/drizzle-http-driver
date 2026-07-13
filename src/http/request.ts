import { DrizzleProxyError } from './error';

import type {
  DrizzleProxyConfig,
  DrizzleProxyQueryResult,
  DrizzleProxyReleaseRequest,
  DrizzleProxyRequest,
} from '../types';

const serializeJson = (
  body: DrizzleProxyReleaseRequest | DrizzleProxyRequest,
) => JSON.stringify(body, (_key, value: unknown) => {
  return typeof value === 'bigint' ? value.toString() : value;
});

const parseJson = async (response: Response) => response.json() as Promise<unknown>;

const getHeaders = async (config: DrizzleProxyConfig) => {
  const customHeaders = typeof config.headers === 'function'
    ? await config.headers()
    : config.headers;
  const headers = new Headers(customHeaders);
  const token = typeof config.token === 'function'
    ? await config.token()
    : config.token;

  headers.set('content-type', 'application/json');
  headers.set('x-db-token', token);

  return headers;
};

const getErrorMessage = (status: number, body: unknown) => {
  if (body && typeof body === 'object') {
    const value = body as { error?: unknown; message?: unknown };
    if (typeof value.message === 'string') return value.message;
    if (typeof value.error === 'string') return value.error;
  }

  return `DB proxy request failed with status ${status}`;
};

export const request = async (
  config: DrizzleProxyConfig,
  endpoint: string,
  body: DrizzleProxyReleaseRequest | DrizzleProxyRequest,
  responseRequired = true,
) => {
  const fetchImplementation = config.fetch ?? globalThis.fetch;
  if (!fetchImplementation) {
    throw new DrizzleProxyError(
      'No fetch implementation is available. Pass fetch in DrizzleProxyConfig.',
    );
  }

  const serialize = config.serialize ?? serializeJson;
  const parseResponse = config.parseResponse ?? parseJson;
  let response: Response;

  try {
    response = await fetchImplementation(endpoint, {
      ...config.requestInit,
      body: serialize(body),
      headers: await getHeaders(config),
      method: 'POST',
    });
  }
  catch (cause) {
    throw new DrizzleProxyError('DB proxy request could not be completed', { cause });
  }

  if (response.ok && !responseRequired) return undefined;

  let responseBody: unknown;
  try {
    responseBody = await parseResponse(response);
  }
  catch (cause) {
    if (!response.ok) {
      throw new DrizzleProxyError(
        `DB proxy request failed with status ${response.status}`,
        {
          cause,
          status: response.status,
          statusText: response.statusText,
        },
      );
    }

    throw new DrizzleProxyError('DB proxy returned an invalid response', {
      cause,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (!response.ok) {
    throw new DrizzleProxyError(getErrorMessage(response.status, responseBody), {
      body: responseBody,
      status: response.status,
      statusText: response.statusText,
    });
  }

  return responseBody;
};

export const normalizeQueryResult = (
  body: unknown,
): DrizzleProxyQueryResult<unknown[] | Record<string, unknown>> => {
  if (!body || typeof body !== 'object') {
    throw new DrizzleProxyError('DB proxy response must be a JSON object', { body });
  }

  const result = body as Partial<DrizzleProxyQueryResult>;
  if (result.rows !== undefined && !Array.isArray(result.rows)) {
    throw new DrizzleProxyError('DB proxy response rows must be an array', { body });
  }

  return {
    command: typeof result.command === 'string' ? result.command : '',
    fields: Array.isArray(result.fields) ? result.fields : [],
    oid: typeof result.oid === 'number' ? result.oid : 0,
    rowCount: typeof result.rowCount === 'number'
      ? result.rowCount
      : (result.rows?.length ?? 0),
    rows: (result.rows ?? []) as (unknown[] | Record<string, unknown>)[],
    timing: result.timing,
  };
};
