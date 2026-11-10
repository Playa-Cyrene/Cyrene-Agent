/** 每次连接独立的撤销信号；旧回调不能借用重启后的连接。 */
export class AdapterActivity {
  private controller = new AbortController();
  signal = this.controller.signal;

  start(parent?: AbortSignal): AbortSignal {
    this.stop();
    this.controller = new AbortController();
    this.signal = parent
      ? AbortSignal.any([parent, this.controller.signal])
      : this.controller.signal;
    return this.signal;
  }

  stop(): void {
    this.controller.abort(new Error("channel_stopped"));
  }
}
