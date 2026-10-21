import type { WsMessage } from '@coldtrace/shared';

type Listener = (message: WsMessage) => void;

/** 行程內的推播匯流排：業務邏輯只負責 publish，不需要知道 WebSocket 的存在 */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(messages: readonly WsMessage[]): void {
    for (const message of messages) {
      for (const listener of this.listeners) listener(message);
    }
  }
}
