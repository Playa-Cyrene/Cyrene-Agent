/**
 * 在 SDK 解析之前观察响应数据：文本、原生工具进度、保活消息都重置空闲计时。
 * 标准 TransformStream 原样透传数据，并传播结束、错误和取消。
 */
export function createStreamActivityFetch(
  onStreamActivity: () => void,
  delegate: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await delegate(input, init);
    if (!response.body) return response;

    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk.byteLength > 0) onStreamActivity();
        controller.enqueue(chunk);
      },
    }));
    const monitored = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // Response 构造器不复制这三项网络元数据，显式保留给 SDK 的诊断使用。
    Object.defineProperties(monitored, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return monitored;
  };
}
