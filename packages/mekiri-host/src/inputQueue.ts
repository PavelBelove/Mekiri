import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface InputQueue {
  iterable: AsyncIterable<SDKUserMessage>;
  push: (text: string) => void;
  close: () => void;
}

function toUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
}

export function createInputQueue(): InputQueue {
  const queue: string[] = [];
  let waitingResolve: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;

  function push(text: string): void {
    if (waitingResolve) {
      const resolve = waitingResolve;
      waitingResolve = null;
      resolve({ value: toUserMessage(text), done: false });
      return;
    }
    queue.push(text);
  }

  function close(): void {
    closed = true;
    if (waitingResolve) {
      const resolve = waitingResolve;
      waitingResolve = null;
      resolve({ value: undefined, done: true });
    }
  }

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: toUserMessage(queue.shift() as string), done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waitingResolve = resolve;
          });
        },
      };
    },
  };

  return { iterable, push, close };
}
