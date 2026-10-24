/** Ticks for the recorder: a worker's timers keep running while the page is in the background. */
let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (e: MessageEvent<{ interval: number }>) => {
  clearInterval(timer);
  timer = setInterval(() => self.postMessage(0), Math.max(50, e.data.interval));
};
