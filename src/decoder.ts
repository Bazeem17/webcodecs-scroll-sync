import { EncodedPacketSink, Input, ALL_FORMATS, UrlSource } from "mediabunny";
import { assert } from "./utils";

/**
 * Keep this many microseconds of video in the buffer
 */
const BUFFER_RANGE = 1_000_000; // microseconds (1 second to each side)
/**
 * Decode more frames when the current frame is this close to the boundaries of the buffer
 */
const FORWARD_THRESHOLD_RANGE = 200_000; // microseconds (200ms)
const BACKWARD_THRESHOLD_RANGE = 300_000; // microseconds (300ms)
// Will decode 8 overlapping frames when seeking backwards (hack to avoid flushing)
const BACKWARD_BUFFER_INTERSECT = 8;

export class FrameDecoder {
  private encodedChunks: EncodedVideoChunk[] = [];
  private frameBuffer: Map<number, VideoFrame> = new Map();
  private decoderQueue: Map<number, PromiseWithResolvers<void>> = new Map();
  private decoder: VideoDecoder | null = null;

  private forwardIndex: number | null = null;
  private backwardIndex: number | null = null;

  private duration: number = 0;
  private onError?: WebCodecsErrorCallback;
  private seekQueue: number[] = [];
  private seeking: boolean = false;

  private currentTimestamp: number = 0;
  private loading: boolean = false;

  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private lastDrawnTimestamp: number | null = null;

  public drawFrame(ctx: CanvasRenderingContext2D, width: number, height: number) {
    if (!this.canvas || !this.ctx) return;

    let minDiff = Infinity;
    let bestFrame: VideoFrame | null = null;

    for (const [timestamp, frame] of this.frameBuffer) {
      const diff = Math.abs(timestamp - this.currentTimestamp);
      if (diff < minDiff) {
        minDiff = diff;
        bestFrame = frame;
      }
    }

    if (bestFrame && bestFrame.timestamp != this.lastDrawnTimestamp) {
      this.ctx.drawImage(
        bestFrame,
        0,
        0,
        bestFrame.codedWidth,
        bestFrame.codedHeight
      );
      this.lastDrawnTimestamp = bestFrame.timestamp;
    }

    ctx.drawImage(this.canvas, 0, 0, width, height);
  }

  /**
   * Binary search to find the chunk index closest to the target timestamp
   * @param timestamp - The target timestamp in microseconds
   */
  private findClosestChunkIndex(timestamp: number): number {
    let minDiff = Infinity;
    let bestIndex: number = 0;

    for (let i = 0; i < this.encodedChunks.length; i++) {
      const diff = Math.abs(timestamp - this.encodedChunks[i].timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        bestIndex = i;
      }
    }

    return bestIndex;
  }

  /**
   * Find the nearest key frame at or before the given chunk index
   * @param startIndex - The index to chunk to start searching from
   */
  private findClosestKeyFrameIndex(timestamp: number): number {
    const index = this.findClosestChunkIndex(timestamp);

    // Search backwards from startIndex to find the nearest key frame
    for (let i = index; i >= 0; i--) {
      if (this.encodedChunks[i].type === 'key') {
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
    if (this.frameBuffer.size === 0) return;

    this.seekQueue.push(fraction);

    if (!this.seeking) {
      this.processQueue();
    };
  }

  private async processQueue(): Promise<void> {
    try {
      this.seeking = true;

      while (this.seekQueue.length > 0) {
        // If multiple seeks are queued, skip to the latest one
        const fraction = this.seekQueue.length > 3
          ? this.seekQueue.pop()
          : this.seekQueue.shift();
        if (fraction === undefined) continue;

        // Clear remaining queue if we're processing the latest seek
        if (this.seekQueue.length > 3) {
          this.seekQueue = [];
        }

        await this.dequeueSeek(fraction);
      }

    } finally {
      this.seeking = false;
    }
  }

  private async dequeueSeek(fraction: number): Promise<void> {
    const nextTimestamp = Math.floor(this.duration * Math.max(0, Math.min(1, fraction)));
    const prevTimestamp = this.currentTimestamp;

    const timestamps = [...this.frameBuffer.keys(), ...this.decoderQueue.keys()];

    const upperBound = Math.max(...timestamps);
    const lowerBound = Math.min(...timestamps);
    const outOfBounds = nextTimestamp < lowerBound || nextTimestamp > upperBound + BUFFER_RANGE / 2;

    const lowerBoundDiff = nextTimestamp - lowerBound;
    const upperBoundDiff = upperBound - nextTimestamp;

    let startIndex: number | null = null;
    let endIndex: number | null = null;
    const promises: (Promise<void> | undefined)[] = [];

    if (outOfBounds) {
      // Case 1: We need a new buffer
      endIndex = this.findClosestChunkIndex(nextTimestamp + BUFFER_RANGE);
      startIndex = this.findClosestKeyFrameIndex(nextTimestamp - BUFFER_RANGE);

      this.decodeChunks(startIndex, endIndex);

      if (this.forwardIndex !== null) {
        this.forwardIndex = endIndex;
        this.backwardIndex = null;
      } else if (this.backwardIndex !== null) {
        this.backwardIndex = startIndex;
        this.forwardIndex = null;
      }

      // Wait for the desired frame to be decoded
      const closestChunkIndex = this.findClosestChunkIndex(nextTimestamp);
      const closestChunk = this.encodedChunks[closestChunkIndex];

      promises.push(this.decoderQueue.get(closestChunk.timestamp)?.promise);
    } else if (
      nextTimestamp < prevTimestamp
      && lowerBoundDiff < BACKWARD_THRESHOLD_RANGE
      && lowerBound > 0
    ) {
      // Case 2: We need to decode backwards
      this.forwardIndex = null;

      startIndex = this.findClosestKeyFrameIndex(nextTimestamp - BUFFER_RANGE);

      // Decode up to the first frame in the buffer
      if (this.backwardIndex === null) {
        endIndex = this.findClosestChunkIndex(upperBound) + BACKWARD_BUFFER_INTERSECT;
      } else {
        endIndex = this.backwardIndex + BACKWARD_BUFFER_INTERSECT;
      }

      if (endIndex !== startIndex + BACKWARD_BUFFER_INTERSECT) {
        this.decodeChunks(startIndex, endIndex);
        this.backwardIndex = startIndex;

        // Wait for the key frame to be decoded
        promises.push(this.decoderQueue.get(this.encodedChunks[startIndex].timestamp)?.promise);
      }
    } else if (
      nextTimestamp > prevTimestamp
      && upperBoundDiff < FORWARD_THRESHOLD_RANGE
      && upperBound < this.duration
    ) {
      // Case 3: We need to decode forwards
      this.backwardIndex = null;

      endIndex = this.findClosestChunkIndex(nextTimestamp + BUFFER_RANGE);

      // If we're decoding forwards, start from the next chunk
      // Otherwise, start from the nearest key frame before the highest bound
      if (this.forwardIndex === null) {
        startIndex = this.findClosestKeyFrameIndex(lowerBound);
      } else {
        startIndex = this.forwardIndex + 1;
      }

      this.decodeChunks(startIndex, endIndex);
      this.forwardIndex = endIndex;

      const firstChunk = this.encodedChunks[startIndex];
      // Wait for the first chunk to be decoded
      if (firstChunk && this.decoderQueue.has(firstChunk.timestamp)) {
        await this.decoderQueue.get(firstChunk.timestamp)?.promise;
      }

      if (endIndex === this.encodedChunks.length - 1) {
        promises.push(this.decoder?.flush());
      }
    }

    await Promise.all(promises);

    this.currentTimestamp = nextTimestamp;
  }

  private decodeChunks(startIndex: number, endIndex: number) {
    for (let i = startIndex; i <= endIndex; i++) {
      // clamp the index to the valid range
      this.decodeChunkAt(i);
    }
  }

  private decodeChunkAt(index: number) {
    // Clamp the index to the valid range
    index = Math.min(Math.max(0, index), this.encodedChunks.length - 1);
    const chunk = this.encodedChunks[index];

    // add the chunk to the queue
    this.decoderQueue.set(chunk.timestamp, Promise.withResolvers<void>());
    this.decoder?.decode(chunk);
  }

  public destroy(): void {
    this.frameBuffer.forEach(frame => frame.close());
    this.frameBuffer.clear();
    this.encodedChunks = [];
    this.decoderQueue.clear();
    this.decoder?.close();
    this.decoder = null;
    this.forwardIndex = 0;
    this.backwardIndex = null;
    this.lastDrawnTimestamp = null;
  }

  private frameCallback(frame: VideoFrame): void {
    this.decoderQueue.get(frame.timestamp)?.resolve();
    this.decoderQueue.delete(frame.timestamp);

    // Make sure we don't remove frames that could be needed for playback
    const lowerBound = this.currentTimestamp - BUFFER_RANGE;
    const upperBound = this.currentTimestamp + BUFFER_RANGE;

    for (const f of this.frameBuffer.values()) {
      // remove frames outside the range
      if (f.timestamp <= lowerBound || f.timestamp > upperBound) {
        this.frameBuffer.delete(f.timestamp);
        f.close();
      }
    }

    if (!this.frameBuffer.has(frame.timestamp)) {
      this.frameBuffer.set(frame.timestamp, frame);
    } else {
      frame.close();
    }
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
      formats: ALL_FORMATS
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    assert(videoTrack, "No video track found");

    this.canvas = new OffscreenCanvas(videoTrack.codedWidth, videoTrack.codedHeight);
    this.ctx = this.canvas.getContext('2d')!;

    this.duration = Math.floor(await videoTrack.computeDuration() * 1_000_000);

    const config = await videoTrack.getDecoderConfig();
    assert(config, "No decoder config found");
    decoder.configure(config);

    this.encodedChunks = [];
    this.decoder = decoder;
    this.forwardIndex = 0;
    this.backwardIndex = null;

    const sink = new EncodedPacketSink(videoTrack);

    for await (const packet of sink.packets()) {
      const chunk = packet.toEncodedVideoChunk();
      this.encodedChunks.push(chunk);

      // Decode initial frames for fast painting
      if (chunk.timestamp <= BUFFER_RANGE) {
        this.decodeChunkAt(this.forwardIndex);
        this.forwardIndex++;
      }
    }

    this.loading = false;
  }
}
