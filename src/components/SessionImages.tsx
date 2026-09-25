"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Tool } from "@/lib/activity";
import { fetchImageStates, imageUrl, MAX_IMAGE_BYTES, requestImages, type ImageRef, type ImageState } from "@/lib/team";
import { Icon } from "./Icon";

/*
 * A session's images in the chat: each asked of its computer when it comes
 * into view (a few at a time, in one request), followed until it is here,
 * then shown as it is; a gallery of all of them; and one at a time, large.
 */

const POLL_MS = 2_000;
const BATCH = 24;

type Loader = {
  deviceName: string;
  url: (n: number) => string;
  state: (n: number) => ImageState | undefined;
  want: (n: number) => void;
  retry: (n: number) => void;
  open: (n: number) => void;
};

const ImageContext = createContext<Loader | null>(null);
export const ImageProvider = ImageContext.Provider;

const chunks = <T,>(list: T[]) => Array.from({ length: Math.ceil(list.length / BATCH) }, (_, i) => list.slice(i * BATCH, (i + 1) * BATCH));

/** Where the images of one session stand, and how to ask for them. */
export function useImageLoader(deviceId: string, tool: Tool, sessionId: string | null, deviceName: string, open: (n: number) => void): Loader | null {
  const [states, setStates] = useState<Record<string, ImageState>>({});
  const queued = useRef(new Set<number>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const key = (n: number) => `${sessionId}:${n}`;
  const merge = useCallback((list: ImageState[]) => setStates((prev) => ({ ...prev, ...Object.fromEntries(list.map((s) => [`${sessionId}:${s.n}`, s])) })), [sessionId]);

  const flush = useCallback(async () => {
    timer.current = undefined;
    const ns = [...queued.current];
    queued.current.clear();
    if (!sessionId) return;
    for (const part of chunks(ns)) {
      const res = await requestImages(deviceId, tool, sessionId, part);
      merge(res.ok ? res.data.images : part.map((n) => ({ n, status: "failed" as const, error: res.error })));
    }
  }, [deviceId, tool, sessionId, merge]);

  // Follow the ones asked for until each is here, or not to be had.
  const pending = Object.entries(states)
    .filter(([k, s]) => k.startsWith(`${sessionId}:`) && s.status === "pending")
    .map(([, s]) => s.n)
    .join(",");
  useEffect(() => {
    if (!pending || !sessionId) return;
    const t = setTimeout(async () => {
      for (const part of chunks(pending.split(",").map(Number))) {
        const res = await fetchImageStates(deviceId, tool, sessionId, part);
        if (res.ok) merge(res.data.images);
      }
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [pending, deviceId, tool, sessionId, merge]);

  if (!sessionId) return null;
  return {
    deviceName,
    url: (n) => imageUrl(deviceId, tool, sessionId, n),
    state: (n) => states[key(n)],
    want: (n) => {
      if (states[key(n)] && states[key(n)].status !== "none") return;
      queued.current.add(n);
      timer.current ??= setTimeout(() => void flush(), 120);
    },
    retry: (n) => {
      void requestImages(deviceId, tool, sessionId, [n], true).then((res) => res.ok && merge(res.data.images));
    },
    open,
  };
}

const kind = (image: ImageRef) => image.type.replace("image/", "").toUpperCase();
const size = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);

/** What an image is, in a few words: where it came from, its kind and size. */
export const imageCaption = (image: ImageRef) => `${image.by === "user" ? "pasted" : "from a tool"} · ${kind(image)} · ${size(image.bytes)}`;

/** One image of the session: asked for once it is in view, then shown, and opened large on a click. `tile` fills a gallery square. */
export function SessionImage({ image, tile = false }: { image: ImageRef; tile?: boolean }) {
  const loader = useContext(ImageContext);
  const box = useRef<HTMLDivElement>(null);
  const tooLarge = image.bytes > MAX_IMAGE_BYTES;
  const state = loader?.state(image.n);

  useEffect(() => {
    const el = box.current;
    if (!loader || tooLarge || (state && state.status !== "none") || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        loader.want(image.n);
        io.disconnect();
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loader, image.n, tooLarge, state]);

  if (loader && state?.status === "ready") {
    return (
      <figure className="max-w-full">
        <button type="button" onClick={() => loader.open(image.n)} className="block max-w-full overflow-hidden rounded-lg border border-line bg-panel-2" title="Open it large">
          {/* eslint-disable-next-line @next/next/no-img-element -- a picture the server serves as it is, one by one */}
          <img src={loader.url(image.n)} alt={imageCaption(image)} loading="lazy" className={tile ? "aspect-square w-full object-cover" : "max-h-72 w-auto max-w-full object-contain"} />
        </button>
        {!tile && <figcaption className="mt-1 font-mono text-[10px] text-faint">{imageCaption(image)}</figcaption>}
      </figure>
    );
  }
  return (
    <div
      ref={box}
      className={`${tile ? "aspect-square w-full" : "h-28 w-full max-w-60"} flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line bg-panel-2 px-3 text-center text-[11px] text-faint`}
    >
      <Icon name={state?.status === "failed" || tooLarge ? "x" : "download"} size={14} className={state?.status === "pending" ? "animate-pulse" : ""} />
      {tooLarge ? (
        <span>{imageCaption(image)}: too large to show here</span>
      ) : state?.status === "failed" ? (
        <>
          <span>{state.error ?? "Could not get it."}</span>
          <button type="button" onClick={() => loader?.retry(image.n)} className="text-muted underline hover:text-fg">
            try again
          </button>
        </>
      ) : (
        <span>{loader ? `image · from ${loader.deviceName}…` : imageCaption(image)}</span>
      )}
    </div>
  );
}

/** All of the session's images, in the order they came. */
export function ImageGallery({ images }: { images: ImageRef[] }) {
  if (images.length === 0) return <p className="text-sm text-muted">No images in this conversation, as far as it was read.</p>;
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {images.map((image) => (
        <SessionImage key={image.n} image={image} tile />
      ))}
    </div>
  );
}

/** One image at a time, as large as the screen allows, with the ones before and after a key or a tap away. */
export function Lightbox({ images, n, onMove, onClose }: { images: ImageRef[]; n: number; onMove: (n: number) => void; onClose: () => void }) {
  const loader = useContext(ImageContext);
  const at = images.findIndex((i) => i.n === n);
  const image = images[at];
  const go = useCallback((step: number) => images[at + step] && onMove(images[at + step].n), [images, at, onMove]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else return;
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, onClose]);

  if (!image || !loader) return null;
  const ready = loader.state(n)?.status === "ready";
  return (
    <div role="dialog" aria-modal="true" aria-label="Image" className="fixed inset-0 z-[60] flex flex-col bg-black/90" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-[12px] text-white/80">
        <span className="font-mono">
          {at + 1} of {images.length} · {imageCaption(image)}
        </span>
        <span className="flex items-center gap-3">
          {ready && (
            <a href={loader.url(n)} target="_blank" rel="noreferrer" className="hover:text-white">
              open original
            </a>
          )}
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 hover:text-white">
            <Icon name="x" size={18} />
          </button>
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {ready ? (
          // eslint-disable-next-line @next/next/no-img-element -- a picture the server serves as it is
          <img src={loader.url(n)} alt={imageCaption(image)} className="max-h-full max-w-full object-contain" />
        ) : (
          <div className="w-64">
            <SessionImage image={image} />
          </div>
        )}
        {at > 0 && (
          <button type="button" onClick={() => go(-1)} aria-label="Previous image" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white hover:bg-white/20">
            <Icon name="chevron" size={16} className="rotate-90" />
          </button>
        )}
        {at < images.length - 1 && (
          <button type="button" onClick={() => go(1)} aria-label="Next image" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white hover:bg-white/20">
            <Icon name="chevron" size={16} className="-rotate-90" />
          </button>
        )}
      </div>
    </div>
  );
}
