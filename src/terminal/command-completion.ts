/** Read OSC 633 completion markers independently of PTY/frame boundaries. */
export function createCommandCompletionReader() {
  let pending = "";
  return {
    feed: (chunk: string): number[] => {
      const input = pending + chunk;
      const exitCodes: number[] = [];
      let consumed = 0;
      for (const match of input.matchAll(/\x1b]633;D;(-?\d+)(?:\x07|\x1b\\)/g)) {
        exitCodes.push(Number.parseInt(match[1], 10));
        consumed = match.index! + match[0].length;
      }
      // Exit codes are signed 32-bit values. A bounded suffix is enough for
      // any incomplete marker, including a lone ESC or a split ST terminator.
      // Never retain a completed marker: that would resolve the next run too.
      pending = input.slice(Math.max(consumed, input.length - 64));
      return exitCodes;
    },
    reset: () => {
      pending = "";
    },
  };
}
