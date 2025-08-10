import { EncodedPacketSink, Input, MP4, UrlSource } from "mediabunny";
import { assert } from "./utils";

/**
 * Keep this many microseconds of video in the buffer (to each side)
 */
const BUFFER_RANGE = 1_000_000; // microseconds (2 seconds in total)
/**
 * Start decoding when <DECODE_THRESHOLD> many frames are needed
 */
const DECODE_THRESHOLD = 40; // frames
/**
 * Desired playback rate
 */
const FPS = 60; // frames per second

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

    // Check if outside bounds, and include forward tolerance
    const outsideBuffer = nextTimestamp < firstFrameTimestamp
      || nextTimestamp > lastFrameTimestamp + BUFFER_RANGE / 2;

    let startIndex: number = 0;
    let endIndex: number = 0;
    if (outsideBuffer) {
      // Case 1: We need a new buffer
      endIndex = this.findClosestChunkIndex(nextTimestamp + BUFFER_RANGE);
      startIndex = this.findClosestChunkIndex(nextTimestamp - BUFFER_RANGE);
      startIndex = this.findClosestKeyFrameIndex(startIndex);
    } else if (nextTimestamp < prevTimestamp) {
      // Case 2: We need to decode backwards
      startIndex = this.findClosestChunkIndex(nextTimestamp - BUFFER_RANGE);
      startIndex = this.findClosestKeyFrameIndex(startIndex);
      // Decode up to the first frame in the buffer
      endIndex = this.findClosestChunkIndex(firstFrameTimestamp) - 1;
    } else if (nextTimestamp > prevTimestamp) {
      // Case 3: We need to decode forwards
      startIndex = this.decoderPointer ?? 0;
      endIndex = this.findClosestChunkIndex(nextTimestamp + BUFFER_RANGE);
    }

    this.decodeChunks(startIndex, endIndex);
    await this.play(nextTimestamp);
  }

  private decodeChunks(startIndex: number, endIndex: number) {
    if (endIndex - startIndex <= DECODE_THRESHOLD) {
      return;
    }

    for (let i = startIndex; i < endIndex; i++) {
      this.decodeChunkAt(i);
    }
  }

  private decodeChunkAt(index: number) {
    // Clamp the index to the valid range
    index = Math.min(Math.max(0, index), this.chunks.length - 1);

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
    if (delta > BUFFER_RANGE) {
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
    // Make sure we don't remove frames that could be needed for playback
    const lowerBound = Math.min(this.nextTimestamp, this.currentTimestamp) - BUFFER_RANGE;
    const upperBound = Math.max(this.nextTimestamp, this.currentTimestamp) + BUFFER_RANGE;

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

      // Decode initial frames for fast painting
      if (chunk.timestamp <= BUFFER_RANGE) {
        this.decodeChunkAt(this.decoderPointer);
        this.decoderPointer++;
      }
    }

    this.loading = false;
  }
}
