import { EncodedPacketSink, Input, MP4, UrlSource } from "mediabunny";
import { assert } from "./utils";

/**
 * Keep this many microseconds of video in the buffer
 */
const BUFFER_RANGE = 1_000_000; // microseconds (1 second to each side)
/**
 * Start decoding when DECODE_THRESHOLD many frames are needed
 */
const DECODE_THRESHOLD = 10; // frames

export class FrameDecoder {
  private encodedChunks: EncodedVideoChunk[] = [];
  private frameBuffer: Map<number, VideoFrame> = new Map();
  private decoderQueue: Map<number, PromiseWithResolvers<void>> = new Map();
  private decoderIndex: number = 0;
  private decoder: VideoDecoder | null = null;

  private duration: number = 0;
  private onError?: WebCodecsErrorCallback;
  private seekQueue: number[] = [];
  private processing: boolean = false;

  private currentTimestamp: number = 0;
  private loading: boolean = false;

  /**
   * Get the frame that should be painted
   */
  public get frame(): VideoFrame | null {
    let minDiff = Infinity;
    let bestFrame: VideoFrame | null = null;

    for (const [timestamp, frame] of this.frameBuffer) {
      const diff = Math.abs(timestamp - this.currentTimestamp);
      if (diff < minDiff) {
        minDiff = diff;
        bestFrame = frame;
      }
    }

    return bestFrame;
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
  private findClosestKeyFrameIndex(startIndex: number): number {
    // Search backwards from startIndex to find the nearest key frame
    for (let i = startIndex; i >= 0; i--) {
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

    const timestamps = Array.from(this.frameBuffer.keys());
    const lowerBound = Math.min(...timestamps) - BUFFER_RANGE;
    const upperBound = Math.max(...timestamps) + BUFFER_RANGE;

    let startIndex: number = 0;
    let endIndex: number = 0;

    if (nextTimestamp < lowerBound || nextTimestamp > upperBound) {
      // Case 1: We need a new buffer
      endIndex = this.findClosestChunkIndex(nextTimestamp + BUFFER_RANGE);
      startIndex = this.findClosestChunkIndex(nextTimestamp - BUFFER_RANGE);
      startIndex = this.findClosestKeyFrameIndex(startIndex);
    } else if (nextTimestamp < prevTimestamp) {
      // Case 2: We need to decode backwards
      startIndex = this.findClosestChunkIndex(nextTimestamp - BUFFER_RANGE);
      startIndex = this.findClosestKeyFrameIndex(startIndex);

      const timestamp = Math.min(
        ...Array.from(this.frameBuffer.keys()),
        ...Array.from(this.decoderQueue.keys()),
      );
      // Decode up to the first frame in the buffer
      endIndex = this.findClosestChunkIndex(timestamp) - 1;
    } else if (nextTimestamp > prevTimestamp) {
      // Case 3: We need to decode forwards
      endIndex = this.findClosestChunkIndex(nextTimestamp + BUFFER_RANGE);
      startIndex = this.decoderIndex;
    }

    this.play(nextTimestamp);
    await this.decodeChunks(startIndex, endIndex);
  }

  private async decodeChunks(startIndex: number, endIndex: number) {
    if (endIndex - startIndex <= DECODE_THRESHOLD) {
      return;
    }

    for (let i = startIndex; i < endIndex; i++) {
      this.decodeChunkAt(i);
    }

    await this.decoderQueue.values().next().value?.promise;
  }

  private decodeChunkAt(index: number) {
    // Clamp the index to the valid range
    index = Math.min(Math.max(0, index), this.encodedChunks.length - 1);
    const chunk = this.encodedChunks[index];

    // add the chunk to the queue
    this.decoderQueue.set(chunk.timestamp, Promise.withResolvers<void>());
    this.decoder?.decode(chunk);
    this.decoderIndex = index;
  }

  /**
   * Play the video at the given timestamp
   * @param timestamp - The timestamp to play the video to in microseconds
   */
  public play(timestamp: number): void {
    const targetIndex = this.findClosestChunkIndex(timestamp);
    let currentIndex = this.findClosestChunkIndex(this.currentTimestamp);

    // Could also be a while loop, but this is safer
    for (let i = 0; i < this.encodedChunks.length; i++) {
      if (currentIndex === targetIndex) {
        break;
      } else if (currentIndex > targetIndex) {
        currentIndex--;
      } else {
        currentIndex++;
      }

      // update and wait for the next frame
      this.currentTimestamp = this.encodedChunks[currentIndex].timestamp;
    }

    this.currentTimestamp = this.encodedChunks[targetIndex].timestamp;
  }

  public destroy(): void {
    this.frameBuffer.forEach(frame => frame.close());
    this.frameBuffer.clear();
    this.encodedChunks = [];
    this.decoderQueue.clear();
    this.decoder?.close();
    this.decoder = null;
    this.decoderIndex = 0;
  }

  private frameCallback(frame: VideoFrame): void {
    if (this.decoderQueue.has(frame.timestamp)) {
      this.decoderQueue.get(frame.timestamp)?.resolve();
      this.decoderQueue.delete(frame.timestamp);
    }

    this.frameBuffer.set(frame.timestamp, frame);

    // Make sure we don't remove frames that could be needed for playback
    const lowerBound = this.currentTimestamp - BUFFER_RANGE;
    const upperBound = this.currentTimestamp + BUFFER_RANGE;

    for (const frame of this.frameBuffer.values()) {
      // remove frames outside the range
      if (frame.timestamp < lowerBound || frame.timestamp > upperBound) {
        this.frameBuffer.delete(frame.timestamp);
        frame.close();
        continue;
      }
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
      formats: [MP4]
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    assert(videoTrack, "No video track found");

    this.duration = Math.floor(await videoTrack.computeDuration() * 1_000_000);

    const config = await videoTrack.getDecoderConfig();
    assert(config, "No decoder config found");
    decoder.configure(config);

    this.encodedChunks = [];
    this.decoder = decoder;
    this.decoderIndex = 0;

    const sink = new EncodedPacketSink(videoTrack);

    for await (const packet of sink.packets()) {
      const chunk = packet.toEncodedVideoChunk();
      this.encodedChunks.push(chunk);

      // Decode initial frames for fast painting
      if (chunk.timestamp <= BUFFER_RANGE) {
        this.decodeChunkAt(this.decoderIndex);
        this.decoderIndex++;
      }
    }

    this.loading = false;
  }
}
