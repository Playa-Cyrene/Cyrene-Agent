const sessionModelMutationQueues = new Map<string, Promise<unknown>>();
export function enqueueSessionModelMutation<T>(sessionId: string, mutation: () => T | Promise<T>): Promise<T> {
  const previous = sessionModelMutationQueues.get(sessionId) ?? Promise.resolve();
  const run = previous.then(mutation, mutation);
  // 队列记账：吞掉错误，不让某一笔失败卡死同会话后续提交
  const tail = run.catch(() => { });
  sessionModelMutationQueues.set(sessionId, tail);
  void tail.then(() => {
    // 收尾清理：仍是队尾时移除，避免已结束会话的队列条目常驻内存
    if (sessionModelMutationQueues.get(sessionId) === tail) {
      sessionModelMutationQueues.delete(sessionId);
    }
  });
  return run;
}
