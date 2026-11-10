import { defaultHttpInstance, type HttpInstance } from "@larksuiteoapi/node-sdk";

/** SDK 的分块发送、上传后发送和鉴权刷新共用同一连接的请求边界。 */
export function createCancellableLarkHttp(signal: AbortSignal): HttpInstance {
  const request: HttpInstance["request"] = async (options) => {
    signal.throwIfAborted();
    return defaultHttpInstance.request({ ...options, signal });
  };
  return {
    request,
    get: (url, options) => request({ ...options, url, method: "GET" }),
    delete: (url, options) => request({ ...options, url, method: "DELETE" }),
    head: (url, options) => request({ ...options, url, method: "HEAD" }),
    options: (url, options) => request({ ...options, url, method: "OPTIONS" }),
    post: (url, data, options) => request({ ...options, url, data, method: "POST" }),
    put: (url, data, options) => request({ ...options, url, data, method: "PUT" }),
    patch: (url, data, options) => request({ ...options, url, data, method: "PATCH" }),
  };
}
