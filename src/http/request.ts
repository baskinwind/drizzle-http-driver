import { DrizzleProxyError } from './error';

import type { DrizzleProxyConfig, DrizzleProxyReleaseRequest, DrizzleProxyRequest } from '../types';

const serializeJson = (body: DrizzleProxyReleaseRequest | DrizzleProxyRequest) => {
  return JSON.stringify(body, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
};

const getHeaders = (config: DrizzleProxyConfig) => {
  const headers = new Headers(config.headers);

  headers.set('content-type', 'application/json');
  headers.set('x-db-token', config.token);

  return headers;
};

export const request = async <TData>(
  config: DrizzleProxyConfig,
  endpoint: string,
  body: DrizzleProxyReleaseRequest | DrizzleProxyRequest,
): Promise<TData> => {
  let response: Response | undefined;

  try {
    response = await fetch(endpoint, {
      ...config.requestInit,
      body: serializeJson(body),
      headers: getHeaders(config),
      method: 'POST',
    });

    const responseBody: unknown = await response.json();
    const proxyResponse = responseBody && typeof responseBody === 'object'
      ? responseBody as Record<string, unknown>
      : undefined;

    if (!response.ok) {
      const message = typeof proxyResponse?.error === 'string'
        ? proxyResponse.error
        : `DB proxy request failed with status ${response.status}`;
      throw new DrizzleProxyError(message, {
        body: responseBody,
        status: response.status,
        statusText: response.statusText,
      });
    }

    if (proxyResponse?.success === false) {
      const message = typeof proxyResponse.error === 'string'
        ? proxyResponse.error
        : 'DB proxy returned an invalid response';
      throw new DrizzleProxyError(message, {
        body: responseBody,
        status: response.status,
        statusText: response.statusText,
      });
    }

    if (proxyResponse?.success !== true || !('data' in proxyResponse)) {
      throw new DrizzleProxyError('DB proxy returned an invalid response', {
        body: responseBody,
        status: response.status,
        statusText: response.statusText,
      });
    }

    return proxyResponse.data as TData;
  }
  catch (cause) {
    if (cause instanceof DrizzleProxyError) throw cause;
    if (response) {
      throw new DrizzleProxyError('DB proxy returned invalid JSON', {
        cause,
        status: response.status,
        statusText: response.statusText,
      });
    }
    throw new DrizzleProxyError('DB proxy request could not be completed', { cause });
  }
};
