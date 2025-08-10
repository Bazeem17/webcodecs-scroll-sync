import { EncodedPacketSink, Input, MP4, UrlSource } from "mediabunny";
import { assert } from "./utils";

/**
 * Keep this many microseconds of video in the buffer
 */
const BUFFER_RANGE = 1_500_000; // 1.5 seconds
const FPS = 60;

export class FrameDecoder {
  private chunks: EncodedVideoChunk[] = [];
  private buffer: VideoFrame[] = [];
  private decoder: VideoDecoder | null = null;

  private duration: number = 0;
  private onError?: WebCodecsErrorCallback;
  private seekQueue: number[] = [];
  private processing: boolean = false;

  private currentTimestamp: number = 0;
  private nextTimestamp: number = 0;
  private decoderPointer: number | null = null;
  private direction: 'forward' | 'backward' = 'forward';
  private loading: boolean = false;

  /**
   * Get the frame that should be painted
   */
  public get frame(): VideoFrame | null {
    if (this.buffer.length === 0) return null;

    let left = 0;
    let right = this.buffer.length - 1;
    let result: VideoFrame | null = null;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const frame = this.buffer[mid];

      if (frame.timestamp >= this.currentTimestamp) {
        result = frame;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    return result;
  }

  private getBufferRange(bound: 'lower' | 'upper'): number {
    if (bound == 'upper') {
      return BUFFER_RANGE;
    }

    return this.direction === 'backward'
      ? BUFFER_RANGE * 2
      : BUFFER_RANGE;
  }

  /**
   * Binary search to find the chunk index closest to the target timestamp
   * @param timestamp - The target timestamp in microseconds
   */
  private findClosestChunkIndex(timestamp: number): number {
    let left = 0;
    let right = this.chunks.length - 1;
    let bestIndex = 0;
    let minDiff = Infinity;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const chunk = this.chunks[mid];
      const diff = Math.abs(chunk.timestamp - timestamp);

      if (diff < minDiff) {
        minDiff = diff;
        bestIndex = mid;
      }

      if (chunk.timestamp < timestamp) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return bestIndex;
  }

  /**
   * Find the nearest key frame at or before the given chunk index
   * @param startIndex - The index to chunk to start searching from
   */
  private findClosestKeyFrameIndex(startIndex: number): number {
    // Search backwards from startIndex to find the nearest key frame
    for (let i = startIndex; i >= 0; i--) {
      if (this.chunks[i].type === 'key') {
        return i;
      }
    }
    // If no key frame found, start from the beginning
    return 0;
  }

  /**
   * Seek to a specific fraction of the video
   * @param fraction - The fraction of the video to seek to (0-1)
   */
  public seek(fraction: number): void {
    if (this.buffer.length === 0) return;

    this.seekQueue.push(fraction);

    if (!this.processing) {
      this.processQueue();
    };
  }

  private async processQueue(): Promise<void> {
    try {
      this.processing = true;

      while (this.seekQueue.length > 0) {
        // If multiple seeks are queued, skip to the latest one
        const fraction = this.seekQueue.length > 3 ? this.seekQueue.pop() : this.seekQueue.shift();
        if (fraction === undefined) continue;

        // Clear remaining queue if we're processing the latest seek
        if (this.seekQueue.length > 3) {
          this.seekQueue = [];
        }

        await this.dequeueSeek(fraction);
      }

    } finally {
      this.processing = false;
    }
  }

  private async dequeueSeek(fraction: number): Promise<void> {
    const nextTimestamp = Math.round(this.duration * Math.max(0, Math.min(1, fraction)));
    const prevTimestamp = this.currentTimestamp;

    if (
      (prevTimestamp === 0 && nextTimestamp === 0) ||
      (prevTimestamp === this.duration && nextTimestamp === this.duration) ||
      (prevTimestamp === nextTimestamp)
    ) {
      return;
    }

    this.nextTimestamp = nextTimestamp;

    const firstFrameTimestamp = this.buffer[0]?.timestamp ?? 0;
    const lastFrameTimestamp = this.buffer[this.buffer.length - 1]?.timestamp ?? 0;
    const playPromise = this.play(nextTimestamp);

    // Calculate buffer bounds with tolerance
    const lowerBound = firstFrameTimestamp - this.getBufferRange('lower') / 2;
    const upperBound = lastFrameTimestamp + this.getBufferRange('upper') / 2;

    if (this.buffer.length === 0 || nextTimestamp < lowerBound || nextTimestamp > upperBound) {
      // Case 1: New buffer is needed only if we're significantly outside current buffer
      await this.createNewBuffer(nextTimestamp);
    } else if (nextTimestamp > prevTimestamp) {
      // Case 2: Forward seeking within or near buffer
      await this.handleForwardSeek(nextTimestamp);
    } else {
      // Case 3: Backward seeking within or near buffer
      await this.handleBackwardSeek(nextTimestamp);
    }

    await playPromise;
  }

  private async createNewBuffer(targetTimestamp: number): Promise<void> {
    this.decoderPointer = null;
    this.buffer.forEach(frame => frame.close());
    this.buffer = [];

    const startIndex = this.findClosestChunkIndex(targetTimestamp - this.getBufferRange('lower'));
    const endIndex = this.findClosestChunkIndex(targetTimestamp + this.getBufferRange('upper'));

    this.decodeChunks(this.findClosestKeyFrameIndex(startIndex), endIndex);
  }

  private async handleForwardSeek(nextTimestamp: number): Promise<void> {
    this.direction = 'forward';

    const bufferEndTime = this.buffer[this.buffer.length - 1]?.timestamp ?? 0;
    const neededEndTime = nextTimestamp + this.getBufferRange('upper');

    if (this.decoderPointer === null) {
      const chunkIndex = this.findClosestChunkIndex(nextTimestamp);
      this.decoderPointer = this.findClosestKeyFrameIndex(chunkIndex);
    }

    // Decode additional chunks if needed
    if (neededEndTime > bufferEndTime) {
      const startIndex = this.decoderPointer;
      const endIndex = this.findClosestChunkIndex(neededEndTime);
      this.decodeChunks(startIndex, endIndex);
    }
  }

  private async handleBackwardSeek(nextTimestamp: number): Promise<void> {
    this.direction = 'backward';

    const bufferStartTime = this.buffer[0]?.timestamp ?? Infinity;
    const neededStartTime = nextTimestamp - this.getBufferRange('lower');

    // Only decode if we need frames significantly before our current buffer
    if (neededStartTime < bufferStartTime - this.getBufferRange('lower')) {
      // Find the range to decode
      const endIndex = this.findClosestChunkIndex(this.buffer[0]?.timestamp ?? 0);
      const startIndex = this.findClosestKeyFrameIndex(
        this.findClosestChunkIndex(neededStartTime)
      );

      this.decodeChunks(startIndex, endIndex);
    }
  }

  private decodeChunks(startIndex: number, endIndex: number) {
    for (let i = startIndex; i < endIndex; i++) {
      i = Math.min(Math.max(0, i), this.chunks.length - 1);
      this.decodeChunkAt(i);
    }
  }

  private decodeChunkAt(index: number) {
    this.decoder?.decode(this.chunks[index]);
    this.decoderPointer = index;
  }

  /**
   * Play the video at the given timestamp
   * @param timestamp - The timestamp to play the video to in microseconds
   */
  public async play(timestamp: number): Promise<void> {
    const delta = Math.abs(this.currentTimestamp - timestamp);

    // Time jump is too large
    if (delta > this.getBufferRange('upper')) {
      this.currentTimestamp = timestamp;
      return;
    }

    const frames = Math.floor(delta / 1_000_000 * FPS);
    const direction = timestamp > this.currentTimestamp ? 1 : -1;

    for (let i = 0; i < frames; i++) {
      this.currentTimestamp += direction * 1_000_000 / FPS;
    }
  }

  public destroy(): void {
    this.buffer.forEach(frame => frame.close());
    this.buffer = [];
    this.chunks = [];
    this.decoderPointer = null;
    this.decoder?.close();
    this.decoder = null;
  }

  private frameCallback(frame: VideoFrame): void {
    const lowerBound = this.nextTimestamp - this.getBufferRange('lower');
    const upperBound = this.nextTimestamp + this.getBufferRange('upper');

    // remove frames outside range in a single pass
    const framesToRemove: VideoFrame[] = [];
    const framesToKeep: VideoFrame[] = [];

    for (const f of this.buffer) {
      if (f.timestamp < lowerBound || f.timestamp > upperBound || f.timestamp === frame.timestamp) {
        framesToRemove.push(f);
      } else {
        framesToKeep.push(f);
      }
    }

    // Clean up frames to remove
    framesToRemove.forEach(f => f.close());

    // Add new frame and sort
    framesToKeep.push(frame);
    framesToKeep.sort((a, b) => a.timestamp - b.timestamp);

    this.buffer = framesToKeep;
  }

  /**
   * Initialize the decoder and demux the video
   * @param url - The URL of the video to decode
   */
  public async init(url: string) {
    if (this.loading) return;
    this.loading = true;

    const decoder = new VideoDecoder({
      output: this.frameCallback.bind(this),
      error: this.onError ?? console.error,
    });

    const input = new Input({
      source: new UrlSource(url),
      formats: [MP4]
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    assert(videoTrack, "No video track found");

    this.duration = Math.floor(await videoTrack.computeDuration() * 1_000_000);

    const config = await videoTrack.getDecoderConfig();
    assert(config, "No decoder config found");
    decoder.configure(config);

    this.chunks = [];
    this.decoderPointer = 0;
    this.decoder = decoder;

    const sink = new EncodedPacketSink(videoTrack);

    for await (const packet of sink.packets()) {
      const chunk = packet.toEncodedVideoChunk();
      this.chunks.push(chunk);

      if (chunk.timestamp <= this.getBufferRange('upper')) {
        // Make sure we keep enough frames to paint initially
        this.decodeChunkAt(this.decoderPointer);
        this.decoderPointer++;
      }
    }

    this.loading = false;
  }
}
