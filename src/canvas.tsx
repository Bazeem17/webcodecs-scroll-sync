import { useEffect, useRef } from "react";
import { FrameDecoder } from "./decoder";
import { assert } from "./utils";

const ASPECT_RATIO = 16 / 9;

const frameDecoder = new FrameDecoder();

type CanvasProps = {
  src: string;
}

export function Canvas({ src }: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeObserver = useRef<ResizeObserver>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const backgroundCanvas = backgroundCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !backgroundCanvas || !container) return;

    const videoCtx = canvas.getContext("2d");
    const backgroundCtx = backgroundCanvas.getContext("2d");
    assert(videoCtx, "No context found");
    assert(backgroundCtx, "No background context found");

    const drawFrame = () => {
      const { frame: currentFrame } = frameDecoder;

      if (currentFrame) {
        videoCtx.clearRect(0, 0, canvas.width, canvas.height);
        backgroundCtx.clearRect(0, 0, backgroundCanvas.width, backgroundCanvas.height);

        videoCtx.drawImage(currentFrame, 0, 0, canvas.width, canvas.height);

        backgroundCtx.filter = 'blur(20px)';
        const blurOffset = 40; // 2x the blur radius for safe coverage
        backgroundCtx.drawImage(
          canvas,
          -blurOffset,
          -blurOffset,
          backgroundCanvas.width + blurOffset * 2,
          backgroundCanvas.height + blurOffset * 2
        );
      }

      requestAnimationFrame(drawFrame);
    };

    drawFrame();
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      const scrollY = window.scrollY;
      const maxScrollY = document.documentElement.scrollHeight - window.innerHeight;
      const fraction = Math.max(0, Math.min(1, scrollY / maxScrollY));
      frameDecoder.seek(fraction);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    resizeObserver.current = new ResizeObserver(handleResize);
    resizeObserver.current.observe(containerRef.current);

    return () => {
      resizeObserver.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    (async () => {
      await frameDecoder.init(src);

      // Initial seek based on current scroll position
      const scrollY = window.scrollY;
      const maxScrollY = document.documentElement.scrollHeight - window.innerHeight;
      const fraction = Math.max(0, Math.min(1, scrollY / maxScrollY));
      await frameDecoder.seek(fraction);
    })();
    return () => frameDecoder.destroy();
  }, [src]);

  const handleResize = () => {
    const canvas = canvasRef.current;
    const backgroundCanvas = backgroundCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !backgroundCanvas || !container) return;

    const height = container.clientHeight;
    const width = Math.floor(height * ASPECT_RATIO);

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const scale = window.devicePixelRatio;
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);

    // Resize background canvas to cover the entire screen
    backgroundCanvas.style.width = `${window.innerWidth}px`;
    backgroundCanvas.style.height = `${window.innerHeight}px`;
    backgroundCanvas.width = Math.floor(window.innerWidth * scale);
    backgroundCanvas.height = Math.floor(window.innerHeight * scale);
  };

  return (
    <div ref={containerRef} className="fixed inset-0 flex items-center justify-center">
      <canvas ref={canvasRef} className="aspect-video h-full" />
      <canvas ref={backgroundCanvasRef} className="fixed inset-0 -z-10" />
    </div>
  );
};
