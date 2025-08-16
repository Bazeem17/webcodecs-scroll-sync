# webcodecs-scroll-sync

A video decoder that synchronizes video playback with scroll position using the WebCodecs API.

## Dependencies

This project requires **mediabunny** as a dependency:

```bash
npm install mediabunny
```

## Files Overview

- `decoder.ts` - Core `FrameDecoder` class that handles video decoding and buffering
- `canvas.tsx` - React component example showing integration with scroll events
- `utils.ts` - Utility functions (assertion helper)

## Basic Usage

### 1. Initialize the Decoder

The `FrameDecoder` must be initialized with a video URL:

```javascript
import { FrameDecoder } from './decoder';

const decoder = new FrameDecoder();

// Initialize with video URL
await decoder.init('https://example.com/your-video.mp4');
```

### 2. Seek to Video Position

Use the `seek()` method to jump to specific video positions based on scroll:

```javascript
// Seek to 50% through the video
decoder.seek(0.5);

// Render the current frame
decoder.drawFrame(ctx, canvas.width, canvas.height);
```

### 3. Render Frames

Draw the current frame to a canvas:

```javascript
const canvas = document.getElementById('myCanvas');
const ctx = canvas.getContext('2d');

const drawFrame = () => {
  decoder.drawFrame(ctx, canvas.width, canvas.height);
  requestAnimationFrame(drawFrame);
};

drawFrame();
```

## React Example

The included `canvas.tsx` demonstrates a complete React implementation with scroll synchronization:

```jsx
import { Canvas } from './canvas';

function App() {
  return (
    <div>
      <Canvas src="https://example.com/your-video.mp4" />
      {/* Your scrollable content */}
    </div>
  );
}
```

## Framework Agnostic Usage

While `canvas.tsx` shows a React example, the core decoder can be used with any JavaScript framework:

### Vanilla JavaScript
```javascript
import { FrameDecoder } from './decoder';

const decoder = new FrameDecoder();
await decoder.init('your-video-url.mp4');

window.addEventListener('scroll', () => {
  const scrollFraction = window.scrollY / (document.documentElement.scrollHeight - window.innerHeight);
  decoder.seek(scrollFraction);
});
```

## Key Features

- **Efficient Buffering**: Maintains optimal frame buffer based on current playback position
- **Smooth Seeking**: Binary search algorithms for fast frame lookup
- **Memory Management**: Automatic cleanup of unused video frames
- **Bidirectional Playback**: Optimized for both forward and backward seeking
- **High Performance**: Uses WebCodecs API for hardware-accelerated video decoding

**Note**: The required buffer range is highly dependent on the density of keyframes in your video footage. Videos with more frequent keyframes will perform better with this decoder.

## Browser Support

Requires browsers with WebCodecs API support:
- Chrome 94+
- Edge 94+
- Opera 80+
- Firefox 130+
- Safari 16.4+

(Firefox for Andriod is not supported)

## Cleanup

Always call `destroy()` when done to free resources:

```javascript
// Cleanup when component unmounts or page unloads
frameDecoder.destroy();
```
