import { useSyncExternalStore } from "react";

import { cachedAudioResourceUrl, cancelAudioResourcePreload } from "./resourcePreload";

interface AudioPlaybackState {
  assetId: string;
  playing: boolean;
  loading: boolean;
}

const listeners = new Set<() => void>();
let playbackState: AudioPlaybackState = { assetId: "", playing: false, loading: false };
let sharedAudio: HTMLAudioElement | null = null;
let sourceUrl = "";

function publish(next: AudioPlaybackState) {
  if (
    next.assetId === playbackState.assetId
    && next.playing === playbackState.playing
    && next.loading === playbackState.loading
  ) return;
  playbackState = next;
  for (const listener of listeners) listener();
}

function audioElement() {
  if (sharedAudio) return sharedAudio;
  const audio = new Audio();
  audio.preload = "auto";
  audio.addEventListener("loadstart", () => publish({ assetId: playbackState.assetId, playing: false, loading: true }));
  audio.addEventListener("waiting", () => publish({ assetId: playbackState.assetId, playing: false, loading: true }));
  audio.addEventListener("playing", () => publish({ assetId: playbackState.assetId, playing: true, loading: false }));
  audio.addEventListener("pause", () => publish({ assetId: playbackState.assetId, playing: false, loading: false }));
  audio.addEventListener("ended", () => publish({ assetId: playbackState.assetId, playing: false, loading: false }));
  audio.addEventListener("error", () => publish({ assetId: playbackState.assetId, playing: false, loading: false }));
  sharedAudio = audio;
  return audio;
}

export function getAudioPlaybackState() {
  return playbackState;
}

export function subscribeAudioPlayback(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAudioPlayback() {
  return useSyncExternalStore(subscribeAudioPlayback, getAudioPlaybackState, getAudioPlaybackState);
}

export function playAudioAsset(assetId: string, url: string) {
  const audio = audioElement();
  const cachedUrl = cachedAudioResourceUrl(url);
  const playableUrl = cachedUrl || url;
  if (!cachedUrl) cancelAudioResourcePreload(url);
  if (playbackState.assetId !== assetId || sourceUrl !== playableUrl) {
    audio.pause();
    sourceUrl = playableUrl;
    publish({ assetId, playing: false, loading: true });
    audio.src = playableUrl;
    audio.preload = "auto";
  }
  return audio.play().catch(() => {
    publish({ assetId, playing: false, loading: false });
  });
}

export function pauseAudioAsset(assetId?: string) {
  if (assetId && playbackState.assetId !== assetId) return;
  sharedAudio?.pause();
}

export function toggleAudioAsset(assetId: string, url: string) {
  const audio = audioElement();
  if (playbackState.assetId === assetId && (!audio.paused || playbackState.loading)) {
    audio.pause();
    return;
  }
  void playAudioAsset(assetId, url);
}
